const pool = require('../config/database');
const { getMatchResult } = require('./footballApi');
const { processGameResults } = require('./prizeService');

const BETTING_CLOSE_MINUTES = 30;

function parseGameDate(game) {
  if (!game || !game.game_date) return null;
  const d = game.game_date;
  if (d instanceof Date) return d;
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Horário limite para apostar/editar (30 min antes do jogo). */
function getBettingDeadline(game) {
  const kickoff = parseGameDate(game);
  if (!kickoff) return null;
  return new Date(kickoff.getTime() - BETTING_CLOSE_MINUTES * 60 * 1000);
}

function isBettingOpen(game) {
  if (!game || game.status !== 'open') return false;
  const deadline = getBettingDeadline(game);
  if (!deadline) return false;
  return Date.now() < deadline.getTime();
}

async function closeExpiredOpenGames() {
  const [result] = await pool.query(
    `UPDATE games SET status = 'closed'
     WHERE status = 'open' AND game_date <= NOW()`
  );
  return result.affectedRows || 0;
}

/**
 * Sincroniza placares via API apenas para jogos já encerrados para apostas (closed),
 * dentro da janela de tempo, com limite por execução para respeitar rate limit (10 req/min).
 */
async function syncGamesFromApi({ nearOnly = true, maxGames = 4 } = {}) {
  const timeFilter = nearOnly
    ? `AND game_date BETWEEN DATE_SUB(NOW(), INTERVAL 3 HOUR) AND DATE_ADD(NOW(), INTERVAL 2 HOUR)`
    : `AND game_date <= DATE_ADD(NOW(), INTERVAL 2 HOUR)`;

  const [games] = await pool.query(
    `SELECT * FROM games
     WHERE status = 'closed'
       AND api_match_id IS NOT NULL
       ${timeFilter}
     ORDER BY game_date ASC
     LIMIT ?`,
    [maxGames]
  );

  if (games.length === 0) return 0;

  let synced = 0;
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
        synced++;
        continue;
      }

      if (result.finished) {
        await pool.query(
          `UPDATE games SET home_score = ?, away_score = ?, status = 'closed' WHERE id = ?`,
          [result.homeScore, result.awayScore, game.id]
        );
        await processGameResults(game.id);
        synced++;
      }
    } catch (err) {
      console.error(`[syncGames] jogo ${game.id}:`, err.message);
    }
  }

  return synced;
}

function isLiveGame(game) {
  return Boolean(game && game.status === 'closed');
}

module.exports = {
  BETTING_CLOSE_MINUTES,
  closeExpiredOpenGames,
  syncGamesFromApi,
  isBettingOpen,
  getBettingDeadline,
  isLiveGame,
};
