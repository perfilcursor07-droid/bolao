const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const whatsappService = require('../services/whatsappService');

const router = express.Router();

router.use(requireAdmin);

router.get('/', async (req, res) => {
  try {
    const status = await whatsappService.getFullStatus();
    res.render('admin/whatsapp', {
      title: 'WhatsApp',
      user: req.session.user,
      activePage: 'whatsapp',
      status,
      saved: req.query.saved === '1',
      disconnected: req.query.disconnected === '1',
      error: req.query.error || null,
    });
  } catch (err) {
    res.status(500).render('error', {
      title: 'Erro',
      message: err.message,
      user: req.session.user,
    });
  }
});

router.get('/status', async (req, res) => {
  try {
    const status = await whatsappService.getFullStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/connect', async (req, res) => {
  try {
    await whatsappService.connect();
    if (req.headers.accept?.includes('application/json')) {
      return res.json({ ok: true });
    }
    res.redirect('/admin/whatsapp');
  } catch (err) {
    if (req.headers.accept?.includes('application/json')) {
      return res.status(500).json({ error: err.message });
    }
    res.redirect('/admin/whatsapp?error=' + encodeURIComponent(err.message));
  }
});

router.post('/disconnect', async (req, res) => {
  try {
    await whatsappService.disconnect();
    res.redirect('/admin/whatsapp?disconnected=1');
  } catch (err) {
    res.redirect('/admin/whatsapp?error=' + encodeURIComponent(err.message));
  }
});

router.post('/settings', async (req, res) => {
  try {
    const enabled = req.body.notifications_enabled === '1';
    await whatsappService.setNotificationsEnabled(enabled);
    res.redirect('/admin/whatsapp?saved=1');
  } catch (err) {
    res.redirect('/admin/whatsapp?error=' + encodeURIComponent(err.message));
  }
});

router.post('/test', async (req, res) => {
  try {
    const phone = req.body.phone || '';
    const message = req.body.message || '✅ Teste — Bolão Online';
    await whatsappService.sendTestMessage(phone, message);
    res.redirect('/admin/whatsapp?saved=1');
  } catch (err) {
    res.redirect('/admin/whatsapp?error=' + encodeURIComponent(err.message));
  }
});

module.exports = router;
