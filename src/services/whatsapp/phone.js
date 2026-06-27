function cleanPhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/**
 * Normaliza telefone BR para formato internacional sem + (ex: 5562981013083).
 * Aceita DDD+número com ou sem 55, com ou sem 9º dígito.
 */
function normalizeBrazilPhone(phone) {
  let d = cleanPhone(phone);
  if (d.length < 10) return null;

  if (!d.startsWith('55')) {
    if (d.length === 10 || d.length === 11) {
      d = `55${d}`;
    } else if (d.length === 12 || d.length === 13) {
      d = d.startsWith('55') ? d : null;
      if (!d) return null;
    } else {
      return null;
    }
  }

  let local = d.slice(2);

  if (local.length === 10) {
    d = `55${local.slice(0, 2)}9${local.slice(2)}`;
    local = d.slice(2);
  } else if (local.length === 9 && local[2] !== '9') {
    d = `55${local.slice(0, 2)}9${local.slice(2)}`;
    local = d.slice(2);
  }

  if (local.length === 11 && local[2] === '9') {
    return d.length === 13 ? d : `55${local}`;
  }

  if (!/^55\d{11}$/.test(`55${local}`) && local.length === 11) {
    return `55${local}`;
  }

  if (/^55\d{11}$/.test(d)) {
    return d;
  }

  return null;
}

function isWhatsAppReadyPhone(phone) {
  return Boolean(normalizeBrazilPhone(phone));
}

/** Converte telefone BR para JID PN (@s.whatsapp.net). Prefer resolveRecipientJid antes de enviar. */
function phoneToJid(phone) {
  const normalized = normalizeBrazilPhone(phone);
  return normalized ? `${normalized}@s.whatsapp.net` : null;
}

function formatPhoneDisplay(phone) {
  const normalized = normalizeBrazilPhone(phone);
  const d = normalized || cleanPhone(phone);
  if (d.length === 13 && d.startsWith('55')) {
    const local = d.slice(2);
    return `+55 (${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  }
  if (d.length === 11) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  }
  return d || '—';
}

module.exports = {
  cleanPhone,
  normalizeBrazilPhone,
  isWhatsAppReadyPhone,
  phoneToJid,
  formatPhoneDisplay,
};
