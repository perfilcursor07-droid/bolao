const pool = require('../config/database');
const { getMatchResult } = require('./footballApi');
const { processGameResults } = require('./prizeService');

async function closeExpiredOpenGames() {
  const [result] = await pool.query(
    `UPDATE games SET status = 'closed'
     WHERE status = 'open' AND game_date <= NOW()`
  );
  return result.affectedRows || 0;
}

async function syncGamesFromApi({ nearOnly = false } = {}) {
  const timeFilter = nearOnly
    ? `AND game_date BETWEEN DATE_SUB(NOW(), INTERVAL 6 HOUR) AND DATE_ADD(NOW(), INTERVAL 3 HOUR)`
    : '';

  const [games] = await pool.query(
    `SELECT * FROM games
     WHERE status IN ('open', 'closed')
       AND api_match_id IS NOT NULL
       ${timeFilter}`
  );

  for (const game of games) {
    try {
      const result = await getMatchResult(game.api_match_id);
      if (!result) continue;

      if (result.live) {
        await pool.query(
          `UPDATE games SET status = 'closed', home_score = ?, away_score = ? WHERE id = ?`,
          [
            result.homeScore ?? game.home_score ?? 0,
            result.awayScore ?? game.away_score ?? 0,
            game.id,
          ]
        );
        continue;
      }

      if (result.finished) {
        await pool.query(
          `UPDATE games SET home_score = ?, away_score = ?, status = 'closed' WHERE id = ?`,
          [result.homeScore, result.awayScore, game.id]
        );
        await processGameResults(game.id);
      }
    } catch (err) {
      console.error(`[syncGames] jogo ${game.id}:`, err.message);
    }
  }
}

function isBettingOpen(game) {
  return Boolean(game && game.status === 'open');
}

function isLiveGame(game) {
  return Boolean(game && game.status === 'closed');
}

module.exports = {
  closeExpiredOpenGames,
  syncGamesFromApi,
  isBettingOpen,
  isLiveGame,
};
