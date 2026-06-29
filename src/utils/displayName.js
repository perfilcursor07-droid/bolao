/** Primeiro + segundo nome para exibição pública. */
function shortName(name) {
  if (!name || !String(name).trim()) return 'Participante';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Participante';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1]}`;
}

module.exports = { shortName };
