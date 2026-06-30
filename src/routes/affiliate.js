const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  applyForAffiliate,
  getAffiliateByUserId,
  getUserDashboard,
  MILESTONES,
  FIRST_BET_COMMISSION_CENTS,
  MIN_PAYOUT_CENTS,
  normalizeCode,
} = require('../services/affiliateService');

const router = express.Router();

router.get('/afiliado', async (req, res) => {
  try {
    let affiliate = null;
    if (req.session.user) {
      affiliate = await getAffiliateByUserId(req.session.user.id);
    }

    res.render('afiliado/index', {
      title: 'Programa de Afiliados',
      affiliate,
      milestones: MILESTONES,
      firstBetCommissionCents: FIRST_BET_COMMISSION_CENTS,
      minPayoutCents: MIN_PAYOUT_CENTS,
      user: req.session.user || null,
      applied: req.query.applied === '1',
      error: req.query.error || null,
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user || null });
  }
});

router.post('/afiliado/cadastro', requireAuth, async (req, res) => {
  try {
    const preferredCode = normalizeCode(req.body.code);
    const result = await applyForAffiliate(req.session.user.id, preferredCode || null);

    if (result.error === 'already_applied') {
      return res.redirect('/painel?tab=afiliados');
    }
    if (result.error === 'pix_required') {
      return res.redirect('/afiliado?error=' + encodeURIComponent('Cadastre sua chave PIX antes (participe de um bolão ou atualize seu perfil).'));
    }

    res.redirect('/painel?applied=1&tab=afiliados');
  } catch (err) {
    res.redirect('/afiliado?error=' + encodeURIComponent('Erro ao solicitar cadastro. Tente novamente.'));
  }
});

router.get('/painel', requireAuth, async (req, res) => {
  try {
    const data = await getUserDashboard(req.session.user.id);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const affiliateLink =
      data.affiliate && data.affiliate.status === 'active'
        ? `${baseUrl}/?ref=${data.affiliate.code}`
        : null;

    res.render('painel', {
      title: 'Minha conta',
      ...data,
      affiliateLink,
      milestones: MILESTONES,
      firstBetCommissionCents: FIRST_BET_COMMISSION_CENTS,
      minPayoutCents: MIN_PAYOUT_CENTS,
      user: req.session.user,
      applied: req.query.applied === '1',
      activeTab: ['inicio', 'apostas', 'pagamentos', 'afiliados'].includes(req.query.tab)
        ? req.query.tab
        : 'inicio',
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user });
  }
});

router.get('/afiliado/painel', requireAuth, (req, res) => {
  res.redirect('/painel?tab=afiliados');
});

module.exports = router;
