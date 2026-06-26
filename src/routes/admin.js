const express = require('express');
const pool = require('../config/database');
const { requireAdmin } = require('../middleware/auth');
const { getWorldCupMatches } = require('../services/footballApi');
const { syncGamesFromWorldCupMatches } = require('../services/gameStatusService');
const { translateTeamName } = require('../utils/teamNamesPt');
const { toMySQLDateTime } = require('../utils/dateTime');
const { deleteGamesByIds } = require('../services/gameDelete');
const {
  getDefaultEntryFeeCents,
  getDefaultEntryFeeReais,
  setDefaultEntryFeeFromReais,
  centsToReaisInput,
} = require('../services/settingsService');

const router = express.Router();

router.use(async (req, res, next) => {
  try {
    res.locals.defaultEntryFee = await getDefaultEntryFeeReais();
  } catch {
    res.locals.defaultEntryFee = '10.00';
  }
  next();
});

router.get('/', requireAdmin, async (req, res) => {
  try {
    const [games] = await pool.query(
      `SELECT g.*, u.name as creator_name,
        (SELECT COUNT(*) FROM bets b WHERE b.game_id = g.id) as total_bets
       FROM games g
       JOIN users u ON u.id = g.created_by
       ORDER BY g.featured DESC, g.game_date DESC`
    );

    const [stats] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM games) as total_games,
        (SELECT COUNT(*) FROM bets) as total_bets,
        (SELECT COALESCE(SUM(prize_pool_cents), 0) FROM games WHERE status = 'finished') as total_prizes,
        (SELECT COUNT(*) FROM bets WHERE is_winner = TRUE) as total_winners,
        (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE status = 'paid') as total_revenue
    `);

    const [recentWinners] = await pool.query(
      `SELECT b.*, u.name as user_name, u.cpf as user_pix, g.home_team, g.away_team, g.title as game_title
       FROM bets b JOIN users u ON u.id = b.user_id JOIN games g ON g.id = b.game_id
       WHERE b.is_winner = TRUE ORDER BY b.created_at DESC LIMIT 5`
    );

    const featured = games.filter((g) => g.featured);
    const others = games.filter((g) => !g.featured);

    res.render('admin/dashboard', {
      title: 'Dashboard',
      games,
      featured,
      others,
      stats: stats[0],
      recentWinners,
      user: req.session.user,
      activePage: 'dashboard',
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user });
  }
});

router.get('/configuracoes', requireAdmin, async (req, res) => {
  try {
    const defaultEntryFee = await getDefaultEntryFeeReais();
    res.render('admin/configuracoes', {
      title: 'Configurações',
      defaultEntryFee,
      settingsSaved: req.query.saved === 'entry-fee',
      gamesUpdated: req.query.updated ? parseInt(req.query.updated, 10) : null,
      settingsError: req.query.error || null,
      user: req.session.user,
      activePage: 'configuracoes',
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user });
  }
});

router.post('/settings/entry-fee', requireAdmin, async (req, res) => {
  try {
    const applyToOpen = req.body.apply_open === '1';
    const { openGamesUpdated } = await setDefaultEntryFeeFromReais(req.body.entry_fee, {
      applyToOpenGames: applyToOpen,
    });
    const qs = new URLSearchParams({ saved: 'entry-fee' });
    if (applyToOpen && openGamesUpdated > 0) {
      qs.set('updated', String(openGamesUpdated));
    }
    res.redirect(`/admin/configuracoes?${qs.toString()}`);
  } catch (err) {
    res.redirect('/admin/configuracoes?error=' + encodeURIComponent(err.message));
  }
});

// Partidas
router.get('/partidas', requireAdmin, async (req, res) => {
  try {
    const [games] = await pool.query(
      `SELECT g.*, u.name as creator_name,
        (SELECT COUNT(*) FROM bets b WHERE b.game_id = g.id) as total_bets
       FROM games g JOIN users u ON u.id = g.created_by
       ORDER BY g.game_date DESC`
    );
    res.render('admin/partidas', {
      title: 'Partidas',
      games,
      user: req.session.user,
      activePage: 'partidas',
      deleted: req.query.deleted ? parseInt(req.query.deleted, 10) : null,
      error: req.query.error || null,
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user });
  }
});

router.post('/partidas/delete', requireAdmin, async (req, res) => {
  try {
    let ids = req.body.game_ids;
    if (!ids) ids = [];
    if (!Array.isArray(ids)) ids = [ids];
    ids = [...new Set(ids.map((id) => parseInt(id, 10)).filter((id) => id > 0))];

    if (ids.length === 0) {
      return res.redirect('/admin/partidas?error=' + encodeURIComponent('Nenhuma partida selecionada'));
    }

    const deleted = await deleteGamesByIds(ids);
    res.redirect(`/admin/partidas?deleted=${deleted}`);
  } catch (err) {
    console.error('Erro ao remover partidas:', err);
    res.redirect('/admin/partidas?error=' + encodeURIComponent(err.message));
  }
});

// Apostas — visão por jogo
router.get('/apostas', requireAdmin, async (req, res) => {
  try {
    const [games] = await pool.query(
      `SELECT g.id, g.title, g.home_team, g.away_team, g.status, g.game_date, g.home_score, g.away_score,
        (SELECT COUNT(*) FROM bets b WHERE b.game_id = g.id) as bet_count
       FROM games g
       ORDER BY g.game_date DESC`
    );

    const selectedGameId = req.query.game ? parseInt(req.query.game, 10) : null;
    const validGameId = selectedGameId && games.some((g) => g.id === selectedGameId) ? selectedGameId : null;

    let betsSql = `SELECT b.*, u.name as user_name, u.phone, u.cpf, u.role as user_role,
        g.id as game_id, g.title as game_title, g.home_team, g.away_team, g.home_score, g.away_score,
        g.status as game_status, g.game_date,
        p.status as payment_status, p.paid_at, p.amount_cents
       FROM bets b
       JOIN users u ON u.id = b.user_id
       JOIN games g ON g.id = b.game_id
       JOIN payments p ON p.id = b.payment_id`;

    const params = [];
    if (validGameId) {
      betsSql += ' WHERE g.id = ?';
      params.push(validGameId);
    }
    betsSql += ' ORDER BY g.game_date DESC, b.is_winner DESC, b.created_at DESC';

    const [bets] = await pool.query(betsSql, params);

    const gameGroups = [];
    const groupMap = new Map();
    for (const bet of bets) {
      if (!groupMap.has(bet.game_id)) {
        const gameMeta = games.find((g) => g.id === bet.game_id) || {
          id: bet.game_id,
          title: bet.game_title,
          home_team: bet.home_team,
          away_team: bet.away_team,
          status: bet.game_status,
          game_date: bet.game_date,
          home_score: bet.home_score,
          away_score: bet.away_score,
          bet_count: 0,
        };
        const group = { game: gameMeta, bets: [] };
        groupMap.set(bet.game_id, group);
        gameGroups.push(group);
      }
      groupMap.get(bet.game_id).bets.push(bet);
    }

    const stats = {
      totalBets: bets.length,
      winners: bets.filter((b) => b.is_winner).length,
      waiting: bets.filter((b) => !b.is_winner && b.game_status !== 'finished').length,
      lost: bets.filter((b) => !b.is_winner && b.game_status === 'finished').length,
    };

    res.render('admin/apostas', {
      title: 'Apostas',
      games,
      bets,
      gameGroups,
      selectedGameId: validGameId,
      stats,
      user: req.session.user,
      activePage: 'apostas',
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user });
  }
});

// Usuários
router.get('/usuarios', requireAdmin, async (req, res) => {
  try {
    const [users] = await pool.query(
      `SELECT u.*,
        (SELECT COUNT(*) FROM bets b WHERE b.user_id = u.id) as total_bets,
        (SELECT COUNT(*) FROM payments p WHERE p.user_id = u.id AND p.status = 'paid') as paid_payments
       FROM users u
       ORDER BY u.created_at DESC`
    );
    res.render('admin/usuarios', {
      title: 'Usuários',
      users,
      user: req.session.user,
      activePage: 'usuarios',
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user });
  }
});

// Ganhadores
router.get('/ganhadores', requireAdmin, async (req, res) => {
  try {
    const [winners] = await pool.query(
      `SELECT b.*, u.name as user_name, u.cpf as user_pix, u.phone as user_phone,
        g.home_team, g.away_team, g.title as game_title, g.home_score, g.away_score
       FROM bets b JOIN users u ON u.id = b.user_id JOIN games g ON g.id = b.game_id
       WHERE b.is_winner = TRUE
       ORDER BY b.created_at DESC`
    );
    res.render('admin/ganhadores', { title: 'Ganhadores', winners, user: req.session.user, activePage: 'ganhadores' });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user });
  }
});

// Pagamentos - visão completa
router.get('/pagamentos', requireAdmin, async (req, res) => {
  try {
    // 1. Pagamentos PIX pendentes (usuário gerou QR mas não pagou)
    const [pendingPayments] = await pool.query(
      `SELECT p.*, u.name as user_name, u.cpf as user_pix, u.phone as user_phone,
        g.home_team, g.away_team, g.title as game_title
       FROM payments p JOIN users u ON u.id = p.user_id JOIN games g ON g.id = p.game_id
       WHERE p.status = 'pending'
       ORDER BY p.created_at DESC`
    );

    // 2. Pagamentos PIX confirmados (apostas pagas)
    const [confirmedPayments] = await pool.query(
      `SELECT p.*, u.name as user_name, u.cpf as user_pix, u.phone as user_phone,
        g.home_team, g.away_team, g.title as game_title
       FROM payments p JOIN users u ON u.id = p.user_id JOIN games g ON g.id = p.game_id
       WHERE p.status = 'paid'
       ORDER BY p.paid_at DESC`
    );

    // 3. Prêmios a enviar (ganhadores)
    const [pendingPayouts] = await pool.query(
      `SELECT b.*, u.name as user_name, u.cpf as user_pix, u.phone as user_phone,
        g.home_team, g.away_team, g.title as game_title
       FROM bets b JOIN users u ON u.id = b.user_id JOIN games g ON g.id = b.game_id
       WHERE b.prize_amount_cents > 0 AND b.prize_paid_at IS NULL
       ORDER BY b.is_winner DESC, b.created_at DESC`
    );

    // 4. Prêmios já pagos
    const [paidPayouts] = await pool.query(
      `SELECT b.*, u.name as user_name, u.cpf as user_pix, u.phone as user_phone,
        g.home_team, g.away_team, g.title as game_title
       FROM bets b JOIN users u ON u.id = b.user_id JOIN games g ON g.id = b.game_id
       WHERE b.prize_amount_cents > 0 AND b.prize_paid_at IS NOT NULL
       ORDER BY b.prize_paid_at DESC`
    );

    const totalReceivedCents = confirmedPayments.reduce((s, p) => s + p.amount_cents, 0);
    const systemFeeRetainedCents = Math.floor(totalReceivedCents * (res.locals.systemFeePercent || 10) / 100);

    res.render('admin/pagamentos', {
      title: 'Pagamentos',
      pendingPayments,
      confirmedPayments,
      pendingPayouts,
      paidPayouts,
      totalReceivedCents,
      systemFeeRetainedCents,
      user: req.session.user,
      activePage: 'pagamentos',
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user });
  }
});

// Marcar prêmio como pago
router.post('/pagamentos/:betId/pagar', requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE bets SET prize_paid_at = NOW() WHERE id = ? AND prize_amount_cents > 0', [req.params.betId]);
    res.redirect('/admin/pagamentos');
  } catch (err) {
    res.redirect('/admin/pagamentos');
  }
});

// Copa do Mundo - listar jogos da API
router.get('/copa', requireAdmin, async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    await syncGamesFromWorldCupMatches({ forceRefresh });
    const { matches, error: apiError, cachedAt, fromCache } = await getWorldCupMatches();
    const defaultEntryFee = await getDefaultEntryFeeReais();
    const hasLive = matches?.some((m) => ['IN_PLAY', 'PAUSED', 'LIVE'].includes(m.status));

    const [existingGames] = await pool.query(
      'SELECT api_match_id FROM games WHERE api_match_id IS NOT NULL AND api_match_id != ?',
      ['']
    );
    const existingApiMatchIds = existingGames.map((g) => String(g.api_match_id));

    res.render('admin/copa', {
      title: 'Copa do Mundo 2026',
      matches,
      defaultEntryFee,
      cachedAt,
      fromCache,
      hasLive,
      existingApiMatchIds,
      user: req.session.user,
      activePage: 'copa',
      error: apiError
        || (matches === null ? 'Não foi possível buscar os jogos. Verifique FOOTBALL_API_KEY ou APISPORTS_KEY no .env' : null),
    });
  } catch (err) {
    const defaultEntryFee = await getDefaultEntryFeeReais();
    res.render('admin/copa', {
      title: 'Copa do Mundo 2026',
      matches: null,
      defaultEntryFee,
      cachedAt: null,
      fromCache: false,
      hasLive: false,
      existingApiMatchIds: [],
      user: req.session.user,
      activePage: 'copa',
      error: 'Erro: ' + err.message,
    });
  }
});

// Criar jogo a partir da Copa (individual)
router.post('/copa/create-game', requireAdmin, async (req, res) => {
  const home = translateTeamName(req.body.home_team);
  const away = translateTeamName(req.body.away_team);
  const { game_date, api_match_id, entry_fee } = req.body;
  const defaultCents = await getDefaultEntryFeeCents();
  const entryFeeCents = Math.round(parseFloat(entry_fee || defaultCents / 100) * 100);
  const title = `Copa 2026 - ${home} x ${away}`;

  try {
    if (api_match_id) {
      const [existing] = await pool.query(
        'SELECT id FROM games WHERE api_match_id = ? LIMIT 1',
        [String(api_match_id)]
      );
      if (existing.length > 0) {
        return res.redirect('/admin/copa');
      }
    }

    await pool.query(
      `INSERT INTO games (title, home_team, away_team, game_date, entry_fee_cents, api_match_id, created_by, featured)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [title, home, away, toMySQLDateTime(game_date), entryFeeCents, api_match_id || null, req.session.user.id]
    );
    res.redirect('/admin');
  } catch (err) {
    console.error('Erro ao criar jogo da Copa:', err.message);
    res.redirect('/admin/copa');
  }
});

