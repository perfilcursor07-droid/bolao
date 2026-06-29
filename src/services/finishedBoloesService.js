const pool = require('../config/database');
const { calcPrizeBreakdown } = require('./prizeService');
const { loadMarketingBetsForGames, gameBetCountSubquery, marketingPoolSubquery, enrichGameForDisplay } = require('./marketingBetService');
const { shortName } = require('../utils/displayName');

const BET_PUBLIC_SELECT = `
  b.game_id, b.home_score_prediction, b.away_score_prediction,
  b.is_winner, b.prize_amount_cents, u.name,
  COALESCE(p.paid_at, b.created_at) AS paid_at
`;

function mapPublicBet(row) {
  return {
    game_id: row.game_id,
    home_score_prediction: row.home_score_prediction,
    away_score_prediction: row.away_score_prediction,
    is_winner: row.is_winner,
    prize_amount_cents: row.prize_amount_cents,
    name: shortName(row.name),
    paid_at: row.paid_at || null,
  };
}

async function loadFinishedBoloes({ includeAllBets = false } = {}) {
  const [gameRows] = await pool.query(
    `SELECT g.*,
      ${gameBetCountSubquery('g')} as total_bets,
      ${marketingPoolSubquery('g')} as marketing_pool_cents
     FROM games g
     WHERE g.status = 'finished'
       AND (
         EXISTS (SELECT 1 FROM bets b WHERE b.game_id = g.id)
         OR EXISTS (SELECT 1 FROM marketing_bets mb WHERE mb.game_id = g.id)
       )
     ORDER BY g.game_date DESC`
  );
  const games = gameRows.map(enrichGameForDisplay);

  if (games.length === 0) return [];

  const finishedIds = games.map((g) => g.id);

  const [allWinners] = await pool.query(
    `SELECT ${BET_PUBLIC_SELECT}
     FROM bets b
     JOIN users u ON u.id = b.user_id
     LEFT JOIN payments p ON p.id = b.payment_id
     WHERE b.game_id IN (?) AND b.is_winner = TRUE
     ORDER BY paid_at ASC, u.name ASC`,
    [finishedIds]
  );

  const winnersByGame = {};
  for (const w of allWinners) {
    if (!winnersByGame[w.game_id]) winnersByGame[w.game_id] = [];
    winnersByGame[w.game_id].push({
      ...w,
      name: shortName(w.name),
    });
  }

  let betsByGame = {};
  if (includeAllBets) {
    const [allBets] = await pool.query(
      `SELECT ${BET_PUBLIC_SELECT}
       FROM bets b
       JOIN users u ON u.id = b.user_id
       LEFT JOIN payments p ON p.id = b.payment_id
       WHERE b.game_id IN (?)
       ORDER BY paid_at ASC, u.name ASC`,
      [finishedIds]
    );
    for (const bet of allBets) {
      if (!betsByGame[bet.game_id]) betsByGame[bet.game_id] = [];
      betsByGame[bet.game_id].push(mapPublicBet(bet));
    }
  }

  return games.map((game) => {
    const winners = winnersByGame[game.id] || [];
    return {
      game,
      winners,
      bets: betsByGame[game.id] || [],
      breakdown: calcPrizeBreakdown(game.display_prize_pool_cents ?? game.prize_pool_cents, winners.length),
    };
  });
}

/** Apostas + breakdown para jogos com bolão fechado (ainda sem resultado). */
async function loadBetsForGames(games) {
  if (!games.length) return {};

  const gameIds = games.map((g) => g.id);
  const [rows] = await pool.query(
    `SELECT ${BET_PUBLIC_SELECT}, b.created_at
     FROM bets b
     JOIN users u ON u.id = b.user_id
     LEFT JOIN payments p ON p.id = b.payment_id
     WHERE b.game_id IN (?)
     ORDER BY b.game_id, paid_at ASC`,
    [gameIds]
  );

  const marketingByGame = await loadMarketingBetsForGames(gameIds);

  const betsByGame = {};
  for (const row of rows) {
    if (!betsByGame[row.game_id]) betsByGame[row.game_id] = [];
    betsByGame[row.game_id].push({
      ...mapPublicBet(row),
      sort_at: row.paid_at || row.created_at,
    });
  }
  for (const [gid, marketingBets] of Object.entries(marketingByGame)) {
    const gameId = parseInt(gid, 10);
    if (!betsByGame[gameId]) betsByGame[gameId] = [];
    for (const bet of marketingBets) {
      betsByGame[gameId].push({
        ...bet,
        name: shortName(bet.name),
        paid_at: bet.created_at || null,
        sort_at: bet.created_at || new Date(0),
      });
    }
  }

  const result = {};
  for (const game of games) {
    const enriched = enrichGameForDisplay(game);
    const bets = (betsByGame[game.id] || [])
      .sort((a, b) => new Date(a.sort_at) - new Date(b.sort_at))
      .map(({ sort_at, ...bet }) => bet);
    result[game.id] = {
      bets,
      breakdown: calcPrizeBreakdown(enriched.display_prize_pool_cents, 0),
    };
  }
  return result;
}

module.exports = { loadFinishedBoloes, loadBetsForGames };
