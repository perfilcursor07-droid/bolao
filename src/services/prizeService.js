const pool = require('../config/database');

function parsePredictions(predictionData) {
  if (!predictionData) return [];
  const data = typeof predictionData === 'string' ? JSON.parse(predictionData) : predictionData;
  if (Array.isArray(data.placares)) {
    return data.placares.filter((p) => p.home !== undefined && p.away !== undefined);
  }
  if (data.home !== undefined && data.away !== undefined) {
    return [{ home: data.home, away: data.away }];
  }
  return [];
}

async function processGameResults(gameId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [games] = await connection.query('SELECT * FROM games WHERE id = ? AND status != ?', [gameId, 'finished']);
    if (games.length === 0) {
      await connection.rollback();
      return;
    }

    const game = games[0];
    if (game.home_score === null || game.away_score === null) {
      await connection.rollback();
      return;
    }

    const [winners] = await connection.query(
      `SELECT * FROM bets
       WHERE game_id = ?
         AND home_score_prediction = ?
         AND away_score_prediction = ?`,
      [gameId, game.home_score, game.away_score]
    );

    if (winners.length === 0) {
      await connection.query('UPDATE games SET status = ? WHERE id = ?', ['finished', gameId]);
      await connection.commit();
      return { winners: 0, prizeEach: 0 };
    }

    // Taxa de 15% do sistema
    const SYSTEM_FEE = 0.15;
    const netPool = Math.floor(game.prize_pool_cents * (1 - SYSTEM_FEE));
    const prizeEach = Math.floor(netPool / winners.length);

    for (const winner of winners) {
      await connection.query(
        'UPDATE bets SET is_winner = TRUE, prize_amount_cents = ? WHERE id = ?',
        [prizeEach, winner.id]
      );
    }

    await connection.query('UPDATE games SET status = ? WHERE id = ?', ['finished', gameId]);
    await connection.commit();

    return { winners: winners.length, prizeEach, totalPool: game.prize_pool_cents, netPool };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function insertBetsFromPayment(connection, payment, placares) {
  const [existingBets] = await connection.query('SELECT id FROM bets WHERE payment_id = ?', [payment.id]);
  if (existingBets.length > 0 || placares.length === 0) return;

  for (const p of placares) {
    await connection.query(
      `INSERT INTO bets (user_id, game_id, payment_id, home_score_prediction, away_score_prediction)
       VALUES (?, ?, ?, ?, ?)`,
      [payment.user_id, payment.game_id, payment.id, p.home, p.away]
    );
  }
}

async function confirmPayment(paymentId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [payments] = await connection.query('SELECT * FROM payments WHERE id = ?', [paymentId]);
    if (payments.length === 0) {
      await connection.rollback();
      return false;
    }

    const payment = payments[0];
    const placares = parsePredictions(payment.prediction_data);

    if (payment.status === 'paid') {
      await insertBetsFromPayment(connection, payment, placares);
      await connection.commit();
      return true;
    }

    await connection.query('UPDATE payments SET status = ?, paid_at = NOW() WHERE id = ?', ['paid', paymentId]);

    await connection.query(
      'UPDATE games SET prize_pool_cents = prize_pool_cents + ? WHERE id = ?',
      [payment.amount_cents, payment.game_id]
    );

    await insertBetsFromPayment(connection, payment, placares);

    await connection.commit();
    return { paid: true, gameId: payment.game_id };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function cancelStalePendingPayments(userId, gameId) {
  await pool.query(
    `UPDATE payments SET status = 'cancelled'
     WHERE user_id = ? AND game_id = ? AND status = 'pending'
       AND (qr_code_text IS NULL OR qr_code_text = '')`,
    [userId, gameId]
  );
}

async function createPaymentWithPlacar(userId, gameId, placares) {
  if (!placares || placares.length === 0) {
    return { error: 'no_placares' };
  }

  // Cancelar pagamentos sem QR code (falhos)
  await cancelStalePendingPayments(userId, gameId);

  // Permitir nova aposta mesmo com pendente - não bloquear mais

  const [games] = await pool.query('SELECT * FROM games WHERE id = ? AND status = ?', [gameId, 'open']);
  if (games.length === 0) return { error: 'game_closed' };

  const game = games[0];
  const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
  const user = users[0];

  const totalCents = game.entry_fee_cents * placares.length;
  const predictionJson = JSON.stringify({ placares });
  const placarText = placares.map((p) => `${p.home}x${p.away}`).join(', ');
  const referenceId = `BOL_${gameId}_${userId}_${Date.now()}`;
  const { createPixOrder, buildPagBankCustomer } = require('./pagbank');

  const order = await createPixOrder({
    referenceId,
    customer: buildPagBankCustomer(user),
    amountCents: totalCents,
    description: `Bolão: ${game.title} (${placares.length} aposta${placares.length > 1 ? 's' : ''}: ${placarText})`,
  });

  const qrCode = order.qr_codes?.[0];
  const qrText = qrCode?.text || null;

  if (!qrText) {
    console.error('[createPaymentWithPlacar] QR Code text VAZIO! order.qr_codes:', JSON.stringify(order.qr_codes));
  } else {
    console.log('[createPaymentWithPlacar] QR Code gerado com sucesso, tamanho:', qrText.length);
  }

  const [result] = await pool.query(
    `INSERT INTO payments (user_id, game_id, reference_id, pagbank_order_id, amount_cents, qr_code_text, prediction_data, qr_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      gameId,
      referenceId,
      order.id,
      totalCents,
      qrText,
      predictionJson,
      qrCode?.expiration_date || null,
    ]
  );

  return { paymentId: result.insertId, totalCents, count: placares.length };
}

async function getUserGameStatus(userId, gameId) {
  const [bets] = await pool.query(
    'SELECT * FROM bets WHERE user_id = ? AND game_id = ? ORDER BY created_at DESC',
    [userId, gameId]
  );

  const [pending] = await pool.query(
    `SELECT * FROM payments WHERE user_id = ? AND game_id = ? AND status = 'pending' ORDER BY created_at DESC`,
    [userId, gameId]
  );

  const pendingPayments = pending.filter(p => p.qr_code_text);

  // Sempre permitir nova aposta - mostrar pendentes como informação
  return { step: 'placar', bets, pendingPayments, pendingPayment: pendingPayments[0] || null, placares: [] };
}

module.exports = {
  processGameResults,
  confirmPayment,
  createPaymentWithPlacar,
  getUserGameStatus,
  parsePredictions,
};