// Criar múltiplos jogos de uma vez (bulk)
router.post('/copa/create-bulk', requireAdmin, async (req, res) => {
  // Express com urlencoded pode mandar como 'matches[]' ou 'matches'
  let matches = req.body['matches[]'] || req.body.matches || [];
  const defaultCents = await getDefaultEntryFeeCents();
  const entryFeeCents = Math.round(parseFloat(req.body.entry_fee || defaultCents / 100) * 100);

  // Se veio só um, transforma em array
  if (!Array.isArray(matches)) matches = [matches];

  // Filtra valores vazios
  matches = matches.filter(m => m && m.length > 0);

  if (matches.length === 0) {
    console.log('Bulk: nenhum jogo selecionado. Body keys:', Object.keys(req.body));
    return res.redirect('/admin/copa');
  }

  let created = 0;
  for (const raw of matches) {
    try {
      const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!m.home_team || !m.away_team || !m.game_date) continue;
      if (new Date(m.game_date).getTime() <= Date.now()) continue;

      if (m.api_match_id) {
        const [existing] = await pool.query(
          'SELECT id FROM games WHERE api_match_id = ? LIMIT 1',
          [String(m.api_match_id)]
        );
        if (existing.length > 0) continue;
      }

      const home = translateTeamName(m.home_team);
      const away = translateTeamName(m.away_team);
      const title = `Copa 2026 - ${home} x ${away}`;
      await pool.query(
        `INSERT INTO games (title, home_team, away_team, game_date, entry_fee_cents, api_match_id, created_by, featured)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [title, home, away, toMySQLDateTime(m.game_date), entryFeeCents, m.api_match_id || null, req.session.user.id]
      );
      created++;
    } catch (err) {
      // Ignora duplicados silenciosamente
      if (err.code !== 'ER_DUP_ENTRY') {
        console.error('Erro ao criar jogo bulk:', err.message);
      }
    }
  }

  console.log(`Bulk: ${created}/${matches.length} jogos criados`);
  res.redirect('/admin');
});

// Toggle destaque
router.post('/games/:id/featured', requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE games SET featured = NOT featured WHERE id = ?', [req.params.id]);
    res.redirect('/admin');
  } catch (err) {
    res.redirect('/admin');
  }
});

router.get('/games/new', requireAdmin, async (req, res) => {
  const defaultEntryFee = await getDefaultEntryFeeReais();
  res.render('admin/game-form', {
    title: 'Novo Jogo',
    game: null,
    error: null,
    defaultEntryFee,
    user: req.session.user,
  });
});

router.post('/games', requireAdmin, async (req, res) => {
  const { title, description, home_team, away_team, game_date, entry_fee, api_match_id } = req.body;
  const defaultCents = await getDefaultEntryFeeCents();
  const parsedFee = parseFloat(entry_fee);
  const entryFeeCents = Math.round((Number.isFinite(parsedFee) ? parsedFee : defaultCents / 100) * 100);

  const home = translateTeamName(home_team);
  const away = translateTeamName(away_team);

  if (!title || !home_team || !away_team || !game_date || entryFeeCents <= 0) {
    return res.render('admin/game-form', {
      title: 'Novo Jogo',
      game: req.body,
      error: 'Preencha todos os campos obrigatórios',
      defaultEntryFee: centsToReaisInput(entryFeeCents > 0 ? entryFeeCents : defaultCents),
      user: req.session.user,
    });
  }

  try {
    await pool.query(
      `INSERT INTO games (title, description, home_team, away_team, game_date, entry_fee_cents, api_match_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, description || null, home, away, toMySQLDateTime(game_date), entryFeeCents, api_match_id || null, req.session.user.id]
    );
    res.redirect('/admin');
  } catch (err) {
    res.render('admin/game-form', {
      title: 'Novo Jogo',
      game: req.body,
      error: 'Erro ao cadastrar jogo',
      defaultEntryFee: await getDefaultEntryFeeReais(),
      user: req.session.user,
    });
  }
});

