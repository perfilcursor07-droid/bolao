const express = require('express');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { createPaymentWithPlacar, getUserGameStatus, calcPrizeBreakdown } = require('../services/prizeService');
const { findOrCreateParticipant, setSessionUser, cleanPhone, pixKeysMatch, findUserByPhone } = require('../services/guestService');
const { tryBindSessionReferral } = require('../services/affiliateService');
const { loadHomeData } = require('../services/homeService');
const { loadFinishedBoloes, loadBetsForGames } = require('../services/finishedBoloesService');
const { attachMarketingPoolToGame } = require('../services/marketingBetService');
const { isBettingOpen } = require('../services/bettingRules');
const { closeExpiredOpenGames } = require('../services/gameStatusService');
const { expirePendingPaymentsForClosedBetting, canAcceptPaymentForGame } = require('../services/paymentGateService');

const router = express.Router();

// API: buscar dados do participante pelo telefone
router.post('/api/lookup-phone', async (req, res) => {
  const phone = (req.body.phone || '').replace(/\D/g, '');
  if (phone.length < 10) return res.json({ found: false });

  try {
    const user = await findUserByPhone(phone);
    if (user) {
      return res.json({
        found: true,
        name: (user.name || '').toUpperCase(),
        cpf: user.cpf || '',
      });
    }
    res.json({ found: false });
  } catch (err) {
    res.json({ found: false });
  }
});

router.get('/', async (req, res) => {
  try {
    const data = await loadHomeData(req.session.user?.id, { withApiSync: true });

    res.render('index', {
      title: 'Bolão Online',
      ...data,
      user: req.session.user || null,
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user || null });
  }
});

router.get('/api/home', async (req, res) => {
  try {
    const data = await loadHomeData(req.session.user?.id, { withApiSync: true });
    res.render('partials/home-dynamic', {
      ...data,
      user: req.session.user || null,
    });
  } catch (err) {
    res.status(500).send('');
  }
});

router.get('/consultar', (req, res) => {
  res.render('consultar', {
    title: 'Consultar apostas',
    bets: null,
    userName: null,
    pixKey: '',
    phone: '',
    error: null,
    user: req.session.user || null,
  });
});

router.post('/consultar', async (req, res) => {
  const phone = cleanPhone(req.body.phone);
  const phoneDisplay = req.body.phone || '';

  if (phone.length < 10) {
    return res.render('consultar', {
      title: 'Consultar apostas',
      bets: null,
      userName: null,
      phone: phoneDisplay,
      error: 'Informe um WhatsApp válido com DDD.',
      user: req.session.user || null,
    });
  }

  try {
    const [users] = await pool.query('SELECT id, name, cpf FROM users WHERE phone = ? LIMIT 1', [phone]);
    if (users.length === 0) {
      return res.render('consultar', {
        title: 'Consultar apostas',
        bets: null,
        userName: null,
        phone: phoneDisplay,
        error: 'Nenhuma aposta encontrada com este WhatsApp.',
        user: req.session.user || null,
      });
    }

    const user = users[0];
    const [bets] = await pool.query(
      `SELECT b.*, g.title, g.home_team, g.away_team, g.home_score, g.away_score, g.status as game_status, g.prize_pool_cents
       FROM bets b JOIN games g ON g.id = b.game_id
       WHERE b.user_id = ? ORDER BY b.created_at DESC`,
      [user.id]
    );

    res.render('consultar', {
      title: 'Consultar apostas',
      bets,
      userName: user.name.split(' ')[0],
      pixKey: user.cpf || '',
      phone: phoneDisplay,
      error: null,
      user: req.session.user || null,
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user || null });
  }
});

router.get('/boloes-encerrados', async (req, res) => {
  try {
    const finishedSummaries = await loadFinishedBoloes({ includeAllBets: true });
    res.render('boloes-encerrados', {
      title: 'Bolões encerrados',
      finishedSummaries,
      user: req.session.user || null,
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user || null });
  }
});

router.get('/ganhadores', async (req, res) => {
  try {
    const allFinished = await loadFinishedBoloes();
    const winnerSummaries = allFinished.filter((item) => item.winners.length > 0);

    res.render('ganhadores', {
      title: 'Ganhadores',
      winnerSummaries,
      user: req.session.user || null,
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user || null });
  }
});

router.get('/games/:id/participar', async (req, res) => {
  try {
    await closeExpiredOpenGames();
    const [games] = await pool.query('SELECT * FROM games WHERE id = ?', [req.params.id]);
    if (games.length === 0 || !isBettingOpen(games[0])) return res.redirect('/');

    const game = await attachMarketingPoolToGame(games[0]);

    if (req.session.user) {
      return res.redirect(`/games/${game.id}/placar`);
    }

    res.render('participar', { title: 'Participar', game, error: null, user: null });
  } catch (err) {
    res.redirect('/');
  }
});

