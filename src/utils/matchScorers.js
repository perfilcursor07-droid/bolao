/**
 * Artilheiros da API worldcup26.ir (home_scorers / away_scorers).
 * Formato: string pseudo-JSON, ex. {"Antonio Nusa 39'","Kylian Mbappé 14'"}
 */

function parseWorldCup26Scorers(raw) {
  if (raw == null || raw === '' || String(raw).toLowerCase() === 'null') return [];

  const s = String(raw).trim();
  const items = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const text = m[1].replace(/\\"/g, '"').trim();
    if (text) items.push(text);
  }

  if (items.length === 0) {
    const reCurly = /[“"]([^”"]+)[”"]/g;
    while ((m = reCurly.exec(s)) !== null) {
      const text = m[1].trim();
      if (text) items.push(text);
    }
  }

  return items;
}

function buildMatchScorersJson(homeScorers, awayScorers) {
  const home = Array.isArray(homeScorers) ? homeScorers : [];
  const away = Array.isArray(awayScorers) ? awayScorers : [];
  if (!home.length && !away.length) return null;
  return JSON.stringify({ home, away });
}

function getMatchScorers(gameOrJson) {
  const raw = gameOrJson && typeof gameOrJson === 'object' && 'match_scorers_json' in gameOrJson
    ? gameOrJson.match_scorers_json
    : gameOrJson;

  if (!raw) return { home: [], away: [] };

  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      home: Array.isArray(parsed.home) ? parsed.home : [],
      away: Array.isArray(parsed.away) ? parsed.away : [],
    };
  } catch {
    return { home: [], away: [] };
  }
}

function hasMatchScorers(game) {
  const s = getMatchScorers(game);
  return s.home.length > 0 || s.away.length > 0;
}

/** "Kylian Mbappé 54' (p)" → { name, minute, tag } */
function parseScorerEntry(entry) {
  const text = String(entry || '').trim();
  if (!text) return { name: '', minute: '', tag: '', raw: text };

  const tagMatch = text.match(/\((OG|p|P)\)\s*$/i);
  const tag = tagMatch ? tagMatch[1].toUpperCase() : '';
  const withoutTag = tagMatch ? text.slice(0, tagMatch.index).trim() : text;

  const minuteMatch = withoutTag.match(/\s+(\d{1,3}(?:\+\d{1,2})?)'\s*$/);
  if (minuteMatch) {
    return {
      name: withoutTag.slice(0, minuteMatch.index).trim(),
      minute: minuteMatch[1],
      tag,
      raw: text,
    };
  }

  return { name: withoutTag, minute: '', tag, raw: text };
}

function formatScorerTag(tag) {
  if (tag === 'OG') return 'gol contra';
  if (tag === 'P') return 'pênalti';
  return '';
}

module.exports = {
  parseWorldCup26Scorers,
  buildMatchScorersJson,
  getMatchScorers,
  hasMatchScorers,
  parseScorerEntry,
  formatScorerTag,
};
