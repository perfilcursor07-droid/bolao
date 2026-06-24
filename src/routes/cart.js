const express = require('express');
const QRCode = require('qrcode');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { createPaymentWithPlacar } = require('../services/prizeService');
const {
  getCart,
  getCartCount,
  getCartTotalCents,
  addToCart,
  removeGameFromCart,
  removePlacarFromCart,
} = require('../services/cartService');

const router = express.Router();

function parsePlacares(body) {
  let placares = [];
  try {
    if (body.placares_json) {
      const parsed = JSON.parse(body.placares_json);
      if (Array.isArray(parsed)) placares = parsed;
    }
  } catch (_) {
    placares = [];
  }

  if (placares.length === 0) {
    const homeScore = parseInt(body.home_score, 10);
    const awayScore = parseInt(body.away_score, 10);
    if (!isNaN(homeScore) && !isNaN(awayScore) && homeScore >= 0 && awayScore >= 0) {
      placares = [{ home: homeScore, away: awayScore }];
    }
  }

  return placares
    .map((p) => ({ home: parseInt(p.home, 10), away: parseInt(p.away, 10) }))
    .filter((p) => !isNaN(p.home) && !isNaN(p.away) && p.home >= 0 && p.away >= 0 && p.home <= 99 && p.away <= 99);
}

router.get('/carrinho', requireAuth, (req, res) => {
  const cart = getCart(req);
  res.render('carrinho', {
    title: 'Meu Carrinho',
    cart,
    cartCount: getCartCount(req),
    cartTotal: getCartTotalCents(req),
    user: req.session.user,
    added: req.query.added === '1',
    error: req.query.error || null,
  });
});

router.post('/games/:id/cart/add', requireAuth, async (req, res) => {
  const placares = parsePlacares(req.body);

  try {
    const [games] = await pool.query('SELECT * FROM games WHERE id = ? AND status = ?', [req.params.id, 'open']);
    if (games.length === 0) return res.redirect('/');

    if (placares.length === 0) {
      return res.redirect(`/games/${req.params.id}/placar?error=empty`);
    }

    addToCart(req, games[0], placares);
    res.redirect('/carrinho?added=1');
  } catch (err) {
    console.error('Erro ao adicionar ao carrinho:', err.message);
    res.redirect(`/games/${req.params.id}/placar?error=cart`);
  }
});

router.post('/carrinho/remove-game', requireAuth, (req, res) => {
  removeGameFromCart(req, req.body.game_id);
  res.redirect('/carrinho');
});

router.post('/carrinho/remove-placar', requireAuth, (req, res) => {
  removePlacarFromCart(req, req.body.game_id, req.body.placar_index);
  res.redirect('/carrinho');
});

router.post('/carrinho/finalizar', requireAuth, async (req, res) => {
  const cart = getCart(req);
  if (cart.length === 0) {
    return res.redirect('/carrinho?error=' + encodeURIComponent('Seu carrinho está vazio'));
  }

  const paymentIds = [];

  try {
    const remaining = [];

    for (const item of cart) {
      const result = await createPaymentWithPlacar(req.session.user.id, item.gameId, item.placares);
      if (result.paymentId) {
        paymentIds.push(result.paymentId);
      } else {
        remaining.push(item);
      }
    }

    req.session.cart = remaining;

    if (paymentIds.length === 0) {
      return res.redirect('/carrinho?error=' + encodeURIComponent('Não foi possível gerar os PIX. Tente novamente.'));
    }
    req.session.checkoutPayments = paymentIds;

    if (paymentIds.length === 1) {
      return res.redirect(`/payment/${paymentIds[0]}`);
    }

    res.redirect('/carrinho/pagamento');
  } catch (err) {
    console.error('Erro no checkout:', err.message);
    res.redirect('/carrinho?error=' + encodeURIComponent('Erro ao finalizar. Tente novamente.'));
  }
});

router.get('/carrinho/pagamento', requireAuth, async (req, res) => {
  const paymentIds = req.session.checkoutPayments || [];
  if (paymentIds.length === 0) {
    return res.redirect('/my-payments');
  }

  try {
    const placeholders = paymentIds.map(() => '?').join(',');
    const [payments] = await pool.query(
      `SELECT p.*, g.title, g.home_team, g.away_team
       FROM payments p JOIN games g ON g.id = p.game_id
       WHERE p.id IN (${placeholders}) AND p.user_id = ? AND p.status = 'pending'
       ORDER BY p.id ASC`,
      [...paymentIds, req.session.user.id]
    );

    if (payments.length === 0) {
      delete req.session.checkoutPayments;
      return res.redirect('/my-payments');
    }

    const paymentsWithQr = await Promise.all(
      payments.map(async (payment) => {
        let qrImage = null;
        if (payment.qr_code_text) {
          qrImage = await QRCode.toDataURL(payment.qr_code_text, { width: 180, margin: 1 });
        }
        return { ...payment, qrImage };
      })
    );

    const totalCents = payments.reduce((sum, p) => sum + p.amount_cents, 0);

    res.render('carrinho-pagamento', {
      title: 'Pagar apostas',
      payments: paymentsWithQr,
      totalCents,
      user: req.session.user,
    });
  } catch (err) {
    console.error('Erro carrinho pagamento:', err.message);
    res.redirect('/my-payments');
  }
});

module.exports = router;
