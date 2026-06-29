const pool = require('../config/database');
const { isBettingOpen } = require('./bettingRules');

/** Pagamento só é válido enquanto o bolão aceita novas apostas. */
function canAcceptPaymentForGame(game) {
  if (!game) return false;
  return isBettingOpen(game);
}

async function expirePendingPaymentsForGame(gameId, executor = pool) {
  const [result] = await executor.query(
    `UPDATE payments SET status = 'expired'
     WHERE game_id = ? AND status = 'pending'`,
    [gameId]
  );
  return result.affectedRows || 0;
}

/**
 * Expira PIX pendentes de jogos que já não aceitam aposta
 * (bolão fechado, jogo iniciado ou passou do prazo de 5 min antes).
 */
async function expirePendingPaymentsForClosedBetting() {
  const [rows] = await pool.query(
    `SELECT p.id AS payment_id, g.id, g.status, g.game_date
     FROM payments p
     JOIN games g ON g.id = p.game_id
     WHERE p.status = 'pending'`
  );

  let expired = 0;
  for (const row of rows) {
    const game = { id: row.id, status: row.status, game_date: row.game_date };
    if (!canAcceptPaymentForGame(game)) {
      const [result] = await pool.query(
        `UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'pending'`,
        [row.payment_id]
      );
      expired += result.affectedRows || 0;
    }
  }
  return expired;
}

async function assertPaymentCanBeConfirmed(payment, game, connection) {
  if (canAcceptPaymentForGame(game)) {
    return { ok: true };
  }

  await connection.query(
    `UPDATE payments SET status = 'declined' WHERE id = ? AND status = 'pending'`,
    [payment.id]
  );

  return { ok: false, reason: 'betting_closed' };
}

module.exports = {
  canAcceptPaymentForGame,
  expirePendingPaymentsForGame,
  expirePendingPaymentsForClosedBetting,
  assertPaymentCanBeConfirmed,
};
