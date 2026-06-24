const pool = require('../config/database');

function cleanPhone(phone) {
  return (phone || '').replace(/\D/g, '');
}

function guestEmail(pixKey) {
  // Gera um email único baseado na chave PIX
  const safe = (pixKey || 'unknown').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50);
  return `guest_${safe}@bolao.local`;
}

async function findOrCreateParticipant({ name, phone, cpf }) {
  // cpf aqui na verdade é a chave PIX (pode ser CPF, email, telefone, aleatória)
  const pixKey = (cpf || '').trim();
  const phoneClean = cleanPhone(phone);

  if (!name?.trim() || pixKey.length < 5 || phoneClean.length < 10) {
    return { error: 'invalid_data' };
  }

  const [existing] = await pool.query('SELECT * FROM users WHERE cpf = ?', [pixKey]);

  if (existing.length > 0) {
    const user = existing[0];

    if (user.role === 'admin') {
      return { error: 'admin_cpf' };
    }

    const updates = { name: name.trim(), phone: phoneClean };
    await pool.query('UPDATE users SET name = ?, phone = ? WHERE id = ?', [
      updates.name,
      updates.phone,
      user.id,
    ]);

    return {
      id: user.id,
      name: updates.name,
      email: user.email,
      cpf: user.cpf,
      phone: updates.phone,
      role: user.role,
    };
  }

  const email = guestEmail(pixKey);
  const [result] = await pool.query(
    `INSERT INTO users (name, email, password, cpf, phone, role) VALUES (?, ?, NULL, ?, ?, 'guest')`,
    [name.trim(), email, pixKey, phoneClean]
  );

  return {
    id: result.insertId,
    name: name.trim(),
    email,
    cpf: pixKey,
    phone: phoneClean,
    role: 'guest',
  };
}

function setSessionUser(req, user) {
  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isGuest: user.role === 'guest',
  };
}

module.exports = { findOrCreateParticipant, setSessionUser, cleanPhone };