router.get('/games/:id/edit', requireAdmin, async (req, res) => {
  try {
    const [games] = await pool.query('SELECT * FROM games WHERE id = ?', [req.params.id]);
    if (games.length === 0) return res.redirect('/admin');
    const defaultEntryFee = await getDefaultEntryFeeReais();
    res.render('admin/game-form', {
      title: 'Editar Jogo',
      game: games[0],
      error: null,
      defaultEntryFee,
      user: req.session.user,
    });
  } catch (err) {
    res.redirect('/admin');
  }
});

router.post('/games/:id', requireAdmin, async (req, res) => {
  const { title, description, home_team, away_team, game_date, entry_fee, api_match_id, status } = req.body;
  const entryFeeCents = Math.round(parseFloat(entry_fee || 0) * 100);
  const home = translateTeamName(home_team);
  const away = translateTeamName(away_team);

  try {
    await pool.query(
      `UPDATE games SET title=?, description=?, home_team=?, away_team=?, game_date=?,
       entry_fee_cents=?, api_match_id=?, status=? WHERE id=?`,
      [title, description, home, away, toMySQLDateTime(game_date), entryFeeCents, api_match_id || null, status, req.params.id]
    );
    res.redirect('/admin');
  } catch (err) {
    res.redirect(`/admin/games/${req.params.id}/edit`);
  }
});

