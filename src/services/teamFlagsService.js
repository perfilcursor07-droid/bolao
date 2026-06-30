const axios = require('axios');
const { TEAMS_PT } = require('../utils/teamNamesPt');

const WC26_BASE = (process.env.WORLDCUP26_API_URL || 'https://worldcup26.ir').replace(/\/$/, '');
const CACHE_MS = 24 * 60 * 60 * 1000;

const EXTRA_ALIASES = {
  'rd congo': 'democratic republic of the congo',
  'congo dr': 'democratic republic of the congo',
  'dr congo': 'democratic republic of the congo',
  'democratic republic of the congo': 'democratic republic of the congo',
  'türkiye': 'turkey',
  'turkiye': 'turkey',
  "côte d'ivoire": 'ivory coast',
  "cote d'ivoire": 'ivory coast',
  'cape verde islands': 'cape verde',
  'korea republic': 'south korea',
  'usa': 'united states',
  'ir iran': 'iran',
  'bosnia-herzegovina': 'bosnia and herzegovina',
};

let flagIndex = null;
let loadedAt = 0;
let loadingPromise = null;

function norm(name) {
  return String(name || '').trim().toLowerCase();
}

function flagUrlFromTeam(team) {
  const raw = team?.flag || '';
  if (raw) return raw.replace('/w80/', '/w40/');
  const iso = String(team?.iso2 || '').toLowerCase();
  if (!iso) return null;
  if (iso === 'sco') return 'https://flagcdn.com/w40/gb-sct.png';
  if (iso === 'eng') return 'https://flagcdn.com/w40/gb-eng.png';
  return `https://flagcdn.com/w40/${iso}.png`;
}

function buildIndexFromTeams(teams) {
  const map = {};
  for (const team of teams) {
    const flag = flagUrlFromTeam(team);
    if (!flag) continue;
    const entry = { flag, iso2: team.iso2 };
    map[norm(team.name_en)] = entry;
  }

  for (const [enKey, ptName] of Object.entries(TEAMS_PT)) {
    const entry = map[norm(enKey)];
    if (entry) map[norm(ptName)] = entry;
  }

  for (const [alias, target] of Object.entries(EXTRA_ALIASES)) {
    const entry = map[norm(target)];
    if (entry) map[norm(alias)] = entry;
  }

  return map;
}

async function fetchTeamsFromApi() {
  const res = await axios.get(`${WC26_BASE}/get/teams`, { timeout: 12000 });
  return res.data?.teams || [];
}

async function loadTeamFlags() {
  const teams = await fetchTeamsFromApi();
  flagIndex = buildIndexFromTeams(teams);
  loadedAt = Date.now();
  return flagIndex;
}

async function ensureTeamFlagsLoaded() {
  if (flagIndex && Date.now() - loadedAt < CACHE_MS) return flagIndex;
  if (!loadingPromise) {
    loadingPromise = loadTeamFlags()
      .catch((err) => {
        console.error('[teamFlags] Falha ao carregar bandeiras:', err.message);
        if (!flagIndex) flagIndex = {};
        return flagIndex;
      })
      .finally(() => {
        loadingPromise = null;
      });
  }
  return loadingPromise;
}

function getTeamFlagUrl(name) {
  if (!name || !flagIndex) return null;
  const key = norm(name);
  return flagIndex[key]?.flag || null;
}

module.exports = {
  ensureTeamFlagsLoaded,
  getTeamFlagUrl,
};
