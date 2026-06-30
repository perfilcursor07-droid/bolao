const pool = require('../config/database');
const { loadFinishedBoloes, loadBetsForGames } = require('./finishedBoloesService');
const { getUserGameStatus } = require('./prizeService');
const { closeExpiredOpenGames, finalizeClosedGamesWithScores, syncGamesFromWorldCupMatches, syncLiveGameScores, liveGamesSqlWhere } = require('./gameStatusService');
const { isBettingOpen } = require('./bettingRules');
const { gameBetCountSubquery, marketingPoolSubquery, enrichGamesForDisplay } = require('./marketingBetService');
const { dedupeGamesForDisplay } = require('./gameDuplicateService');

let lastHomeApiSync = 0;
let lastHomeLiveSync = 0;
const HOME_API_SYNC_MS = 3 * 60 * 1000;
const HOME_LIVE_SYNC_MS = 15 * 1000;

async function loadHomeData(userId, { withApiSync = false } = {}) {
  await closeExpiredOpenGames();
  await finalizeClosedGamesWithScores();

  if (withApiSync) {
    const now = Date.now();
    try {
      const [liveRows] = await pool.query(
        `SELECT COUNT(*) AS c FROM games WHERE ${liveGamesSqlWhere()}`
      );
      const hasActiveLive = liveRows[0].c > 0;

      if (hasActiveLive && now - lastHomeLiveSync >= HOME_LIVE_SYNC_MS) {
        lastHomeLiveSync = now;
        await syncLiveGameScores({ forceRefresh: true });
      } else if (!hasActiveLive && now - lastHomeApiSync >= HOME_API_SYNC_MS) {
        lastHomeApiSync = now;
        await syncGamesFromWorldCupMatches();
      }
    } catch (err) {
      console.error('[home] sync API:', err.message);
    }
  }

  const [gameRows] = await pool.query(
    `SELECT g.*,
      ${gameBetCountSubquery('g')} as total_bets,
      ${marketingPoolSubquery('g')} as marketing_pool_cents
     FROM games g
     WHERE g.status IN ('open', 'closed', 'finished')
     ORDER BY
       g.featured DESC,
       CASE g.status WHEN 'open' THEN 0 WHEN 'closed' THEN 1 ELSE 2 END,
       g.game_date ASC`
  );
  const games = enrichGamesForDisplay(gameRows);

  const openGamesRaw = games.filter((g) => g.status === 'open');
  const liveGamesRaw = games.filter((g) => g.status === 'closed');
  const openGames = dedupeGamesForDisplay(openGamesRaw);
  const liveGames = dedupeGamesForDisplay(liveGamesRaw);
  const featuredGames = dedupeGamesForDisplay(openGames.filter((g) => g.featured));
  const normalGames = openGames.filter((g) => !g.featured);

  const nowTs = Date.now();
  const in24h = nowTs + 24 * 60 * 60 * 1000;
  const upcomingGames = normalGames.filter((g) => {
    const t = new Date(g.game_date).getTime();
    return t > nowTs && t <= in24h;
  });
  const otherOpenGames = normalGames.filter((g) => {
    const t = new Date(g.game_date).getTime();
    return t > in24h;
  });

  const allFinishedSummaries = await loadFinishedBoloes();
  const finishedSummaries = allFinishedSummaries.slice(0, 5);
  const hasMoreFinished = allFinishedSummaries.length > 5;

  const closedBettingGames = [...featuredGames, ...upcomingGames, ...otherOpenGames].filter((g) => !isBettingOpen(g));
  const closedBettingMap = await loadBetsForGames(closedBettingGames);
  const featuredBetsMap = featuredGames.length > 0 ? await loadBetsForGames(featuredGames) : {};

  let myBets = [];
  const gameStatusMap = {};

  if (userId) {
    const [bets] = await pool.query(
      `SELECT b.*, g.title, g.home_team, g.away_team, g.home_score, g.away_score, g.status as game_status
       FROM bets b JOIN games g ON g.id = b.game_id
       WHERE b.user_id = ? ORDER BY b.created_at DESC`,
      [userId]
    );
    myBets = bets;

    for (const game of openGames) {
      gameStatusMap[game.id] = await getUserGameStatus(userId, game.id);
    }
  }

  const [[paidRow]] = await pool.query(
    `SELECT COALESCE(SUM(prize_amount_cents), 0) AS total_cents,
            COUNT(*) AS winners
     FROM bets WHERE prize_paid_at IS NOT NULL AND prize_amount_cents > 0`
  );
  const activePoolCents = openGames.reduce(
    (sum, g) => sum + (g.display_prize_pool_cents ?? g.prize_pool_cents ?? 0),
    0
  );
  const heroStats = {
    paidPrizesCents: parseInt(paidRow?.total_cents, 10) || 0,
    paidWinners: parseInt(paidRow?.winners, 10) || 0,
    activePoolCents,
    openGamesCount: openGames.length,
    totalBets: games.reduce((sum, g) => sum + (parseInt(g.total_bets, 10) || 0), 0),
  };

  return {
    upcomingGames,
    otherOpenGames,
    openGames: normalGames,
    liveGames,
    featuredGames,
    finishedSummaries,
    hasMoreFinished,
    totalFinishedCount: allFinishedSummaries.length,
    myBets,
    gameStatusMap,
    closedBettingMap,
    featuredBetsMap,
    hasLiveGames: liveGames.length > 0,
    heroStats,
  };
}

module.exports = { loadHomeData };