router.post('/games/:id/participar', async (req, res) => {
  const { name, phone, cpf, cpf_confirm } = req.body;

  try {
    await closeExpiredOpenGames();
    const [games] = await pool.query('SELECT * FROM games WHERE id = ?', [req.params.id]);
    if (games.length === 0 || !isBettingOpen(games[0])) return res.redirect('/');

    const game = await attachMarketingPoolToGame(games[0]);

    if (!pixKeysMatch(cpf, cpf_confirm)) {
      return res.render('participar', {
        title: 'Participar',
        game,
        error: 'As chaves PIX não conferem. Digite a mesma chave nos dois campos.',
        form: req.body,
        user: null,
      });
    }

    const result = await findOrCreateParticipant({ name, phone, cpf });

    if (result.error === 'invalid_data') {
      return res.render('participar', {
        title: 'Participar',
        game,
        error: 'Preencha nome e chave PIX válidos',
        form: req.body,
        user: null,
      });
    }

    if (result.error === 'invalid_phone') {
      return res.render('participar', {
        title: 'Participar',
        game,
        error: 'WhatsApp inválido. Use só números: DDD + 9 + celular (11 dígitos). Ex.: 63981013083',
        form: req.body,
        user: null,
      });
    }

    if (result.error === 'admin_cpf') {
      return res.render('participar', {
        title: 'Participar',
        game,
        error: 'Chave PIX vinculada a administrador. Faça login.',
        form: req.body,
        user: null,
      });
    }

    if (result.error === 'pix_taken') {
      return res.render('participar', {
        title: 'Participar',
        game,
        error: 'Esta chave PIX já está cadastrada com outro WhatsApp. Use o mesmo WhatsApp da primeira aposta.',
        form: req.body,
        user: null,
      });
    }

    setSessionUser(req, result);
    await tryBindSessionReferral(req, result.id);

    res.redirect(`/games/${game.id}/placar?novo=1`);
  } catch (err) {
    console.error('Erro participar:', err.message);
    const [games] = await pool.query('SELECT * FROM games WHERE id = ?', [req.params.id]);
    res.render('participar', {
      title: 'Participar',
      game: games[0],
      error: 'Erro ao processar. Tente novamente.',
      form: req.body,
      user: null,
    });
  }
});

router.get('/games/:id', async (req, res) => {
  try {
    const [games] = await pool.query('SELECT * FROM games WHERE id = ?', [req.params.id]);
    if (games.length === 0) return res.redirect('/');

    const game = await attachMarketingPoolToGame(games[0]);

    if (game.status === 'open' && isBettingOpen(game) && !req.session.user) {
      return res.redirect(`/games/${game.id}/participar`);
    }

    let userStatus = { step: 'placar', bets: [], pendingPayment: null };
    if (req.session.user) {
      userStatus = await getUserGameStatus(req.session.user.id, game.id);
    }

    const [winners] = await pool.query(
      `SELECT b.*, u.name FROM bets b JOIN users u ON u.id = b.user_id
       WHERE b.game_id = ? AND b.is_winner = TRUE
       ORDER BY b.prize_amount_cents DESC, u.name ASC`,
      [game.id]
    );

    const prizeBreakdown = calcPrizeBreakdown(game.display_prize_pool_cents, winners.length);

    const betsMap = await loadBetsForGames([game]);
    const publicBets = betsMap[game.id] || { bets: [], breakdown: prizeBreakdown };

    res.render('game-detail', {
      title: game.title,
      game,
      userStatus,
      winners,
      prizeBreakdown,
      publicBets,
      closedBetting: publicBets,
      user: req.session.user || null,
      success: req.query.success === '1',
      error: req.query.error === 'payment'
        ? 'Erro ao gerar PIX. Verifique o token PagBank.'
        : null,
    });
  } catch (err) {
    res.redirect('/');
  }
});

router.get('/games/:id/placar', requireAuth, async (req, res) => {
  try {
    await closeExpiredOpenGames();
    const [games] = await pool.query('SELECT * FROM games WHERE id = ?', [req.params.id]);
    if (games.length === 0 || !isBettingOpen(games[0])) return res.redirect('/');

    const game = games[0];
    const userStatus = await getUserGameStatus(req.session.user.id, game.id);

    res.render('placar', {
      title: 'Escolher Placar',
      game,
      user: req.session.user,
      userStatus,
      novo: req.query.novo === '1',
      added: req.query.added === '1',
      error: req.query.error === 'payment'
        ? 'Não foi possível gerar o PIX. Tente novamente em alguns instantes.'
        : req.query.error === 'empty'
          ? 'Adicione pelo menos um palpite.'
          : req.query.error === 'cart'
            ? 'Erro ao adicionar ao carrinho.'
            : req.query.error === 'no_edit'
              ? 'Apostas já confirmadas não podem ser alteradas. Para outro palpite, adicione uma nova aposta.'
              : null,
    });
  } catch (err) {
    res.redirect('/');
  }
});

