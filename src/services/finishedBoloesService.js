const pool = require('../config/database');
const { calcPrizeBreakdown } = require('./prizeService');

async function loadFinishedBoloes({ includeAllBets = false } = {}) {
  const [games] = await pool.query(
    `SELECT g.*,
      (SELECT COUNT(*) FROM bets b WHERE b.game_id = g.id) as total_bets
     FROM games g
     WHERE g.status = 'finished'
       AND EXISTS (SELECT 1 FROM bets b WHERE b.game_id = g.id)
     ORDER BY g.game_date DESC`
  );

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
      betsByGame[bet.game_id].push(bet);
    }
  }

  return games.map((game) => {
    const winners = winnersByGame[game.id] || [];
    return {
      game,
      winners,
      bets: betsByGame[game.id] || [],
      breakdown: calcPrizeBreakdown(game.prize_pool_cents, winners.length),
    };
  });
}

module.exports = { loadFinishedBoloes };
