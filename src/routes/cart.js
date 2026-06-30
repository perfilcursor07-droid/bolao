const express = require('express');
const QRCode = require('qrcode');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { createPaymentWithPlacar } = require('../services/prizeService');
const { isBettingOpen } = require('../services/gameStatusService');
const { getPendingPaymentsForUser, getPendingPaymentsCount } = require('../services/paymentsService');
const {
  getCart,
  getCartCount,
  getCartTotalCents,
  addToCart,
  removeGameFromCart,
  removePlacarFromCart,
  removePlacarFromCartByScore,
  parsePlacaresFromBody,
} = require('../services/cartService');

const router = express.Router();

function wantsJson(req) {
  const accept = req.get('Accept') || '';
  const ctype = req.get('Content-Type') || '';
  return accept.includes('application/json') || ctype.includes('application/json');
}

async function cartSummary(req) {
  const cartCount = getCartCount(req);
  const pendingPaymentsCount = await getPendingPaymentsCount(req.session.user.id);
  return { cartCount, pendingPaymentsCount, badgeTotal: cartCount + pendingPaymentsCount };
}

router.get('/carrinho', requireAuth, async (req, res) => {
  const cart = getCart(req);
  const pendingPayments = await getPendingPaymentsForUser(req.session.user.id);
  res.render('carrinho', {
    title: 'Meu Carrinho',
    cart,
    cartCount: getCartCount(req),
    cartTotal: getCartTotalCents(req),
    pendingPayments,
    user: req.session.user,
    added: req.query.added === '1',
    error: req.query.error || null,
  });
});

router.get('/api/cart/summary', requireAuth, async (req, res) => {
  res.json(await cartSummary(req));
});

router.post('/api/cart/remove-placar', requireAuth, async (req, res) => {
  const { game_id, home, away } = req.body;
  const ok = removePlacarFromCartByScore(req, game_id, home, away);
  res.json({ ok, ...(await cartSummary(req)) });
});

router.post('/games/:id/cart/add', requireAuth, async (req, res) => {
  const placares = parsePlacaresFromBody(req.body);

  try {
    const [games] = await pool.query('SELECT * FROM games WHERE id = ? AND status = ?', [req.params.id, 'open']);
    if (games.length === 0 || !isBettingOpen(games[0])) {
      if (wantsJson(req)) return res.status(400).json({ ok: false, error: 'closed' });
      return res.redirect('/');
    }

    if (placares.length === 0) {
      if (wantsJson(req)) return res.status(400).json({ ok: false, error: 'empty' });
      return res.redirect(`/games/${req.params.id}/placar?error=empty`);
    }

    addToCart(req, games[0], placares);

    if (wantsJson(req)) {
      return res.json({ ok: true, ...(await cartSummary(req)) });
    }

    res.redirect('/carrinho?added=1');
  } catch (err) {
    console.error('Erro ao adicionar ao carrinho:', err.message);
    if (wantsJson(req)) return res.status(500).json({ ok: false, error: 'cart' });
    res.redirect(`/games/${req.params.id}/placar?error=cart`);
  }
});

router.post('/carrinho/remove-game', requireAuth, (req, res) => {
  removeGameFromCart(req, req.body.game_id);
  res.redirect('/carrinho');
});

router.post('/carrinho/remove-placar', requireAuth, (req, res) => {
  const { game_id, placar_index, home, away, return_to } = req.body;
  if (home !== undefined && away !== undefined && home !== '' && away !== '') {
    removePlacarFromCartByScore(req, game_id, home, away);
  } else {
    removePlacarFromCart(req, game_id, placar_index);
  }
  const safeReturn = typeof return_to === 'string' && return_to.startsWith('/') ? return_to : '/carrinho';
  res.redirect(safeReturn);
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
      `SELECT p.*, g.title, g.home_team, g.away_team, g.status AS game_status, g.game_date
       FROM payments p JOIN games g ON g.id = p.game_id
       WHERE p.id IN (${placeholders}) AND p.user_id = ? AND p.status = 'pending'
       ORDER BY p.id ASC`,
      [...paymentIds, req.session.user.id]
    );

    const { canAcceptPaymentForGame } = require('../services/paymentGateService');
    const validPayments = payments.filter((p) => canAcceptPaymentForGame(p));

    if (validPayments.length === 0) {
      delete req.session.checkoutPayments;
      return res.redirect('/my-payments');
    }

    const paymentsWithQr = await Promise.all(
      validPayments.map(async (payment) => {
        let qrImage = null;
        if (payment.qr_code_text) {
          qrImage = await QRCode.toDataURL(payment.qr_code_text, { width: 180, margin: 1 });
        }
        return { ...payment, qrImage };
      })
    );

    const totalCents = validPayments.reduce((sum, p) => sum + p.amount_cents, 0);

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
