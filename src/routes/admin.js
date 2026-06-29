const express = require('express');
const pool = require('../config/database');
const { requireAdmin } = require('../middleware/auth');
const { getWorldCupMatches } = require('../services/footballApi');
const { syncGamesFromWorldCupMatches } = require('../services/gameStatusService');
const { translateTeamName } = require('../utils/teamNamesPt');
const { toMySQLDateTime } = require('../utils/dateTime');
const { deleteGamesByIds } = require('../services/gameDelete');
const {
  findExistingGame,
  loadExistingGameKeys,
  removeSafeDuplicateGames,
  markDuplicateIds,
} = require('../services/gameDuplicateService');
const {
  getDefaultEntryFeeCents,
  getDefaultEntryFeeReais,
  setDefaultEntryFeeFromReais,
  centsToReaisInput,
} = require('../services/settingsService');

const {
  getPaymentFinanceSummary,
  enrichPayoutRow,
  PAYOUT_SELECT,
} = require('../services/prizeService');

const {
  listAffiliatesForAdmin,
  setAffiliateStatus,
  markAffiliatePayoutPaid,
} = require('../services/affiliateService');
const { normalizeBrazilPhone, formatPhoneDisplay, isWhatsAppReadyPhone } = require('../services/whatsapp/phone');
const {
  gameBetCountSubquery,
  createMarketingBet,
  createMarketingBetsBulk,
  deleteMarketingBet,
  updateMarketingBet,
  listMarketingBetsForAdmin,
  mapMarketingBetForAdmin,
  randomDisplayName,
  randomScore,
} = require('../services/marketingBetService');

const adminWhatsAppRoutes = require('./adminWhatsApp');

function apostasAdminUrl(gameId, params = {}, tab = 'real') {
  const parts = [];
  if (tab === 'marketing') parts.push('tab=marketing');
  if (gameId) parts.push(`game=${gameId}`);
  Object.entries(params).forEach(([k, v]) => parts.push(`${k}=${encodeURIComponent(v)}`));
  return parts.length ? `/admin/apostas?${parts.join('&')}` : '/admin/apostas';
}

function buildApostasGameGroups(games, betsList) {
  const gameGroups = [];
  const groupMap = new Map();
  for (const bet of betsList) {
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
        real_bet_count: 0,
        marketing_bet_count: 0,
        bet_count: 0,
        entry_fee_cents: 1000,
      };
      const group = { game: gameMeta, bets: [] };
      groupMap.set(bet.game_id, group);
      gameGroups.push(group);
    }
    groupMap.get(bet.game_id).bets.push(bet);
  }
  return gameGroups;
}

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
    const { duplicateIds, keepIds, removeIds } = markDuplicateIds(games);
    res.render('admin/partidas', {
      title: 'Partidas',
      games,
      duplicateIds,
      keepIds,
      removeIds,
      duplicateRemoveCount: removeIds.size,
      user: req.session.user,
      activePage: 'partidas',
      deleted: req.query.deleted ? parseInt(req.query.deleted, 10) : null,
      deduped: req.query.deduped ? parseInt(req.query.deduped, 10) : null,
      error: req.query.error || null,
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user });
  }
});

