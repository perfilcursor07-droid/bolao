const pool = require('../config/database');
const { isBettingOpen } = require('./bettingRules');
const {
  expirePendingPaymentsForGame,
  expirePendingPaymentsForClosedBetting,
  assertPaymentCanBeConfirmed,
  canAcceptPaymentForGame,
} = require('./paymentGateService');
const { processAffiliateCommissionOnPayment } = require('./affiliateService');

const SYSTEM_FEE_RATE = 0.10;
const NO_WINNER_FEE_RATE = 0.20;

function calcPrizeBreakdown(prizePoolCents, winnerCount) {
  const totalPool = prizePoolCents || 0;
  const feeCents = Math.floor(totalPool * SYSTEM_FEE_RATE);
  const netPool = Math.floor(totalPool * (1 - SYSTEM_FEE_RATE));
  const prizeEach = winnerCount > 0 ? Math.floor(netPool / winnerCount) : 0;
  return {
    totalPool,
    feeCents,
    netPool,
    prizeEach,
    feePercent: Math.round(SYSTEM_FEE_RATE * 100),
    netPercent: Math.round((1 - SYSTEM_FEE_RATE) * 100),
    winnerCount,
  };
}

function calcNoWinnerRefundCents(stakeCents) {
  return Math.floor((stakeCents || 0) * (1 - NO_WINNER_FEE_RATE));
}

function calcNoWinnerBreakdown(prizePoolCents, betCount) {
  const totalPool = prizePoolCents || 0;
  const feeCents = Math.floor(totalPool * NO_WINNER_FEE_RATE);
  const refundPool = Math.floor(totalPool * (1 - NO_WINNER_FEE_RATE));
  const refundEach = betCount > 0 ? Math.floor(refundPool / betCount) : 0;
  return {
    totalPool,
    feeCents,
    refundPool,
    refundEach,
    feePercent: Math.round(NO_WINNER_FEE_RATE * 100),
    refundPercent: Math.round((1 - NO_WINNER_FEE_RATE) * 100),
    betCount,
  };
}

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

async function processGameResults(gameId, { skipNotify = false } = {}) {
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
      const [allBets] = await connection.query(
        `SELECT b.id, b.payment_id, p.amount_cents,
          (SELECT COUNT(*) FROM bets b2 WHERE b2.payment_id = b.payment_id) AS bets_in_payment
         FROM bets b
         JOIN payments p ON p.id = b.payment_id
         WHERE b.game_id = ?`,
        [gameId]
      );

      let refundEach = 0;
      for (const bet of allBets) {
        const stakeCents = Math.floor(
          bet.amount_cents / Math.max(1, parseInt(bet.bets_in_payment, 10) || 1)
        );
        const refund = calcNoWinnerRefundCents(stakeCents);
        refundEach = refund;
        await connection.query('UPDATE bets SET prize_amount_cents = ? WHERE id = ?', [refund, bet.id]);
      }

      await connection.query('UPDATE games SET status = ? WHERE id = ?', ['finished', gameId]);
      await connection.commit();

      setImmediate(() => {
        if (skipNotify) return;
        require('./whatsappNotifyService')
          .notifyGameResults(gameId)
          .catch((err) => console.error('[whatsapp] resultado:', err.message));
      });

      return { winners: 0, prizeEach: 0, refunds: allBets.length, refundEach };
    }

    const { netPool, prizeEach } = calcPrizeBreakdown(game.prize_pool_cents, winners.length);

    for (const winner of winners) {
      await connection.query(
        'UPDATE bets SET is_winner = TRUE, prize_amount_cents = ? WHERE id = ?',
        [prizeEach, winner.id]
      );
    }

    await connection.query('UPDATE games SET status = ? WHERE id = ?', ['finished', gameId]);
    await connection.commit();

    setImmediate(() => {
      if (skipNotify) return;
      require('./whatsappNotifyService')
        .notifyWinners(gameId)
        .catch((err) => console.error('[whatsapp] ganhadores:', err.message));
    });

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

    const [games] = await connection.query('SELECT * FROM games WHERE id = ?', [payment.game_id]);
    const gate = await assertPaymentCanBeConfirmed(payment, games[0], connection);
    if (!gate.ok) {
      await connection.commit();
      console.warn(
        `[confirmPayment] PIX recusado #${paymentId} — apostas encerradas (jogo ${payment.game_id})`
      );
      return { rejected: true, reason: gate.reason };
    }

    await connection.query('UPDATE payments SET status = ?, paid_at = NOW() WHERE id = ?', ['paid', paymentId]);
    payment.status = 'paid';

    await connection.query(
      'UPDATE games SET prize_pool_cents = prize_pool_cents + ? WHERE id = ?',
      [payment.amount_cents, payment.game_id]
    );

    await insertBetsFromPayment(connection, payment, placares);
    await processAffiliateCommissionOnPayment(connection, payment);

    await connection.commit();

    setImmediate(() => {
      require('./whatsappNotifyService')
        .notifyPaymentConfirmed(paymentId)
        .catch((err) => console.error('[whatsapp] pagamento:', err.message));
    });

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
  if (games.length === 0 || !isBettingOpen(games[0])) return { error: 'game_closed' };

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

  const [games] = await pool.query('SELECT * FROM games WHERE id = ?', [gameId]);
  const game = games[0] || null;

  const [pending] = await pool.query(
    `SELECT * FROM payments WHERE user_id = ? AND game_id = ? AND status = 'pending' ORDER BY created_at DESC`,
    [userId, gameId]
  );

  const pendingPayments = pending.filter(
    (p) => p.qr_code_text && game && canAcceptPaymentForGame(game)
  );

  return { step: 'placar', bets, pendingPayments, pendingPayment: pendingPayments[0] || null, placares: [] };
}

