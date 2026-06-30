function cleanPhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

const PHONE_COUNTRIES = [
  { code: 'BR', dial: '55', label: 'Brasil', flag: '🇧🇷', localDigits: 11 },
  { code: 'US', dial: '1', label: 'Estados Unidos', flag: '🇺🇸', localDigits: 10 },
  { code: 'PT', dial: '351', label: 'Portugal', flag: '🇵🇹', localDigits: 9 },
  { code: 'AR', dial: '54', label: 'Argentina', flag: '🇦🇷', localDigits: 10 },
  { code: 'PY', dial: '595', label: 'Paraguai', flag: '🇵🇾', localDigits: 9 },
  { code: 'UY', dial: '598', label: 'Uruguai', flag: '🇺🇾', localDigits: 8 },
  { code: 'BO', dial: '591', label: 'Bolívia', flag: '🇧🇴', localDigits: 8 },
  { code: 'GB', dial: '44', label: 'Reino Unido', flag: '🇬🇧', localDigits: 10 },
  { code: 'ES', dial: '34', label: 'Espanha', flag: '🇪🇸', localDigits: 9 },
  { code: 'IT', dial: '39', label: 'Itália', flag: '🇮🇹', localDigits: 10 },
  { code: 'DE', dial: '49', label: 'Alemanha', flag: '🇩🇪', localDigits: 11 },
  { code: 'FR', dial: '33', label: 'França', flag: '🇫🇷', localDigits: 9 },
  { code: 'JP', dial: '81', label: 'Japão', flag: '🇯🇵', localDigits: 10 },
  { code: 'MX', dial: '52', label: 'México', flag: '🇲🇽', localDigits: 10 },
  { code: 'CA', dial: '1', label: 'Canadá', flag: '🇨🇦', localDigits: 10 },
];

function getCountryByDial(dial) {
  const d = cleanPhone(dial);
  return PHONE_COUNTRIES.find((c) => c.dial === d) || PHONE_COUNTRIES[0];
}

/**
 * Normaliza telefone BR para formato internacional sem + (ex: 5563981013083).
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
  } else if (local.length === 9 && local[0] !== '9' && /^\d{2}/.test(local)) {
    d = `55${local.slice(0, 2)}9${local.slice(2)}`;
    local = d.slice(2);
  }

  if (local.length === 11 && local[2] === '9') {
    return d.length === 13 ? d : `55${local}`;
  }

  if (/^55\d{11}$/.test(d)) {
    return d;
  }

  return null;
}

/**
 * Combina código do país + número local em E.164 sem +.
 */
function normalizePhoneInput(countryDial, localPhone) {
  const dial = cleanPhone(countryDial) || '55';
  const local = cleanPhone(localPhone).replace(/^0+/, '');
  if (!local) return null;

  if (dial === '55') {
    return normalizeBrazilPhone(local) || normalizeBrazilPhone(`${dial}${local}`);
  }

  const country = getCountryByDial(dial);
  const minLen = Math.max(8, (country.localDigits || 10) - 2);
  const maxLen = country.localDigits || 12;
  if (local.length < minLen || local.length > maxLen + 2) return null;

  const full = `${dial}${local}`;
  if (full.length < 10 || full.length > 15) return null;
  return full;
}

function parsePhoneForForm(phone) {
  const digits = cleanPhone(phone);
  if (!digits) {
    return { countryDial: '55', local: '' };
  }

  const br = normalizeBrazilPhone(digits);
  if (br) {
    return { countryDial: '55', local: br.slice(2) };
  }

  const sorted = [...PHONE_COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);
  for (const c of sorted) {
    if (digits.startsWith(c.dial) && digits.length > c.dial.length + 6) {
      return { countryDial: c.dial, local: digits.slice(c.dial.length) };
    }
  }

  if (digits.length === 10 || digits.length === 11) {
    return { countryDial: '55', local: digits };
  }

  return { countryDial: '55', local: digits };
}

function isWhatsAppReadyPhone(phone) {
  const d = cleanPhone(phone);
  if (!d) return false;
  if (normalizeBrazilPhone(d)) return true;
  return d.length >= 10 && d.length <= 15;
}

function phoneToJid(phone) {
  const normalized = normalizeBrazilPhone(phone) || cleanPhone(phone);
  return normalized && normalized.length >= 10 ? `${normalized}@s.whatsapp.net` : null;
}

function formatBrazilLocalMask(localDigits) {
  const d = cleanPhone(localDigits).slice(0, 11);
  if (!d) return '';
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

function formatPhoneDisplay(phone) {
  const normalized = normalizeBrazilPhone(phone);
  const d = normalized || cleanPhone(phone);

  if (d.length === 13 && d.startsWith('55')) {
    const local = d.slice(2);
    return `+55 (${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  }

  const parsed = parsePhoneForForm(d);
  if (parsed.countryDial !== '55') {
    const c = getCountryByDial(parsed.countryDial);
    return `+${parsed.countryDial} ${parsed.local}`;
  }

  if (d.length === 11) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  }

  return d ? `+${d}` : '—';
}

module.exports = {
  cleanPhone,
  PHONE_COUNTRIES,
  getCountryByDial,
  normalizeBrazilPhone,
  normalizePhoneInput,
  parsePhoneForForm,
  isWhatsAppReadyPhone,
  phoneToJid,
  formatPhoneDisplay,
  formatBrazilLocalMask,
};
