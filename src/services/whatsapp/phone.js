function cleanPhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/** Converte telefone BR (11999998888) para JID WhatsApp. */
function phoneToJid(phone) {
  const digits = cleanPhone(phone);
  if (digits.length < 10) return null;

  let normalized = digits;
  if (normalized.length === 10 || normalized.length === 11) {
    normalized = `55${normalized}`;
  } else if (normalized.startsWith('55') && (normalized.length === 12 || normalized.length === 13)) {
    // ok
  } else if (normalized.length >= 12) {
    // internacional genérico
  } else {
    return null;
  }

  return `${normalized}@s.whatsapp.net`;
}

function formatPhoneDisplay(phone) {
  const d = cleanPhone(phone);
  if (d.length === 11) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  }
  return d || '—';
}

module.exports = { cleanPhone, phoneToJid, formatPhoneDisplay };