function enrichPayoutRow(row) {
  const betsInPayment = Math.max(1, parseInt(row.bets_in_payment, 10) || 1);
  const stakeCents = Math.floor((row.payment_amount_cents || 0) / betsInPayment);
  const isWinner = Boolean(row.is_winner);

  if (isWinner) {
    return {
      ...row,
      stakeCents,
      feeCents: null,
      feeLabel: `${Math.round(SYSTEM_FEE_RATE * 100)}% do pote`,
      payoutLabel: `Prêmio (${Math.round((1 - SYSTEM_FEE_RATE) * 100)}% do pote)`,
    };
  }

  const feeCents = Math.max(0, stakeCents - row.prize_amount_cents);
  return {
    ...row,
    stakeCents,
    feeCents,
    feeLabel: `${Math.round(NO_WINNER_FEE_RATE * 100)}%`,
    payoutLabel: `Reembolso (${Math.round((1 - NO_WINNER_FEE_RATE) * 100)}%)`,
  };
}

async function getPaymentFinanceSummary() {
  const [receivedRows] = await pool.query(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments WHERE status = 'paid'`
  );
  const totalReceivedCents = parseInt(receivedRows[0].total, 10) || 0;

  const [activePoolRows] = await pool.query(
    `SELECT COALESCE(SUM(prize_pool_cents), 0) AS pool
     FROM games WHERE status IN ('open', 'closed')`
  );
  const activePoolCents = parseInt(activePoolRows[0].pool, 10) || 0;

  const [finishedGames] = await pool.query(
    `SELECT g.prize_pool_cents,
      (SELECT COALESCE(SUM(b.prize_amount_cents), 0) FROM bets b WHERE b.game_id = g.id) AS distributed_cents,
      (SELECT COUNT(*) FROM bets b WHERE b.game_id = g.id AND b.is_winner = 1) AS winner_count
     FROM games g WHERE g.status = 'finished'`
  );

  let realizedFeeCents = 0;
  let realizedDistributedCents = 0;
  let feeFromWinnersCents = 0;
  let feeFromNoWinnerCents = 0;

  for (const g of finishedGames) {
    const pool = g.prize_pool_cents || 0;
    const distributed = parseInt(g.distributed_cents, 10) || 0;
    const fee = Math.max(0, pool - distributed);
    realizedDistributedCents += distributed;
    realizedFeeCents += fee;
    if (parseInt(g.winner_count, 10) > 0) {
      feeFromWinnersCents += fee;
    } else if (pool > 0) {
      feeFromNoWinnerCents += fee;
    }
  }

  const [pendingPayoutSum] = await pool.query(
    `SELECT COALESCE(SUM(prize_amount_cents), 0) AS total
     FROM bets WHERE prize_amount_cents > 0 AND prize_paid_at IS NULL`
  );
  const pendingPayoutsCents = parseInt(pendingPayoutSum[0].total, 10) || 0;

  const [paidPayoutSum] = await pool.query(
    `SELECT COALESCE(SUM(prize_amount_cents), 0) AS total
     FROM bets WHERE prize_amount_cents > 0 AND prize_paid_at IS NOT NULL`
  );
  const paidPayoutsCents = parseInt(paidPayoutSum[0].total, 10) || 0;

  return {
    totalReceivedCents,
    activePoolCents,
    realizedFeeCents,
    realizedDistributedCents,
    feeFromWinnersCents,
    feeFromNoWinnerCents,
    pendingPayoutsCents,
    paidPayoutsCents,
  };
}

const PAYOUT_SELECT = `
  SELECT b.*, u.name as user_name, u.cpf as user_pix, u.phone as user_phone,
    g.home_team, g.away_team, g.title as game_title, g.prize_pool_cents as game_pool_cents,
    p.amount_cents as payment_amount_cents,
    (SELECT COUNT(*) FROM bets b2 WHERE b2.payment_id = b.payment_id) AS bets_in_payment
  FROM bets b
  JOIN users u ON u.id = b.user_id
  JOIN games g ON g.id = b.game_id
  LEFT JOIN payments p ON p.id = b.payment_id
`;

async function reprocessGameResults(gameId, { homeScore, awayScore } = {}) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [games] = await connection.query('SELECT * FROM games WHERE id = ? FOR UPDATE', [gameId]);
    if (games.length === 0) {
      await connection.rollback();
      throw new Error('Jogo não encontrado');
    }
    const game = games[0];
    if (game.status !== 'finished') {
      await connection.rollback();
      throw new Error('Só é possível recalcular jogos já finalizados.');
    }

    const [paidBets] = await connection.query(
      `SELECT COUNT(*) AS c FROM bets WHERE game_id = ? AND prize_paid_at IS NOT NULL`,
      [gameId]
    );
    if (paidBets[0].c > 0) {
      await connection.rollback();
      throw new Error('Não é possível recalcular: já há prêmios marcados como pagos.');
    }

    try {
      const [paidPayouts] = await connection.query(
        `SELECT COUNT(*) AS c FROM payouts WHERE game_id = ? AND status = 'paid'`,
        [gameId]
      );
      if (paidPayouts[0].c > 0) {
        await connection.rollback();
        throw new Error('Não é possível recalcular: já há pagamentos de prêmio confirmados.');
      }
    } catch (err) {
      if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }

    const home = homeScore != null ? parseInt(homeScore, 10) : game.home_score;
    const away = awayScore != null ? parseInt(awayScore, 10) : game.away_score;
    if (Number.isNaN(home) || Number.isNaN(away) || home < 0 || away < 0) {
      await connection.rollback();
      throw new Error('Placar inválido');
    }

    await connection.query(
      `UPDATE bets SET is_winner = FALSE, prize_amount_cents = 0, prize_paid_at = NULL WHERE game_id = ?`,
      [gameId]
    );

    try {
      await connection.query('DELETE FROM payouts WHERE game_id = ?', [gameId]);
    } catch (err) {
      if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
    }

    await connection.query(
      `UPDATE games SET home_score = ?, away_score = ?, status = 'closed', api_match_status = 'FINISHED' WHERE id = ?`,
      [home, away, gameId]
    );

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  const result = await processGameResults(gameId, { skipNotify: true });

  setImmediate(() => {
    require('./whatsappNotifyService')
      .notifyWinners(gameId)
      .then((notifyResult) => {
        if (notifyResult?.queued > 0) {
          console.log(`[whatsapp] ${notifyResult.queued} ganhador(es) notificado(s) — jogo ${gameId}`);
        }
      })
      .catch((err) => console.error('[whatsapp] ganhadores:', err.message));
  });

  return result;
}

module.exports = {
  SYSTEM_FEE_RATE,
  NO_WINNER_FEE_RATE,
  calcPrizeBreakdown,
  calcNoWinnerRefundCents,
  calcNoWinnerBreakdown,
  processGameResults,
  reprocessGameResults,
  confirmPayment,
  createPaymentWithPlacar,
  getUserGameStatus,
  parsePredictions,
  enrichPayoutRow,
  getPaymentFinanceSummary,
  PAYOUT_SELECT,
};
