const pool = require('../config/database');
const { calcPrizeBreakdown } = require('./prizeService');
const { loadMarketingBetsForGames, gameBetCountSubquery, marketingPoolSubquery, enrichGameForDisplay } = require('./marketingBetService');

function firstName(name) {
  if (!name || !String(name).trim()) return 'Participante';
  return String(name).trim().split(/\s+/)[0];
}

function mapPublicBet(row) {
  return {
    game_id: row.game_id,
    home_score_prediction: row.home_score_prediction,
    away_score_prediction: row.away_score_prediction,
    is_winner: row.is_winner,
    prize_amount_cents: row.prize_amount_cents,
    name: firstName(row.name),
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
    `SELECT b.game_id, b.home_score_prediction, b.away_score_prediction,
            b.prize_amount_cents, u.name
     FROM bets b JOIN users u ON u.id = b.user_id
     WHERE b.game_id IN (?) AND b.is_winner = TRUE
     ORDER BY b.prize_amount_cents DESC, u.name ASC`,
    [finishedIds]
  );

  const winnersByGame = {};
  for (const w of allWinners) {
    if (!winnersByGame[w.game_id]) winnersByGame[w.game_id] = [];
    winnersByGame[w.game_id].push(w);
  }

  let betsByGame = {};
  if (includeAllBets) {
    const [allBets] = await pool.query(
      `SELECT b.game_id, b.home_score_prediction, b.away_score_prediction,
              b.is_winner, b.prize_amount_cents, u.name
       FROM bets b JOIN users u ON u.id = b.user_id
       WHERE b.game_id IN (?)
       ORDER BY b.is_winner DESC, u.name ASC`,
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
    `SELECT b.game_id, b.home_score_prediction, b.away_score_prediction, u.name, b.created_at
     FROM bets b JOIN users u ON u.id = b.user_id
     WHERE b.game_id IN (?)
     ORDER BY b.game_id, b.created_at ASC`,
    [gameIds]
  );

  const marketingByGame = await loadMarketingBetsForGames(gameIds);

  const betsByGame = {};
  for (const row of rows) {
    if (!betsByGame[row.game_id]) betsByGame[row.game_id] = [];
    betsByGame[row.game_id].push({
      ...mapPublicBet(row),
      sort_at: row.created_at,
    });
  }
  for (const [gid, marketingBets] of Object.entries(marketingByGame)) {
    const gameId = parseInt(gid, 10);
    if (!betsByGame[gameId]) betsByGame[gameId] = [];
    for (const bet of marketingBets) {
      betsByGame[gameId].push({ ...bet, sort_at: bet.created_at || new Date(0) });
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
