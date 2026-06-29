const pool = require('../config/database');

/**
 * Alteração de placar de aposta real — somente administrador (/admin/apostas).
 * Usuários não possuem rota nem serviço para editar palpites após confirmar/pagar.
 */
async function updateBetPredictionAsAdmin(betId, home, away) {
  if (!Number.isFinite(betId) || !Number.isFinite(home) || !Number.isFinite(away)) {
    return { ok: false, error: 'Placar inválido' };
  }
  if (home < 0 || away < 0 || home > 20 || away > 20) {
    return { ok: false, error: 'Use placares entre 0 e 20' };
  }

  const [rows] = await pool.query(
    `SELECT b.id, b.game_id, g.status AS game_status
     FROM bets b JOIN games g ON g.id = b.game_id WHERE b.id = ?`,
    [betId]
  );
  if (rows.length === 0) {
    return { ok: false, error: 'Aposta não encontrada' };
  }

  const bet = rows[0];
  if (bet.game_status === 'finished') {
    return { ok: false, error: 'Não é possível editar palpite de jogo finalizado' };
  }

  await pool.query(
    'UPDATE bets SET home_score_prediction = ?, away_score_prediction = ? WHERE id = ?',
    [home, away, betId]
  );

  return { ok: true, gameId: bet.game_id };
}

module.exports = { updateBetPredictionAsAdmin };