router.post('/games/:id/placar', requireAuth, async (req, res) => {
  let placares = [];

  try {
    if (req.body.placares_json) {
      const parsed = JSON.parse(req.body.placares_json);
      if (Array.isArray(parsed)) {
        placares = parsed;
      }
    }
  } catch (e) {
    console.error('Erro ao parsear placares_json:', e.message);
    placares = [];
  }

  // Fallback: se veio via campos individuais (compatibilidade)
  if (placares.length === 0) {
    const homeScore = parseInt(req.body.home_score);
    const awayScore = parseInt(req.body.away_score);
    if (!isNaN(homeScore) && !isNaN(awayScore) && homeScore >= 0 && awayScore >= 0) {
      placares = [{ home: homeScore, away: awayScore }];
    }
  }

  // Sanitiza e valida cada placar
  placares = placares
    .map((p) => ({ home: parseInt(p.home, 10), away: parseInt(p.away, 10) }))
    .filter((p) => !isNaN(p.home) && !isNaN(p.away) && p.home >= 0 && p.away >= 0 && p.home <= 99 && p.away <= 99);

  if (placares.length === 0) {
    const [games] = await pool.query('SELECT * FROM games WHERE id = ?', [req.params.id]);
    if (games.length === 0) return res.redirect('/');
    const userStatus = await getUserGameStatus(req.session.user.id, req.params.id);
    return res.render('placar', {
      title: 'Escolher Placar',
      game: games[0],
      user: req.session.user,
      userStatus,
      error: 'Adicione pelo menos um placar antes de pagar.',
    });
  }

  try {
    const result = await createPaymentWithPlacar(req.session.user.id, req.params.id, placares);

    if (result.error === 'game_closed') return res.redirect('/');
    if (result.error === 'no_placares') {
      return res.redirect(`/games/${req.params.id}/placar`);
    }

    res.redirect(`/payment/${result.paymentId}`);
  } catch (err) {
    console.error('Erro ao criar pagamento:', err.message, err.stack);
    res.redirect(`/games/${req.params.id}/placar?error=payment`);
  }
});

router.get('/regras', (req, res) => {
  res.render('regras', { title: 'Regras', user: req.session.user || null });
});

function formatCents(cents) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Palpites confirmados não podem ser alterados pelo apostador — somente admin em /admin/apostas
function blockUserBetEdit(req, res) {
  const gameId = req.params.gameId || req.params.id;
  const target = gameId ? `/games/${gameId}/placar` : '/my-bets';
  res.redirect(`${target}?error=no_edit`);
}

router.all('/games/:gameId/bets/:betId/edit', requireAuth, blockUserBetEdit);

router.get('/my-bets', requireAuth, async (req, res) => {
  const [bets] = await pool.query(
    `SELECT b.*, g.title, g.home_team, g.away_team, g.home_score, g.away_score, g.status as game_status, g.prize_pool_cents
     FROM bets b JOIN games g ON g.id = b.game_id
     WHERE b.user_id = ? ORDER BY b.created_at DESC`,
    [req.session.user.id]
  );
  res.render('my-bets', {
    title: 'Minhas Apostas',
    bets,
    user: req.session.user,
    error:
      req.query.error === 'no_edit'
        ? 'Apostas já confirmadas não podem ser alteradas. Entre em contato com o suporte se precisar de ajuda.'
        : null,
  });
});

router.get('/my-payments', requireAuth, async (req, res) => {
  await expirePendingPaymentsForClosedBetting();

  const [payments] = await pool.query(
    `SELECT p.*, g.title, g.home_team, g.away_team, g.status AS game_status, g.game_date
     FROM payments p JOIN games g ON g.id = p.game_id
     WHERE p.user_id = ?
     ORDER BY p.created_at DESC`,
    [req.session.user.id]
  );

  const pendingPayments = payments.filter(
    (p) => p.status === 'pending' && p.qr_code_text && canAcceptPaymentForGame(p)
  );

  res.render('my-payments', {
    title: 'Meus Pagamentos',
    payments,
    pendingPayments,
    user: req.session.user,
  });
});

module.exports = router;
module.exports.formatCents = formatCents;
