const pool = require('../config/database');
const { getMatchResult, getWorldCupMatches } = require('./footballApi');
const { processGameResults } = require('./prizeService');
const {
  BETTING_CLOSE_MINUTES,
  parseGameDate,
  hasGameStarted,
  getBettingDeadline,
  isBettingOpen,
} = require('./bettingRules');
const { expirePendingPaymentsForGame } = require('./paymentGateService');

/** Tempo após o apito inicial para considerar o jogo encerrado (90min + intervalo + acréscimos). */
const MATCH_END_MINUTES = 120;

function getMatchEndTime(game) {
  const kickoff = parseGameDate(game);
  if (!kickoff) return null;
  return new Date(kickoff.getTime() + MATCH_END_MINUTES * 60 * 1000);
}

function shouldAutoFinalize(game) {
  if (!game || game.status !== 'closed') return false;
  if (game.home_score === null || game.away_score === null) return false;
  const endTime = getMatchEndTime(game);
  return Boolean(endTime && Date.now() >= endTime.getTime());
}

async function closeExpiredOpenGames() {
  const [closing] = await pool.query(
    `SELECT id FROM games WHERE status = 'open' AND game_date <= NOW()`
  );

  const [result] = await pool.query(
    `UPDATE games SET status = 'closed'
     WHERE status = 'open' AND game_date <= NOW()`
  );

  for (const game of closing) {
    const expired = await expirePendingPaymentsForGame(game.id);
    if (expired > 0) {
      console.log(`[gameStatus] ${expired} PIX pendente(s) expirado(s) — jogo ${game.id} iniciou`);
    }
  }

  return result.affectedRows || 0;
}

/**
 * Finaliza jogos closed que já têm placar e passaram do tempo de partida.
 * Não depende da API — resolve jogos presos em "AO VIVO".
 */
