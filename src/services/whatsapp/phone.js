function cleanPhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/**
 * Normaliza telefone BR para formato internacional sem + (ex: 5562981013083).
 * Trata DDD + 8 dígitos (adiciona 9) e variações com/sem 55.
 */
function normalizeBrazilPhone(phone) {
  let d = cleanPhone(phone);
  if (d.length < 10) return null;

  if (!d.startsWith('55')) {
    if (d.length === 10 || d.length === 11) {
      d = `55${d}`;
    } else {
      return null;
    }
  }

  const local = d.slice(2);
  if (local.length === 10) {
    d = `55${local.slice(0, 2)}9${local.slice(2)}`;
  } else if (local.length === 11) {
    d = `55${local}`;
  } else if (local.length === 12) {
    const ddd = local.slice(0, 2);
    const rest = local.slice(2);
    if (rest.length === 10 && rest.startsWith('9')) {
      d = `55${local}`;
    } else if (rest.length === 8) {
      d = `55${ddd}9${rest}`;
    }
  }

  if (!/^55\d{10,11}$/.test(d)) {
    return null;
  }

  return d;
}

/** Converte telefone BR para JID PN (@s.whatsapp.net). Prefer resolveRecipientJid antes de enviar. */
function phoneToJid(phone) {
  const normalized = normalizeBrazilPhone(phone);
  return normalized ? `${normalized}@s.whatsapp.net` : null;
}

function formatPhoneDisplay(phone) {
  const d = normalizeBrazilPhone(phone) || cleanPhone(phone);
  if (d.length === 13 && d.startsWith('55')) {
    const local = d.slice(2);
    return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  }
  if (d.length === 11) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  }
  return d || '—';
}

module.exports = { cleanPhone, normalizeBrazilPhone, phoneToJid, formatPhoneDisplay };
