const pool = require('../config/database');
const { normalizeBrazilPhone, cleanPhone: cleanPhoneDigits } = require('./whatsapp/phone');

function cleanPhone(phone) {
  const normalized = normalizeBrazilPhone(phone);
  if (normalized) return normalized;
  return cleanPhoneDigits(phone);
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

function pixKeysEqual(stored, incoming) {
  if (!stored || !incoming) return false;
  return normalizePixKey(stored) === normalizePixKey(incoming);
}

/** Variantes do telefone para busca (com/sem 55, normalizado). */
function phoneLookupVariants(phone) {
  const digits = cleanPhoneDigits(phone);
  if (digits.length < 10) return [];

  const variants = new Set([digits]);
  const normalized = normalizeBrazilPhone(digits);
  if (normalized) {
    variants.add(normalized);
    if (normalized.startsWith('55')) {
      variants.add(normalized.slice(2));
    }
  }
  if (!digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) {
    variants.add(`55${digits}`);
  }
  return [...variants];
}

async function findUserByPhone(phone) {
  const variants = phoneLookupVariants(phone);
  if (variants.length === 0) return null;

  const placeholders = variants.map(() => '?').join(', ');
  const [rows] = await pool.query(
    `SELECT * FROM users WHERE phone IN (${placeholders}) LIMIT 1`,
    variants
  );
  return rows[0] || null;
}

async function findUserByPixKey(pixKey) {
  const target = normalizePixKey(pixKey);
  const trimmed = (pixKey || '').trim();
  if (!target || target.length < 5) return null;

  const [rows] = await pool.query(
    `SELECT * FROM users WHERE cpf IS NOT NULL AND cpf != '' AND (cpf = ? OR cpf = ?) LIMIT 1`,
    [trimmed, target]
  );
  if (rows[0]) return rows[0];

  const [allWithPix] = await pool.query(
    `SELECT * FROM users WHERE cpf IS NOT NULL AND cpf != ''`
  );
  return allWithPix.find((u) => pixKeysEqual(u.cpf, pixKey)) || null;
}

function toParticipantUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    cpf: user.cpf,
    phone: user.phone,
    role: user.role,
  };
}

/**
 * Identifica participante para apostar — NUNCA altera cadastro existente nesta tela.
 */
async function findOrCreateParticipant({ name, phone, cpf }) {
  const pixKey = (cpf || '').trim();
  const phoneClean = cleanPhone(phone);

  if (!phoneClean || phoneClean.length < 10) {
    return { error: 'invalid_data' };
  }

  if (!pixKey || pixKey.length < 5) {
    return { error: 'invalid_data' };
  }

  const userByPhone = await findUserByPhone(phone);
  const userByPix = await findUserByPixKey(pixKey);

  if (userByPhone) {
    if (userByPhone.role === 'admin') {
      return { error: 'admin_cpf' };
    }

    if (userByPix && userByPix.id !== userByPhone.id) {
      return { error: 'pix_taken' };
    }

    if (userByPhone.cpf && !pixKeysEqual(userByPhone.cpf, pixKey)) {
      return { error: 'pix_mismatch' };
    }

    return toParticipantUser(userByPhone);
  }

  if (userByPix) {
    if (userByPix.role === 'admin') {
      return { error: 'admin_cpf' };
    }
    return { error: 'pix_taken' };
  }

  if (!name?.trim()) {
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

module.exports = {
  findOrCreateParticipant,
  findUserByPhone,
  findUserByPixKey,
  phoneLookupVariants,
  setSessionUser,
  cleanPhone,
  pixKeysMatch,
  pixKeysEqual,
  normalizePixKey,
};