async function finalizeClosedGamesWithScores() {
  const [games] = await pool.query(
    `SELECT * FROM games
     WHERE status = 'closed'
       AND home_score IS NOT NULL
       AND away_score IS NOT NULL
       AND game_date <= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [MATCH_END_MINUTES]
  );

  let finalized = 0;
  for (const game of games) {
    if (!shouldAutoFinalize(game)) continue;
    try {
      const result = await processGameResults(game.id);
      finalized++;
      const winners = result?.winners ?? 0;
      console.log(
        `🏆 Jogo ${game.id} finalizado (${game.home_team} ${game.home_score}×${game.away_score} ${game.away_team}). Ganhadores: ${winners}`
      );
    } catch (err) {
      console.error(`[finalize] jogo ${game.id}:`, err.message);
    }
  }
  return finalized;
}

function isApiMatchFinished(status) {
  return ['FINISHED', 'AWARDED'].includes(status);
}

function isApiMatchLive(status) {
  return ['IN_PLAY', 'PAUSED', 'LIVE'].includes(status);
}

/**
 * Sincroniza bolões locais com a lista completa da Copa (1 chamada à API).
 * Atualiza placares, status ao vivo e finaliza ganhadores.
 */
async function syncGamesFromWorldCupMatches(options = {}) {
  const { matches, error } = await getWorldCupMatches({ forceRefresh: options.forceRefresh === true });
  if (!matches?.length) {
    if (error) console.warn('[syncWC]', error);
    return 0;
  }

  const byApiId = new Map(matches.map((m) => [String(m.id), m]));

  const [games] = await pool.query(
    `SELECT * FROM games
     WHERE api_match_id IS NOT NULL
       AND status IN ('open', 'closed')
       AND game_date >= DATE_SUB(NOW(), INTERVAL 72 HOUR)`
  );

  let synced = 0;
  for (const game of games) {
    const apiMatch = byApiId.get(String(game.api_match_id));
    if (!apiMatch) continue;

    const homeScore = apiMatch.homeScore;
    const awayScore = apiMatch.awayScore;
    const finished = isApiMatchFinished(apiMatch.status);
    const live = isApiMatchLive(apiMatch.status);

    if (game.status === 'open' && (live || finished) && parseGameDate(game) <= new Date()) {
      await pool.query(`UPDATE games SET status = 'closed' WHERE id = ?`, [game.id]);
      game.status = 'closed';
      const expired = await expirePendingPaymentsForGame(game.id);
      if (expired > 0) {
        console.log(`[syncWC] ${expired} PIX pendente(s) expirado(s) — jogo ${game.id}`);
      }
    }

    if (homeScore === null || awayScore === null) {
      if (!live && !finished) continue;
    }

    if (homeScore !== null && awayScore !== null) {
      await pool.query(
        `UPDATE games SET home_score = ?, away_score = ? WHERE id = ?`,
        [homeScore, awayScore, game.id]
      );
      game.home_score = homeScore;
      game.away_score = awayScore;
    }

    const updated = { ...game, home_score: homeScore ?? game.home_score, away_score: awayScore ?? game.away_score };

    if (finished || shouldAutoFinalize(updated)) {
      try {
        const result = await processGameResults(game.id);
        const winners = result?.winners ?? 0;
        console.log(
          `🏆 Jogo ${game.id} finalizado via Copa API (${updated.home_score}×${updated.away_score}). Ganhadores: ${winners}`
        );
      } catch (err) {
        console.error(`[syncWC] jogo ${game.id}:`, err.message);
      }
    }

    synced++;
  }

  return synced;
}

/**
 * Sincroniza placares via API para jogos closed (fallback individual).
 */
async function syncGamesFromApi({ maxGames = 2 } = {}) {
  const [games] = await pool.query(
    `SELECT * FROM games
     WHERE status = 'closed'
       AND api_match_id IS NOT NULL
       AND game_date >= DATE_SUB(NOW(), INTERVAL 48 HOUR)
       AND game_date <= DATE_ADD(NOW(), INTERVAL 130 MINUTE)
     ORDER BY
       CASE WHEN home_score IS NULL OR away_score IS NULL THEN 0 ELSE 1 END,
       game_date ASC
     LIMIT ?`,
    [maxGames]
  );

  if (games.length === 0) return 0;

  let synced = 0;
  for (const game of games) {
    try {
      const result = await getMatchResult(game.api_match_id);
      const { updated } = await updateGameFromApiResult(game, result);
      if (updated) synced++;
    } catch (err) {
      console.error(`[syncGames] jogo ${game.id}:`, err.message);
    }
  }

  return synced;
}

function isLiveGame(game) {
  return Boolean(game && game.status === 'closed');
}

const LIVE_GAME_WINDOW_MINUTES = 130;

function liveGamesSqlWhere(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `${p}status = 'closed'
       AND ${p}api_match_id IS NOT NULL
       AND ${p}game_date <= NOW()
       AND ${p}game_date >= DATE_SUB(NOW(), INTERVAL ${LIVE_GAME_WINDOW_MINUTES} MINUTE)`;
}

async function updateGameFromApiResult(game, result) {
  if (!result || (!result.live && !result.finished)) {
    return { updated: false, finalized: false };
  }

  const homeScore = result.homeScore ?? game.home_score;
  const awayScore = result.awayScore ?? game.away_score;
  if (homeScore === null || awayScore === null) {
    return { updated: false, finalized: false };
  }

  const changed = game.home_score !== homeScore || game.away_score !== awayScore;
  if (changed) {
    await pool.query(`UPDATE games SET home_score = ?, away_score = ? WHERE id = ?`, [
      homeScore,
      awayScore,
      game.id,
    ]);
  }

  const updated = { ...game, home_score: homeScore, away_score: awayScore };
  let finalized = false;
  if (result.finished || shouldAutoFinalize(updated)) {
    await processGameResults(game.id);
    finalized = true;
    console.log(`🏆 Jogo ${game.id} finalizado via API (${homeScore}×${awayScore}). Status: ${result.status}`);
  }

  return { updated: changed || finalized, finalized };
}

/**
 * Sincroniza placares de jogos ao vivo (1 chamada por partida, mais rápido que lista da Copa).
 */
async function syncLiveGameScores(options = {}) {
  const [games] = await pool.query(`SELECT * FROM games WHERE ${liveGamesSqlWhere()}`);
  if (games.length === 0) return 0;

  let synced = 0;
  for (const game of games) {
    try {
      const result = await getMatchResult(game.api_match_id, {
        forceRefresh: options.forceRefresh === true,
      });
      const { updated } = await updateGameFromApiResult(game, result);
      if (updated) synced++;
    } catch (err) {
      console.error(`[syncLive] jogo ${game.id}:`, err.message);
    }
  }

  return synced;
}

module.exports = {
  BETTING_CLOSE_MINUTES,
  MATCH_END_MINUTES,
  closeExpiredOpenGames,
  finalizeClosedGamesWithScores,
  syncGamesFromWorldCupMatches,
  syncGamesFromApi,
  syncLiveGameScores,
  isBettingOpen,
  getBettingDeadline,
  hasGameStarted,
  shouldAutoFinalize,
  isLiveGame,
  LIVE_GAME_WINDOW_MINUTES,
};
