const express = require('express');
const QRCode = require('qrcode');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { confirmPayment } = require('../services/prizeService');
const { getOrderStatus, extractChargeStatus } = require('../services/pagbank');

const router = express.Router();

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const [payments] = await pool.query(
      `SELECT p.*, g.title, g.home_team, g.away_team
       FROM payments p JOIN games g ON g.id = p.game_id
       WHERE p.id = ? AND p.user_id = ?`,
      [req.params.id, req.session.user.id]
    );

    if (payments.length === 0) return res.redirect('/');

    const payment = payments[0];
    let qrImage = null;

    if (payment.qr_code_text) {
      qrImage = await QRCode.toDataURL(payment.qr_code_text, { width: 280, margin: 2 });
    }

    const prediction = payment.prediction_data ? JSON.parse(payment.prediction_data) : null;

    res.render('payment', {
      title: 'Pagamento PIX',
      payment,
      qrImage,
      user: req.session.user,
    });
  } catch (err) {
    res.redirect('/');
  }
});

router.get('/:id/status', requireAuth, async (req, res) => {
  try {
    const [payments] = await pool.query(
      'SELECT * FROM payments WHERE id = ? AND user_id = ?',
      [req.params.id, req.session.user.id]
    );

    if (payments.length === 0) {
      return res.json({ status: 'not_found' });
    }

    const payment = payments[0];

    if (payment.status === 'paid') {
      return res.json({ status: 'paid' });
    }

    if (payment.pagbank_order_id) {
      try {
        const order = await getOrderStatus(payment.pagbank_order_id);
        const chargeStatus = extractChargeStatus(order);

        if (chargeStatus === 'PAID') {
          await confirmPayment(payment.id);
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
      const [rows] = await pool.query('SELECT * FROM payments WHERE reference_id = ?', [referenceId]);
      payment = rows[0];
    } else {
      const [rows] = await pool.query('SELECT * FROM payments WHERE pagbank_order_id = ?', [orderId]);
      payment = rows[0];
    }

    if (!payment || payment.status === 'paid') {
      return res.status(200).send('OK');
    }

    const order = orderId ? body : await getOrderStatus(payment.pagbank_order_id);
    const chargeStatus = extractChargeStatus(order);

    if (chargeStatus === 'PAID') {
      await confirmPayment(payment.id);
      console.log(`Webhook: pagamento confirmado ${payment.reference_id}`);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Erro no webhook:', err.message);
    res.status(200).send('OK');
  }
});

module.exports = router;
