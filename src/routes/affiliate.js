const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  applyForAffiliate,
  getAffiliateDashboard,
  getAffiliateByUserId,
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
      return res.redirect('/afiliado/painel');
    }
    if (result.error === 'pix_required') {
      return res.redirect('/afiliado?error=' + encodeURIComponent('Cadastre sua chave PIX antes (participe de um bolão ou atualize seu perfil).'));
    }

    res.redirect('/afiliado?applied=1');
  } catch (err) {
    res.redirect('/afiliado?error=' + encodeURIComponent('Erro ao solicitar cadastro. Tente novamente.'));
  }
});

router.get('/afiliado/painel', requireAuth, async (req, res) => {
  try {
    const dashboard = await getAffiliateDashboard(req.session.user.id);
    if (!dashboard) {
      return res.redirect('/afiliado');
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    res.render('afiliado/painel', {
      title: 'Painel do Afiliado',
      ...dashboard,
      affiliateLink: `${baseUrl}/?ref=${dashboard.affiliate.code}`,
      user: req.session.user,
      copied: req.query.copied === '1',
    });
  } catch (err) {
    res.status(500).render('error', { title: 'Erro', message: err.message, user: req.session.user });
  }
});

module.exports = router;
