const pool = require('../config/database');
const {
  normalizeBrazilPhone,
  normalizePhoneInput,
  isWhatsAppReadyPhone,
  cleanPhone: cleanPhoneDigits,
} = require('./whatsapp/phone');

function cleanPhone(phone, countryDial) {
  if (countryDial) {
    const combined = normalizePhoneInput(countryDial, phone);
    if (combined) return combined;
  }
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

function normalizeParticipantName(name) {
  return (name || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Oculta chave PIX na tela (cadastro já existente). */
function maskPixKey(key) {
  const k = String(key || '').trim();
  if (!k) return '';
  if (k.includes('@')) {
    const at = k.indexOf('@');
    const local = k.slice(0, at);
    const domain = k.slice(at + 1);
    if (local.length <= 2) return `**@${domain}`;
    return `${local.slice(0, 2)}${'*'.repeat(Math.min(5, Math.max(1, local.length - 2)))}@${domain}`;
  }
  const digits = k.replace(/\D/g, '');
  if (digits.length >= 4) return `*****${digits.slice(-4)}`;
  return '*****';
}

/**
 * Identifica participante para apostar.
 * Cadastro existente: NUNCA altera nome/PIX por esta tela (proteção contra fraude).
 */
async function findOrCreateParticipant({ name, phone, cpf, phoneCountry }) {
  const pixKey = (cpf || '').trim();
  const phoneClean = cleanPhone(phone, phoneCountry);
  const displayName = normalizeParticipantName(name);

  if (!phoneClean || !isWhatsAppReadyPhone(phoneClean)) {
    return { error: 'invalid_phone' };
  }

  const userByPhone = await findUserByPhone(phoneClean);

  if (userByPhone) {
    if (userByPhone.role === 'admin') {
      return { error: 'admin_cpf' };
    }
    return toParticipantUser(userByPhone);
  }

  if (!pixKey || pixKey.length < 5) {
    return { error: 'invalid_data' };
  }

  const userByPix = await findUserByPixKey(pixKey);

  if (userByPix) {
    if (userByPix.role === 'admin') {
      return { error: 'admin_cpf' };
    }
    return { error: 'pix_taken' };
  }

  if (!displayName) {
    return { error: 'invalid_data' };
  }

  const email = guestEmail(pixKey);
  const [result] = await pool.query(
    `INSERT INTO users (name, email, password, cpf, phone, role) VALUES (?, ?, NULL, ?, ?, 'guest')`,
    [displayName, email, pixKey, phoneClean]
  );

  return {
    id: result.insertId,
    name: displayName,
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
  normalizeParticipantName,
  maskPixKey,
};
