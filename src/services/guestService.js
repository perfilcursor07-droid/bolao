const pool = require('../config/database');

function cleanPhone(phone) {
  return (phone || '').replace(/\D/g, '');
}

function guestEmail(pixKey) {
  const safe = (pixKey || 'unknown').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50);
  return `guest_${safe}@bolao.local`;
}

function normalizePixKey(val) {
  const trimmed = (val || '').trim();
  if (!trimmed) return '';
  const digitsOnly = trimmed.replace(/\D/g, '');
  const stripped = trimmed.replace(/[\s.\-/()]/g, '');
  if (stripped === digitsOnly && digitsOnly.length >= 5) {
    return digitsOnly;
  }
  return trimmed.toLowerCase();
}

function pixKeysMatch(a, b) {
  const left = normalizePixKey(a);
  const right = normalizePixKey(b);
  return left.length > 0 && left === right;
}

async function findOrCreateParticipant({ name, phone, cpf }) {
  const pixKey = (cpf || '').trim();
  const phoneClean = cleanPhone(phone);

  if (!phoneClean || phoneClean.length < 10) {
    return { error: 'invalid_data' };
  }

  // Buscar primeiro pelo telefone (identificador principal)
  const [byPhone] = await pool.query('SELECT * FROM users WHERE phone = ?', [phoneClean]);

  if (byPhone.length > 0) {
    const user = byPhone[0];

    if (user.role === 'admin') {
      return { error: 'admin_cpf' };
    }

    // Atualizar nome e chave PIX se fornecidos
    const updates = {};
    if (name?.trim()) updates.name = name.trim();
    if (pixKey) updates.cpf = pixKey;

    if (Object.keys(updates).length > 0) {
      const sets = Object.entries(updates).map(([k]) => `${k} = ?`).join(', ');
      await pool.query(`UPDATE users SET ${sets} WHERE id = ?`, [...Object.values(updates), user.id]);
    }

    return {
      id: user.id,
      name: updates.name || user.name,
      email: user.email,
      cpf: updates.cpf || user.cpf,
      phone: phoneClean,
      role: user.role,
    };
  }

  // Buscar pela chave PIX (fallback)
  if (pixKey) {
    const [byPix] = await pool.query('SELECT * FROM users WHERE cpf = ?', [pixKey]);
    if (byPix.length > 0) {
      const user = byPix[0];
      if (user.role === 'admin') return { error: 'admin_cpf' };

      await pool.query('UPDATE users SET name = ?, phone = ? WHERE id = ?', [
        name?.trim() || user.name, phoneClean, user.id
      ]);

      return {
        id: user.id,
        name: name?.trim() || user.name,
        email: user.email,
        cpf: user.cpf,
        phone: phoneClean,
        role: user.role,
      };
    }
  }

  // Novo participante
  if (!name?.trim() || !pixKey || pixKey.length < 5) {
    return { error: 'invalid_data' };
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

module.exports = { findOrCreateParticipant, setSessionUser, cleanPhone, pixKeysMatch, normalizePixKey };
