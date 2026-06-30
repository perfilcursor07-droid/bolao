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

/**
 * Converte relógio de parede em um fuso IANA para Date UTC.
 */
function wallClockInTimeZoneToDate(year, month, day, hour, minute, timeZone) {
  let utc = Date.UTC(year, month - 1, day, hour, minute);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  for (let i = 0; i < 6; i++) {
    const d = new Date(utc);
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    const ty = +p.year;
    const tm = +p.month;
    const td = +p.day;
    const th = +p.hour;
    const tmi = +p.minute;
    if (ty === year && tm === month && td === day && th === hour && tmi === minute) {
      return d;
    }
    utc += ((hour - th) * 60 + (minute - tmi) + (day - td) * 1440) * 60000;
  }

  return new Date(utc);
}

/** MM/DD/YYYY HH:mm interpretado em UTC → DATETIME Brasil. */
function parseUsDateAsUtcToBrazil(localDate) {
  const m = String(localDate || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const month = +m[1];
  const day = +m[2];
  const year = +m[3];
  const hour = +m[4];
  const minute = +m[5];
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return toMySQLDateTime(utc.toISOString());
}

/** MM/DD/YYYY HH:mm no fuso do estádio → DATETIME Brasil. */
function parseUsDateInZoneToBrazil(localDate, timeZone) {
  const m = String(localDate || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const month = +m[1];
  const day = +m[2];
  const year = +m[3];
  const hour = +m[4];
  const minute = +m[5];
  const utc = wallClockInTimeZoneToDate(year, month, day, hour, minute, timeZone);
  return toMySQLDateTime(utc.toISOString());
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
    timeZoneName: 'short',
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

/** Data/hora em que a aposta foi confirmada (pagamento PIX). */
function formatBetPaidAtBR(value) {
  if (!value) return '';
  return formatGameDateBR(value, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

module.exports = {
  toMySQLDateTime,
  formatGameDateBR,
  toDatetimeLocalBR,
  formatBetPaidAtBR,
  parseUsDateAsUtcToBrazil,
  parseUsDateInZoneToBrazil,
  wallClockInTimeZoneToDate,
  TZ_BR,
};
