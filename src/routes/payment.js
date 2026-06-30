const express = require('express');
const QRCode = require('qrcode');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { confirmPayment } = require('../services/prizeService');
const {
  canAcceptPaymentForGame,
  expirePendingPaymentsForClosedBetting,
} = require('../services/paymentGateService');
const { getOrderStatus, extractChargeStatus } = require('../services/pagbank');

const router = express.Router();

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const [payments] = await pool.query(
      `SELECT p.*, g.title, g.home_team, g.away_team, g.status AS game_status, g.game_date
       FROM payments p JOIN games g ON g.id = p.game_id
       WHERE p.id = ? AND p.user_id = ?`,
      [req.params.id, req.session.user.id]
    );

    if (payments.length === 0) {
      console.error(`[Payment GET /${req.params.id}] Pagamento não encontrado para user_id=${req.session.user.id}`);
      // Verificar se o pagamento existe com outro user
      const [anyPayment] = await pool.query('SELECT id, user_id, status FROM payments WHERE id = ?', [req.params.id]);
      if (anyPayment.length > 0) {
        console.error(`[Payment GET /${req.params.id}] Pagamento existe mas pertence ao user_id=${anyPayment[0].user_id} (status: ${anyPayment[0].status})`);
      }
      return res.redirect('/');
    }

    const payment = payments[0];

    if (payment.status === 'pending' && !canAcceptPaymentForGame({ status: payment.game_status, game_date: payment.game_date })) {
      await pool.query(`UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'pending'`, [
        payment.id,
      ]);
      payment.status = 'expired';
    }

    let qrImage = null;

    if (payment.qr_code_text) {
      qrImage = await QRCode.toDataURL(payment.qr_code_text, { width: 200, margin: 1 });
    }

    res.render('payment', {
      title: 'Pagamento PIX',
      payment,
      qrImage,
      paymentClosed: ['expired', 'declined', 'cancelled'].includes(payment.status),
      user: req.session.user,
    });
  } catch (err) {
    console.error('[Payment GET] Erro:', err.message);
    res.redirect('/');
  }
});

router.get('/:id/status', requireAuth, async (req, res) => {
  try {
    const [payments] = await pool.query(
      `SELECT p.*, g.status AS game_status, g.game_date
       FROM payments p JOIN games g ON g.id = p.game_id
       WHERE p.id = ? AND p.user_id = ?`,
      [req.params.id, req.session.user.id]
    );

    if (payments.length === 0) {
      return res.json({ status: 'not_found' });
    }

    const payment = payments[0];

    if (payment.status === 'paid') {
      return res.json({ status: 'paid' });
    }

    if (['expired', 'declined', 'cancelled'].includes(payment.status)) {
      return res.json({ status: payment.status });
    }

    if (!canAcceptPaymentForGame({ status: payment.game_status, game_date: payment.game_date })) {
      await pool.query(`UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'pending'`, [
        payment.id,
      ]);
      return res.json({ status: 'expired' });
    }

    if (payment.pagbank_order_id) {
      try {
        const order = await getOrderStatus(payment.pagbank_order_id);
        const chargeStatus = extractChargeStatus(order);

        if (chargeStatus === 'PAID') {
          const result = await confirmPayment(payment.id);
          if (result?.rejected) {
            return res.json({ status: 'declined', reason: 'betting_closed' });
          }
          return res.json({ status: 'paid' });
        }
      } catch (err) {
        console.error('Erro ao consultar PagBank:', err.message);
      }
    }

    res.json({ status: payment.status });
  } catch (err) {
    res.json({ status: 'error' });
  }
});

router.post('/webhook/pagbank', express.json(), async (req, res) => {
  try {
    const body = req.body;
    const orderId = body.id;
    const referenceId = body.reference_id;

    if (!orderId && !referenceId) {
      return res.status(200).send('OK');
    }

    let payment;
    if (referenceId) {
      const [rows] = await pool.query(
        `SELECT p.*, g.status AS game_status, g.game_date
         FROM payments p JOIN games g ON g.id = p.game_id
         WHERE p.reference_id = ?`,
        [referenceId]
      );
      payment = rows[0];
    } else {
      const [rows] = await pool.query(
        `SELECT p.*, g.status AS game_status, g.game_date
         FROM payments p JOIN games g ON g.id = p.game_id
         WHERE p.pagbank_order_id = ?`,
        [orderId]
      );
      payment = rows[0];
    }

    if (!payment || payment.status === 'paid') {
      return res.status(200).send('OK');
    }

    if (['expired', 'declined', 'cancelled'].includes(payment.status)) {
      return res.status(200).send('OK');
    }

    const order = orderId ? body : await getOrderStatus(payment.pagbank_order_id);
    const chargeStatus = extractChargeStatus(order);

    if (chargeStatus === 'PAID') {
      const result = await confirmPayment(payment.id);
      if (result?.rejected) {
        console.warn(`Webhook: PIX recusado ${payment.reference_id} — apostas encerradas`);
      } else {
        console.log(`Webhook: pagamento confirmado ${payment.reference_id}`);
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Erro no webhook:', err.message);
    res.status(200).send('OK');
  }
});

module.exports = router;
