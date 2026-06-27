const pool = require('../config/database');
const { loadFinishedBoloes, loadBetsForGames } = require('./finishedBoloesService');
const { getUserGameStatus } = require('./prizeService');
const { closeExpiredOpenGames, finalizeClosedGamesWithScores, syncGamesFromWorldCupMatches } = require('./gameStatusService');
const { isBettingOpen } = require('./bettingRules');

let lastHomeApiSync = 0;
const HOME_API_SYNC_MS = 3 * 60 * 1000;

async function loadHomeData(userId, { withApiSync = false } = {}) {
  await closeExpiredOpenGames();
  await finalizeClosedGamesWithScores();

  if (withApiSync) {
    const now = Date.now();
    if (now - lastHomeApiSync >= HOME_API_SYNC_MS) {
      lastHomeApiSync = now;
      try {
        await syncGamesFromWorldCupMatches();
      } catch (err) {
        console.error('[home] sync API:', err.message);
      }
    }
  }

  const [games] = await pool.query(
    `SELECT g.*,
      (SELECT COUNT(*) FROM bets b WHERE b.game_id = g.id) as total_bets
     FROM games g
     WHERE g.status IN ('open', 'closed', 'finished')
     ORDER BY
       g.featured DESC,
       CASE g.status WHEN 'open' THEN 0 WHEN 'closed' THEN 1 ELSE 2 END,
       g.game_date ASC`
  );

  const openGames = games.filter((g) => g.status === 'open');
  const liveGames = games.filter((g) => g.status === 'closed');
  const featuredGames = openGames.filter((g) => g.featured);
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
  };
}

module.exports = { loadHomeData };
