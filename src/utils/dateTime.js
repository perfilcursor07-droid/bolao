const TZ_BR = 'America/Sao_Paulo';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function partsInBrazil(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_BR,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * Converte ISO / datetime-local para DATETIME MySQL em horário de Brasília.
 */
function toMySQLDateTime(value) {
  if (!value) return value;

  const str = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) return str;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(str)) return `${str}:00`;

  // datetime-local do admin (sem fuso) = horário Brasil
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str) && !str.endsWith('Z') && !str.includes('+')) {
    const normalized = str.replace('T', ' ').slice(0, 16);
    return normalized.length === 16 ? `${normalized}:00` : normalized;
  }

  const d = new Date(str);
  if (Number.isNaN(d.getTime())) {
    return str.replace('T', ' ').replace(/\.\d{3}Z?$/, '').replace(/Z$/, '').slice(0, 19);
  }

  const p = partsInBrazil(d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function hasExplicitTimezone(str) {
  return /Z$/i.test(str) || /[+-]\d{2}:\d{2}$/.test(str) || /[+-]\d{4}$/.test(str);
}

/**
 * Exibe data/hora do jogo em pt-BR (horário de Brasília).
 * - ISO com Z/offset (API): converte de UTC para Brasil.
 * - MySQL sem fuso (game_date): já é horário de Brasília.
 */
function formatGameDateBR(value, options = {}) {
  if (!value) return '';

  const str = String(value).trim();
  const defaults = {
    timeZone: TZ_BR,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  };

  if (hasExplicitTimezone(str)) {
    const date = new Date(str);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleString('pt-BR', { ...defaults, ...options });
    }
  }

  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    const [, y, mo, d, h, mi, se] = match;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${se || '00'}-03:00`;
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleString('pt-BR', { ...defaults, ...options });
    }
  }

  const date = new Date(str);
  if (Number.isNaN(date.getTime())) return str;
  return date.toLocaleString('pt-BR', { ...defaults, ...options });
}

/** Valor para input datetime-local (horário Brasil). */
function toDatetimeLocalBR(value) {
  if (!value) return '';
  const str = String(value).trim();
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}`;
  }
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return '';
  const p = partsInBrazil(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

module.exports = { toMySQLDateTime, formatGameDateBR, toDatetimeLocalBR, TZ_BR };
