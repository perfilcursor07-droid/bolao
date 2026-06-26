const express = require('express');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { createPaymentWithPlacar, getUserGameStatus, calcPrizeBreakdown } = require('../services/prizeService');
const { findOrCreateParticipant, setSessionUser, cleanPhone, pixKeysMatch } = require('../services/guestService');
const { tryBindSessionReferral } = require('../services/affiliateService');
const { loadHomeData } = require('../services/homeService');
const { loadFinishedBoloes, loadBetsForGames } = require('../services/finishedBoloesService');
const { isBettingOpen } = require('../services/bettingRules');
const { closeExpiredOpenGames } = require('../services/gameStatusService');

const router = express.Router();

// API: buscar dados do participante pelo telefone
router.post('/api/lookup-phone', async (req, res) => {
  const phone = (req.body.phone || '').replace(/\D/g, '');
  if (phone.length < 10) return res.json({ found: false });

  try {
    const [users] = await pool.query('SELECT name, cpf FROM users WHERE phone = ? LIMIT 1', [phone]);
    if (users.length > 0) {
      return res.json({ found: true, name: users[0].name, cpf: users[0].cpf || '' });
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
    const [users] = await pool.query('SELECT id, name FROM users WHERE phone = ? LIMIT 1', [phone]);
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

    const game = games[0];

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

    const game = games[0];

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
        error: 'Preencha nome, telefone e chave PIX válidos',
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

    const game = games[0];

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

    const prizeBreakdown = calcPrizeBreakdown(game.prize_pool_cents, winners.length);

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
      edited: req.query.edited === '1',
      error: req.query.error === 'payment'
        ? 'Erro ao gerar PIX. Verifique o token PagBank.'
        : req.query.error === 'edit_closed'
          ? 'Não é mais possível editar este palpite — apostas encerradas.'
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

// Editar placar de uma aposta
router.get('/games/:gameId/bets/:betId/edit', requireAuth, async (req, res) => {
  try {
    const [bets] = await pool.query(
      'SELECT b.*, g.home_team, g.away_team, g.title, g.game_date FROM bets b JOIN games g ON g.id = b.game_id WHERE b.id = ? AND b.user_id = ? AND b.game_id = ?',
      [req.params.betId, req.session.user.id, req.params.gameId]
    );
    if (bets.length === 0) return res.redirect(`/games/${req.params.gameId}`);

    const [games] = await pool.query('SELECT * FROM games WHERE id = ?', [req.params.gameId]);
    if (games.length === 0 || !isBettingOpen(games[0])) {
      return res.redirect(`/games/${req.params.gameId}?error=edit_closed`);
    }

    res.render('edit-bet', { title: 'Editar Placar', bet: bets[0], user: req.session.user });
  } catch (err) {
    res.redirect(`/games/${req.params.gameId}`);
  }
});

router.post('/games/:gameId/bets/:betId/edit', requireAuth, async (req, res) => {
  const homeScore = parseInt(req.body.home_score);
  const awayScore = parseInt(req.body.away_score);

  if (isNaN(homeScore) || isNaN(awayScore) || homeScore < 0 || awayScore < 0 || homeScore > 99 || awayScore > 99) {
    return res.redirect(`/games/${req.params.gameId}`);
  }

  try {
    const [bets] = await pool.query(
      'SELECT b.id FROM bets b WHERE b.id = ? AND b.user_id = ? AND b.game_id = ?',
      [req.params.betId, req.session.user.id, req.params.gameId]
    );
    if (bets.length === 0) return res.redirect(`/games/${req.params.gameId}`);

    const [games] = await pool.query('SELECT * FROM games WHERE id = ?', [req.params.gameId]);
    if (games.length === 0 || !isBettingOpen(games[0])) {
      return res.redirect(`/games/${req.params.gameId}?error=edit_closed`);
    }

    await pool.query(
      'UPDATE bets SET home_score_prediction = ?, away_score_prediction = ? WHERE id = ?',
      [homeScore, awayScore, req.params.betId]
    );

    res.redirect(`/games/${req.params.gameId}?edited=1`);
  } catch (err) {
    res.redirect(`/games/${req.params.gameId}`);
  }
});

function formatCents(cents) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

router.get('/my-bets', requireAuth, async (req, res) => {
  const [bets] = await pool.query(
    `SELECT b.*, g.title, g.home_team, g.away_team, g.home_score, g.away_score, g.status as game_status, g.prize_pool_cents
     FROM bets b JOIN games g ON g.id = b.game_id
     WHERE b.user_id = ? ORDER BY b.created_at DESC`,
    [req.session.user.id]
  );
  res.render('my-bets', { title: 'Minhas Apostas', bets, user: req.session.user });
});

router.get('/my-payments', requireAuth, async (req, res) => {
  const [payments] = await pool.query(
    `SELECT p.*, g.title, g.home_team, g.away_team
     FROM payments p JOIN games g ON g.id = p.game_id
     WHERE p.user_id = ?
     ORDER BY p.created_at DESC`,
    [req.session.user.id]
  );

  const pendingPayments = payments.filter(
    (p) => p.status === 'pending' && p.qr_code_text
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
