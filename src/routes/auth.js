const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { requireGuest } = require('../middleware/auth');
const { findUserByPhone, setSessionUser } = require('../services/guestService');
const { normalizePhoneInput } = require('../services/whatsapp/phone');

const router = express.Router();

function redirectAfterLogin(req, res, user) {
  setSessionUser(req, user);
  const returnTo = req.session.returnTo || (user.role === 'admin' ? '/admin' : '/painel');
  delete req.session.returnTo;
  res.redirect(returnTo);
}

function renderLogin(res, { error = null, loginTab = 'email' } = {}) {
  res.render('login', { title: 'Entrar', error, loginTab });
}

router.get('/login', requireGuest, (req, res) => {
  if (req.query.returnTo && String(req.query.returnTo).startsWith('/')) {
    req.session.returnTo = req.query.returnTo;
  }
  const loginTab = req.query.tab === 'telefone' ? 'telefone' : 'email';
  renderLogin(res, { loginTab });
});

router.post('/login', requireGuest, async (req, res) => {
  const { email, password } = req.body;
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return renderLogin(res, { error: 'E-mail ou senha inválidos' });
    }

    const user = users[0];

    if (!user.password || user.role === 'guest') {
      return renderLogin(res, {
        error: 'Esta conta é de participação rápida. Entre com seu WhatsApp ou crie uma conta com senha.',
        loginTab: 'email',
      });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return renderLogin(res, { error: 'E-mail ou senha inválidos' });
    }

    redirectAfterLogin(req, res, user);
  } catch (err) {
    renderLogin(res, { error: 'Erro ao fazer login' });
  }
});

router.post('/login/telefone', requireGuest, async (req, res) => {
  const countryDial = String(req.body.phone_country || '55').replace(/\D/g, '') || '55';
  const phoneNormalized = normalizePhoneInput(countryDial, req.body.phone);

  if (!phoneNormalized) {
    return renderLogin(res, {
      error: 'Informe um WhatsApp válido com DDD.',
      loginTab: 'telefone',
    });
  }

  try {
    const user = await findUserByPhone(phoneNormalized);
    if (!user) {
      return renderLogin(res, {
        error: 'WhatsApp não encontrado. Participe de um bolão ou crie uma conta.',
        loginTab: 'telefone',
      });
    }

    redirectAfterLogin(req, res, user);
  } catch (err) {
    renderLogin(res, { error: 'Erro ao entrar com WhatsApp', loginTab: 'telefone' });
  }
});

router.get('/register', requireGuest, (req, res) => {
  res.render('register', { title: 'Cadastrar', error: null });
});

router.post('/register', requireGuest, async (req, res) => {
  const { name, email, password, password_confirm, cpf, phone } = req.body;
  const pixKey = (cpf || '').trim();
  const cleanPhone = (phone || '').replace(/\D/g, '');

  if (!name || !email || !password || !password_confirm || pixKey.length < 5) {
    return res.render('register', { title: 'Cadastrar', error: 'Preencha todos os campos corretamente' });
  }

  if (password.length < 6) {
    return res.render('register', { title: 'Cadastrar', error: 'A senha deve ter no mínimo 6 caracteres' });
  }

  if (password !== password_confirm) {
    return res.render('register', { title: 'Cadastrar', error: 'As senhas não coincidem' });
  }

  try {
    const [existingCpf] = await pool.query('SELECT id, role FROM users WHERE cpf = ?', [pixKey]);
    if (existingCpf.length > 0 && existingCpf[0].role !== 'guest') {
      return res.render('register', { title: 'Cadastrar', error: 'Chave PIX já cadastrada. Faça login.' });
    }

    const hashed = await bcrypt.hash(password, 10);

    if (existingCpf.length > 0 && existingCpf[0].role === 'guest') {
      await pool.query(
        `UPDATE users SET name = ?, email = ?, password = ?, phone = ?, role = 'user' WHERE id = ?`,
        [name, email, hashed, cleanPhone || null, existingCpf[0].id]
      );
    } else {
      await pool.query(
        'INSERT INTO users (name, email, password, cpf, phone, role) VALUES (?, ?, ?, ?, ?, ?)',
        [name, email, hashed, pixKey, cleanPhone || null, 'user']
      );
    }

    res.redirect('/login');
  } catch (err) {
    const message = err.code === 'ER_DUP_ENTRY' ? 'E-mail ou chave PIX já cadastrada' : 'Erro ao cadastrar';
    res.render('register', { title: 'Cadastrar', error: message });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

module.exports = router;
