const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { requireGuest } = require('../middleware/auth');

const router = express.Router();

router.get('/login', requireGuest, (req, res) => {
  if (req.query.returnTo && String(req.query.returnTo).startsWith('/')) {
    req.session.returnTo = req.query.returnTo;
  }
  res.render('login', { title: 'Entrar', error: null });
});

router.post('/login', requireGuest, async (req, res) => {
  const { email, password } = req.body;
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.render('login', { title: 'Entrar', error: 'E-mail ou senha inválidos' });
    }

    const user = users[0];

    if (!user.password || user.role === 'guest') {
      return res.render('login', {
        title: 'Entrar',
        error: 'Esta conta é de participação rápida. Use "Participar" na página inicial ou crie uma conta com senha.',
      });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.render('login', { title: 'Entrar', error: 'E-mail ou senha inválidos' });
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isGuest: false,
    };

    const returnTo = req.session.returnTo || (user.role === 'admin' ? '/admin' : '/');
    delete req.session.returnTo;
    res.redirect(returnTo);
  } catch (err) {
    res.render('login', { title: 'Entrar', error: 'Erro ao fazer login' });
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
