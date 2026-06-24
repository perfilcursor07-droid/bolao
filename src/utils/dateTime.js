/**
 * Converte ISO 8601 / datetime-local para DATETIME do MySQL (YYYY-MM-DD HH:MM:SS).
 */
function toMySQLDateTime(value) {
  if (!value) return value;

  const str = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) return str;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(str)) return `${str}:00`;

  const d = new Date(str);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }

  return str
    .replace('T', ' ')
    .replace(/\.\d{3}Z?$/, '')
    .replace(/Z$/, '')
    .slice(0, 19);
}

module.exports = { toMySQLDateTime };
