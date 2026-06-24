const express = require('express');
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { createPaymentWithPlacar, getUserGameStatus } = require('../services/prizeService');
const { findOrCreateParticipant, setSessionUser } = require('../services/guestService');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const [games] = await pool.query(
      `SELECT g.*,
        (SELECT COUNT(*) FROM bets b WHERE b.game_id = g.id) as total_bets
       FROM games g
       WHERE g.status IN ('open', 'closed', 'finished')
       ORDER BY
         g.featured DESC,
         CASE g.status WHEN 'open' THEN 0 WHEN 'closed' THEN 1 ELSE 2 END,
         g.game_date ASC`
    );

    const openGames = games.filter((g) => g.status === 'open');
    const otherGames = games.filter((g) => g.status !== 'open');
    const featuredGames = openGames.filter((g) => g.featured);
    const normalGames = openGames.filter((g) => !g.featured);

    let myBets = [];
    let gameStatusMap = {};

    if (req.session.user) {
      const [bets] = await pool.query(
        `SELECT b.*, g.title, g.home_team, g.away_team, g.home_score, g.away_score, g.status as game_status
         FROM bets b JOIN games g ON g.id = b.game_id
         WHERE b.user_id = ? ORDER BY b.created_at DESC`,
        [req.session.user.id]
      );
      myBets = bets;

      for (const game of openGames) {
        gameStatusMap[game.id] = await getUserGameStatus(req.session.user.id, game.id);
      }
    }

    res.render('index', {
      title: 'Bolão Online',
      openGames: normalGames,
      featuredGames,
      otherGames,
      myBets,
      gameStatusMap,
      user: req.session.user || null,
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user || null });
  }
});

router.get('/games/:id/participar', async (req, res) => {
  try {
    const [games] = await pool.query('SELECT * FROM games WHERE id = ? AND status = ?', [req.params.id, 'open']);
    if (games.length === 0) return res.redirect('/');

    const game = games[0];

    if (req.session.user) {
      const userStatus = await getUserGameStatus(req.session.user.id, game.id);
      if (userStatus.step === 'pay') return res.redirect(`/payment/${userStatus.pendingPayment.id}`);
      return res.redirect(`/games/${game.id}`);
    }

    res.render('participar', { title: 'Participar', game, error: null, user: null });
  } catch (err) {
    res.redirect('/');
  }
});

router.post('/games/:id/participar', async (req, res) => {
  const { name, phone, cpf } = req.body;

  try {
    const [games] = await pool.query('SELECT * FROM games WHERE id = ? AND status = ?', [req.params.id, 'open']);
    if (games.length === 0) return res.redirect('/');

    const game = games[0];
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

    const userStatus = await getUserGameStatus(result.id, game.id);
    if (userStatus.step === 'pay') return res.redirect(`/payment/${userStatus.pendingPayment.id}`);

    res.redirect(`/games/${game.id}`);
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

    if (game.status === 'open' && !req.session.user) {
      return res.redirect(`/games/${game.id}/participar`);
    }

    let userStatus = { step: 'placar', bets: [], pendingPayment: null };
    if (req.session.user) {
      userStatus = await getUserGameStatus(req.session.user.id, game.id);
    }

    const [winners] = await pool.query(
      `SELECT b.*, u.name FROM bets b JOIN users u ON u.id = b.user_id
       WHERE b.game_id = ? AND b.is_winner = TRUE`,
      [game.id]
    );

    res.render('game-detail', {
      title: game.title,
      game,
      userStatus,
      winners,
      user: req.session.user || null,
      success: req.query.success === '1',
      error: req.query.error === 'payment' ? 'Erro ao gerar PIX. Verifique o token PagBank.' : null,
    });
  } catch (err) {
    res.redirect('/');
  }
});

router.get('/games/:id/placar', requireAuth, async (req, res) => {
  try {
    const [games] = await pool.query('SELECT * FROM games WHERE id = ? AND status = ?', [req.params.id, 'open']);
    if (games.length === 0) return res.redirect('/');

    const game = games[0];
    const userStatus = await getUserGameStatus(req.session.user.id, game.id);

    if (userStatus.step === 'pay') {
      return res.redirect(`/payment/${userStatus.pendingPayment.id}`);
    }

    res.render('placar', {
      title: 'Escolher Placar',
      game,
      user: req.session.user,
      userStatus,
      error: req.query.error === 'payment' ? 'Não foi possível gerar o PIX. Tente novamente em alguns instantes.' : null,
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

    if (result.error === 'pending_payment') {
      return res.redirect(`/payment/${result.paymentId}`);
    }
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
  console.log(`[my-payments] user_id=${req.session.user.id}, name=${req.session.user.name}`);
  const [payments] = await pool.query(
    `SELECT p.*, g.title, g.home_team, g.away_team
     FROM payments p JOIN games g ON g.id = p.game_id
     WHERE p.user_id = ?
     ORDER BY p.created_at DESC`,
    [req.session.user.id]
  );
  console.log(`[my-payments] Encontrados ${payments.length} pagamentos`);
  if (payments.length > 0) {
    payments.forEach(p => console.log(`  -> id=${p.id} status=${p.status} qr=${p.qr_code_text ? 'SIM' : 'NAO'}`));
  }
  res.render('my-payments', { title: 'Meus Pagamentos', payments, user: req.session.user });
});

module.exports = router;
module.exports.formatCents = formatCents;