router.post('/partidas/dedupe', requireAdmin, async (req, res) => {
  try {
    const { deleted, skippedGroups } = await removeSafeDuplicateGames();
    if (deleted === 0 && skippedGroups > 0) {
      return res.redirect(
        '/admin/partidas?error=' +
          encodeURIComponent('Há duplicatas com apostas — remova manualmente a cópia vazia.')
      );
    }
    res.redirect(`/admin/partidas?deduped=${deleted}`);
  } catch (err) {
    console.error('Erro ao deduplicar partidas:', err.message);
    res.redirect('/admin/partidas?error=' + encodeURIComponent(err.message));
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
        g.entry_fee_cents,
        (SELECT COUNT(*) FROM bets b WHERE b.game_id = g.id) as real_bet_count,
        (SELECT COUNT(*) FROM marketing_bets mb WHERE mb.game_id = g.id) as marketing_bet_count,
        ${gameBetCountSubquery('g')} as bet_count
       FROM games g
       ORDER BY g.game_date DESC`
    );

    const selectedGameId = req.query.game ? parseInt(req.query.game, 10) : null;
    const validGameId = selectedGameId && games.some((g) => g.id === selectedGameId) ? selectedGameId : null;
    const activeTab = req.query.tab === 'marketing' ? 'marketing' : 'real';

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

    const [realBets] = await pool.query(betsSql, params);

    const marketingRows = await listMarketingBetsForAdmin({ gameId: validGameId || undefined });
    const marketingBets = marketingRows.map(mapMarketingBetForAdmin);

    const gameGroupsReal = buildApostasGameGroups(games, realBets);
    const gameGroupsMarketing = buildApostasGameGroups(games, marketingBets);
    const gameGroups = activeTab === 'marketing' ? gameGroupsMarketing : gameGroupsReal;
    const bets = activeTab === 'marketing' ? marketingBets : realBets;

    const statsReal = {
      total: realBets.length,
      winners: realBets.filter((b) => b.is_winner).length,
      waiting: realBets.filter((b) => !b.is_winner && b.game_status !== 'finished').length,
      lost: realBets.filter((b) => !b.is_winner && b.game_status === 'finished').length,
    };

    const statsMarketing = {
      total: marketingBets.length,
      totalCents: marketingBets.reduce((sum, b) => sum + (b.amount_cents || 0), 0),
    };

    res.render('admin/apostas', {
      title: 'Apostas',
      games,
      bets,
      realBets,
      marketingBets,
      gameGroups,
      gameGroupsReal,
      gameGroupsMarketing,
      activeTab,
      selectedGameId: validGameId,
      defaultGameId: validGameId,
      openGames: games.filter((g) => g.status !== 'finished'),
      statsReal,
      statsMarketing,
      user: req.session.user,
      activePage: 'apostas',
      saved: req.query.saved === '1',
      marketingSaved: req.query.marketing_saved === '1',
      marketingCount: req.query.marketing_count ? parseInt(req.query.marketing_count, 10) : 0,
      marketingDeleted: req.query.marketing_deleted === '1',
      error: req.query.error || null,
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user });
  }
});

router.post('/apostas/marketing', requireAdmin, async (req, res) => {
  const appendQuery = (gameId, params) => apostasAdminUrl(gameId, params, 'marketing');

  try {
    const gameId = parseInt(req.body.game_id, 10);
    const quantity = Math.min(50, Math.max(1, parseInt(req.body.quantity, 10) || 1));
    const amountReais = parseFloat(String(req.body.amount_reais || '').replace(',', '.'));
    let amountCents = Number.isFinite(amountReais) ? Math.round(amountReais * 100) : NaN;

    if (quantity > 1) {
      const result = await createMarketingBetsBulk({ gameId, quantity, amountCents });
      if (result.error) {
        return res.redirect(appendQuery(gameId, { error: result.error }));
      }
      return res.redirect(appendQuery(gameId, { marketing_saved: '1', marketing_count: String(result.count) }));
    }

    const home = parseInt(req.body.home_score, 10);
    const away = parseInt(req.body.away_score, 10);
    const displayName = String(req.body.display_name || '').trim();
    const useRandom = req.body.random_single === '1' || !displayName;

    let result;
    if (useRandom) {
      const score = randomScore();
      if (!Number.isFinite(amountCents)) {
        const [games] = await pool.query('SELECT entry_fee_cents FROM games WHERE id = ?', [gameId]);
        amountCents = games[0]?.entry_fee_cents;
      }
      result = await createMarketingBet({
        gameId,
        displayName: randomDisplayName(),
        home: score.home,
        away: score.away,
        amountCents,
      });
    } else {
      if (!Number.isFinite(amountCents)) {
        const [games] = await pool.query('SELECT entry_fee_cents FROM games WHERE id = ?', [gameId]);
        amountCents = games[0]?.entry_fee_cents;
      }
      result = await createMarketingBet({
        gameId,
        displayName,
        home,
        away,
        amountCents,
      });
    }

    if (result.error) {
      return res.redirect(appendQuery(gameId, { error: result.error }));
    }

    res.redirect(appendQuery(gameId, { marketing_saved: '1', marketing_count: '1' }));
  } catch (err) {
    const gameId = req.body.game_id ? parseInt(req.body.game_id, 10) : null;
    res.redirect(appendQuery(gameId, { error: err.message }));
  }
});

router.post('/apostas/marketing/:id/editar', requireAdmin, async (req, res) => {
  const appendQuery = (gameId, params) => apostasAdminUrl(gameId, params, 'marketing');

  try {
    const id = parseInt(req.params.id, 10);
    const gameId = req.body.game_id ? parseInt(req.body.game_id, 10) : null;
    const home = parseInt(req.body.home_score, 10);
    const away = parseInt(req.body.away_score, 10);
    const amountReais = parseFloat(String(req.body.amount_reais || '').replace(',', '.'));
    const amountCents = Number.isFinite(amountReais) ? Math.round(amountReais * 100) : NaN;

    const result = await updateMarketingBet(id, {
      displayName: req.body.display_name,
      home,
      away,
      amountCents,
    });

    if (result.error) {
      return res.redirect(appendQuery(gameId, { error: result.error }));
    }

    res.redirect(appendQuery(gameId, { marketing_saved: '1' }));
  } catch (err) {
    const gameId = req.body.game_id ? parseInt(req.body.game_id, 10) : null;
    res.redirect(appendQuery(gameId, { error: err.message }));
  }
});

router.post('/apostas/marketing/:id/excluir', requireAdmin, async (req, res) => {
  const appendQuery = (gameId, params) => apostasAdminUrl(gameId, params, 'marketing');

  try {
    const id = parseInt(req.params.id, 10);
    const gameId = req.body.game_id ? parseInt(req.body.game_id, 10) : null;
    const ok = await deleteMarketingBet(id);
    if (!ok) {
      return res.redirect(appendQuery(gameId, { error: 'Aposta marketing não encontrada' }));
    }
    res.redirect(appendQuery(gameId, { marketing_deleted: '1' }));
  } catch (err) {
    const gameId = req.body.game_id ? parseInt(req.body.game_id, 10) : null;
    res.redirect(appendQuery(gameId, { error: err.message }));
  }
});

router.get('/apostas/marketing/random', requireAdmin, (req, res) => {
  const score = randomScore();
  res.json({
    name: randomDisplayName(),
    home: score.home,
    away: score.away,
  });
});

router.post('/apostas/:id/editar', requireAdmin, async (req, res) => {
  const appendQuery = (gameId, params) => apostasAdminUrl(gameId, params, 'real');

  try {
    const betId = parseInt(req.params.id, 10);
    const home = parseInt(req.body.home_score, 10);
    const away = parseInt(req.body.away_score, 10);
    const returnGameId = req.body.game_id ? parseInt(req.body.game_id, 10) : null;

    if (!Number.isFinite(betId) || !Number.isFinite(home) || !Number.isFinite(away)) {
      return res.redirect(appendQuery(returnGameId, { error: 'Placar inválido' }));
    }
    if (home < 0 || away < 0 || home > 20 || away > 20) {
      return res.redirect(appendQuery(returnGameId, { error: 'Use placares entre 0 e 20' }));
    }

    const [rows] = await pool.query(
      `SELECT b.id, b.game_id, g.status as game_status
       FROM bets b JOIN games g ON g.id = b.game_id WHERE b.id = ?`,
      [betId]
    );
    if (rows.length === 0) {
      return res.redirect(appendQuery(returnGameId, { error: 'Aposta não encontrada' }));
    }

    const bet = rows[0];
    if (bet.game_status === 'finished') {
      return res.redirect(
        appendQuery(returnGameId || bet.game_id, { error: 'Não é possível editar palpite de jogo finalizado' })
      );
    }

    await pool.query(
      'UPDATE bets SET home_score_prediction = ?, away_score_prediction = ? WHERE id = ?',
      [home, away, betId]
    );

    res.redirect(appendQuery(returnGameId || bet.game_id, { saved: '1' }));
  } catch (err) {
    const gid = req.body.game_id ? parseInt(req.body.game_id, 10) : null;
    res.redirect(appendQuery(gid, { error: err.message }));
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
    const usersWithPhone = users.map((u) => ({
      ...u,
      phone_display: u.phone ? formatPhoneDisplay(u.phone) : '—',
      phone_whatsapp_ok: u.phone ? isWhatsAppReadyPhone(u.phone) : false,
      phone_normalized: u.phone ? normalizeBrazilPhone(u.phone) : null,
    }));

    res.render('admin/usuarios', {
      title: 'Usuários',
      users: usersWithPhone,
      user: req.session.user,
      activePage: 'usuarios',
      saved: req.query.saved === '1',
      error: req.query.error || null,
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user });
  }
});

router.post('/usuarios/:id/editar', requireAdmin, async (req, res) => {
  const appendQuery = (params) => {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    return `/admin/usuarios?${qs}`;
  };

  try {
    const userId = parseInt(req.params.id, 10);
    const name = String(req.body.name || '').trim();
    const phoneRaw = String(req.body.phone || '').trim();
    const cpf = String(req.body.cpf || '').trim();

    if (!Number.isFinite(userId) || !name || name.length < 2) {
      return res.redirect(appendQuery({ error: 'Nome inválido' }));
    }

    const phone = normalizeBrazilPhone(phoneRaw);
    if (!phone) {
      return res.redirect(appendQuery({ error: 'Telefone inválido — use DDD + número (ex: 63981013083)' }));
    }

    if (!cpf || cpf.length < 5) {
      return res.redirect(appendQuery({ error: 'Chave PIX inválida' }));
    }

    const cpfStored = cpf.includes('@')
      ? cpf
      : (() => {
          const digits = cpf.replace(/\D/g, '');
          return digits.length >= 5 ? digits : cpf;
        })();

    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (rows.length === 0) {
      return res.redirect(appendQuery({ error: 'Usuário não encontrado' }));
    }

    const target = rows[0];
    if (target.role === 'admin' && target.id !== req.session.user.id) {
      return res.redirect(appendQuery({ error: 'Não é permitido editar outro administrador' }));
    }

    const [phoneDup] = await pool.query('SELECT id FROM users WHERE phone = ? AND id != ?', [phone, userId]);
    if (phoneDup.length > 0) {
      return res.redirect(appendQuery({ error: 'Telefone já usado por outro usuário' }));
    }

    const [cpfDup] = await pool.query('SELECT id FROM users WHERE cpf = ? AND id != ?', [cpfStored, userId]);
    if (cpfDup.length > 0) {
      return res.redirect(appendQuery({ error: 'Chave PIX já usada por outro usuário' }));
    }

    await pool.query('UPDATE users SET name = ?, phone = ?, cpf = ? WHERE id = ?', [
      name,
      phone,
      cpfStored,
      userId,
    ]);

    res.redirect(appendQuery({ saved: '1' }));
  } catch (err) {
    res.redirect(appendQuery({ error: err.message }));
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

    const [pendingPayoutRows] = await pool.query(
      `${PAYOUT_SELECT}
       WHERE b.prize_amount_cents > 0 AND b.prize_paid_at IS NULL
       ORDER BY b.is_winner DESC, b.created_at DESC`
    );

    const [paidPayoutRows] = await pool.query(
      `${PAYOUT_SELECT}
       WHERE b.prize_amount_cents > 0 AND b.prize_paid_at IS NOT NULL
       ORDER BY b.prize_paid_at DESC`
    );

    const pendingPayouts = pendingPayoutRows.map(enrichPayoutRow);
    const paidPayouts = paidPayoutRows.map(enrichPayoutRow);
    const finance = await getPaymentFinanceSummary();

    res.render('admin/pagamentos', {
      title: 'Pagamentos',
      pendingPayments,
      confirmedPayments,
      pendingPayouts,
      paidPayouts,
      finance,
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

    const { apiMatchIds: existingApiMatchIds, fingerprints: existingFingerprints } =
      await loadExistingGameKeys();

    res.render('admin/copa', {
      title: 'Copa do Mundo 2026',
      matches,
      defaultEntryFee,
      cachedAt,
      fromCache,
      hasLive,
      existingApiMatchIds,
      existingFingerprints,
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
      existingFingerprints: [],
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
      const existing = await findExistingGame({
        apiMatchId: api_match_id,
        homeTeam: home,
        awayTeam: away,
        gameDate: game_date,
      });
      if (existing) {
        return res.redirect('/admin/copa');
      }
    } else {
      const existing = await findExistingGame({ homeTeam: home, awayTeam: away, gameDate: game_date });
      if (existing) return res.redirect('/admin/copa');
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

      const home = translateTeamName(m.home_team);
      const away = translateTeamName(m.away_team);

      const existing = await findExistingGame({
        apiMatchId: m.api_match_id,
        homeTeam: home,
        awayTeam: away,
        gameDate: m.game_date,
      });
      if (existing) continue;

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
    const existing = await findExistingGame({
      apiMatchId: api_match_id,
      homeTeam: home,
      awayTeam: away,
      gameDate: game_date,
    });
    if (existing) {
      return res.render('admin/game-form', {
        title: 'Novo Jogo',
        game: req.body,
        error: 'Já existe um bolão para esta partida e horário.',
        defaultEntryFee: centsToReaisInput(entryFeeCents),
        user: req.session.user,
      });
    }

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
    const [betRows] = await pool.query('SELECT COUNT(*) AS c FROM bets WHERE game_id = ?', [req.params.id]);
    res.render('admin/game-form', {
      title: 'Editar Jogo',
      game: games[0],
      betCount: betRows[0].c,
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
  let entryFeeCents = Math.round(parseFloat(entry_fee || 0) * 100);
  const home = translateTeamName(home_team);
  const away = translateTeamName(away_team);

  try {
    const [betRows] = await pool.query(
      'SELECT COUNT(*) AS c FROM bets WHERE game_id = ?',
      [req.params.id]
    );
    const hasBets = betRows[0].c > 0;

    if (hasBets) {
      const [current] = await pool.query('SELECT entry_fee_cents FROM games WHERE id = ?', [req.params.id]);
      if (current.length > 0) {
        entryFeeCents = current[0].entry_fee_cents;
      }
    }

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

// Afiliados
router.get('/afiliados', requireAdmin, async (req, res) => {
  try {
    const affiliates = await listAffiliatesForAdmin();
    res.render('admin/afiliados', {
      title: 'Afiliados',
      affiliates,
      user: req.session.user,
      activePage: 'afiliados',
      paid: req.query.paid ? parseInt(req.query.paid, 10) : null,
      updated: req.query.updated || null,
      error: req.query.error || null,
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user });
  }
});

router.post('/afiliados/:id/status', requireAdmin, async (req, res) => {
  try {
    const status = req.body.status;
    await setAffiliateStatus(req.params.id, status);
    res.redirect('/admin/afiliados?updated=' + encodeURIComponent(status));
  } catch (err) {
    res.redirect('/admin/afiliados?error=' + encodeURIComponent(err.message));
  }
});

router.post('/afiliados/:id/pagar', requireAdmin, async (req, res) => {
  try {
    const result = await markAffiliatePayoutPaid(req.params.id);
    if (result.error) {
      return res.redirect('/admin/afiliados?error=' + encodeURIComponent(result.error));
    }
    res.redirect(`/admin/afiliados?paid=${result.paid}`);
  } catch (err) {
    res.redirect('/admin/afiliados?error=' + encodeURIComponent(err.message));
  }
});

router.use('/whatsapp', adminWhatsAppRoutes);

module.exports = router;