router.post('/games/:id/result', requireAdmin, async (req, res) => {
  const { home_score, away_score } = req.body;
  const { processGameResults } = require('../services/prizeService');

  try {
    await pool.query(
      'UPDATE games SET home_score = ?, away_score = ?, status = ? WHERE id = ?',
      [parseInt(home_score), parseInt(away_score), 'closed', req.params.id]
    );
    await processGameResults(req.params.id);
    res.redirect(`/admin/games/${req.params.id}`);
  } catch (err) {
    res.redirect(`/admin/games/${req.params.id}`);
  }
});

router.get('/games/:id', requireAdmin, async (req, res) => {
  try {
    const [games] = await pool.query('SELECT * FROM games WHERE id = ?', [req.params.id]);
    if (games.length === 0) return res.redirect('/admin');

    const [bets] = await pool.query(
      `SELECT b.*, u.name as user_name, u.email, u.phone, u.cpf
       FROM bets b JOIN users u ON u.id = b.user_id
       WHERE b.game_id = ? ORDER BY b.is_winner DESC, b.created_at`,
      [req.params.id]
    );

    res.render('admin/game-detail', {
      title: games[0].title,
      game: games[0],
      bets,
      user: req.session.user,
    });
  } catch (err) {
    res.redirect('/admin');
  }
});

module.exports = router;
