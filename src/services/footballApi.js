const axios = require('axios');
const { translateTeamName } = require('../utils/teamNamesPt');

// ═══ football-data.org (principal — gratuito, 10 req/min) ═══
const FD_BASE = 'https://api.football-data.org/v4';
const FD_KEY = process.env.FOOTBALL_API_KEY || '';

// ═══ api-sports.io (alternativa — 100 req/dia no free) ═══
const AS_BASE = 'https://v3.football.api-sports.io';
const AS_KEY = process.env.APISPORTS_KEY || '';

const FD_MIN_INTERVAL_MS = 6500; // ~9 req/min (limite gratuito: 10/min)
const WC_CACHE_TTL_MS = 30 * 60 * 1000;

let fdLastRequestAt = 0;
let worldCupCache = { result: null, expiresAt: 0 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRateLimitWaitSeconds(message) {
  const match = String(message || '').match(/Wait (\d+)/i);
  return match ? parseInt(match[1], 10) : 40;
}

async function throttleFootballData() {
  const wait = Math.max(0, FD_MIN_INTERVAL_MS - (Date.now() - fdLastRequestAt));
  if (wait > 0) await sleep(wait);
  fdLastRequestAt = Date.now();
}

async function footballDataGet(url, config = {}) {
  await throttleFootballData();
  try {
    return await axios.get(url, config);
  } catch (err) {
    if (err.response?.status !== 429) throw err;
    const waitSec = parseRateLimitWaitSeconds(err.response?.data?.message);
    console.warn(`[football-data.org] Rate limit — aguardando ${waitSec}s`);
    await sleep((waitSec + 2) * 1000);
    fdLastRequestAt = Date.now();
    return axios.get(url, config);
  }
}

/**
 * Lista partidas da Copa do Mundo 2026 via football-data.org
 * Competition code: WC
 * @returns {Promise<{ matches: Array|null, error: string|null }>}
 */
async function getWorldCupMatches() {
  if (worldCupCache.result && Date.now() < worldCupCache.expiresAt) {
    return worldCupCache.result;
  }

  const errors = [];

  // Tenta football-data.org primeiro
  if (FD_KEY) {
    try {
      const res = await footballDataGet(`${FD_BASE}/competitions/WC/matches`, {
        headers: { 'X-Auth-Token': FD_KEY },
        params: { season: 2026 },
        timeout: 10000,
      });

      const matches = res.data.matches || [];
      const result = { matches: matches.map(parseFootballDataMatch), error: null };
      worldCupCache = { result, expiresAt: Date.now() + WC_CACHE_TTL_MS };
      return result;
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      const status = err.response?.status;
      console.error('[football-data.org] Erro:', status, msg);
      errors.push(`football-data.org (${status || 'erro'}): ${msg}`);

      // Se a season 2026 não existir ainda, tenta sem filtro
      if (status === 400) {
        try {
          const res2 = await footballDataGet(`${FD_BASE}/competitions/WC/matches`, {
            headers: { 'X-Auth-Token': FD_KEY },
            timeout: 10000,
          });
          const matches = res2.data.matches || [];
          const result = { matches: matches.map(parseFootballDataMatch), error: null };
          worldCupCache = { result, expiresAt: Date.now() + WC_CACHE_TTL_MS };
          return result;
        } catch (err2) {
          const msg2 = err2.response?.data?.message || err2.message;
          console.error('[football-data.org] Fallback erro:', err2.response?.status, msg2);
          errors.push(`football-data.org fallback: ${msg2}`);
        }
      }

      // Em rate limit, devolve cache antigo se existir
      if (status === 429 && worldCupCache.result?.matches) {
        return {
          matches: worldCupCache.result.matches,
          error: 'Lista em cache (API no limite de requisições). Atualiza em alguns minutos.',
        };
      }
    }
  } else {
    errors.push('FOOTBALL_API_KEY não configurada no .env');
  }

  // Fallback: api-sports.io
  if (AS_KEY) {
    try {
      const res = await axios.get(`${AS_BASE}/fixtures`, {
        headers: { 'x-apisports-key': AS_KEY },
        params: { league: 1, season: 2026 }, // league 1 = World Cup
        timeout: 10000,
      });

      const fixtures = res.data.response || [];
      return { matches: fixtures.map(parseApiSportsMatch), error: null };
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      console.error('[api-sports] Erro:', err.response?.status, msg);
      errors.push(`api-sports (${err.response?.status || 'erro'}): ${msg}`);
    }
  } else if (!FD_KEY) {
    errors.push('APISPORTS_KEY não configurada no .env');
  }

  return {
    matches: null,
    error: errors.join(' · ') || 'Não foi possível buscar os jogos.',
  };
}

function parseFootballDataMatch(m) {
  return {
    id: m.id,
    homeTeam: translateTeamName(m.homeTeam?.name || m.homeTeam?.tla || 'A definir'),
    awayTeam: translateTeamName(m.awayTeam?.name || m.awayTeam?.tla || 'A definir'),
    date: m.utcDate,
    status: m.status,
    matchday: m.matchday,
    stage: m.stage,
    group: m.group,
    homeScore: m.score?.fullTime?.home ?? null,
    awayScore: m.score?.fullTime?.away ?? null,
  };
}

function parseApiSportsMatch(f) {
  const statusMap = {
    NS: 'SCHEDULED', TBD: 'SCHEDULED',
    '1H': 'IN_PLAY', '2H': 'IN_PLAY', HT: 'PAUSED',
    FT: 'FINISHED', AET: 'FINISHED', PEN: 'FINISHED',
    PST: 'POSTPONED', CANC: 'CANCELLED',
  };

  return {
    id: f.fixture.id,
    homeTeam: translateTeamName(f.teams.home?.name || 'A definir'),
    awayTeam: translateTeamName(f.teams.away?.name || 'A definir'),
    date: f.fixture.date,
    status: statusMap[f.fixture.status?.short] || f.fixture.status?.short || 'SCHEDULED',
    matchday: f.league.round,
    stage: f.league.round?.includes('Group') ? 'GROUP_STAGE' : 'KNOCKOUT',
    group: f.league.round,
    homeScore: f.goals?.home ?? null,
    awayScore: f.goals?.away ?? null,
  };
}

/**
 * Busca resultado de uma partida específica
 */
async function getMatchResult(matchId) {
  if (!matchId) return null;

  // Tenta football-data.org
  if (FD_KEY) {
    try {
      const res = await axios.get(`${FD_BASE}/matches/${matchId}`, {
        headers: { 'X-Auth-Token': FD_KEY },
        timeout: 10000,
      });
      const m = res.data;
      const live = ['IN_PLAY', 'PAUSED', 'LIVE'].includes(m.status);
      const finished = ['FINISHED', 'AWARDED'].includes(m.status);
      if (!live && !finished) return { finished: false, live: false, status: m.status };

      const homeScore =
        m.score?.fullTime?.home ?? m.score?.regularTime?.home ?? m.score?.halfTime?.home ?? 0;
      const awayScore =
        m.score?.fullTime?.away ?? m.score?.regularTime?.away ?? m.score?.halfTime?.away ?? 0;

      return { finished, live, homeScore, awayScore, status: m.status };
    } catch (err) {
      console.error('[football-data.org] Match result erro:', err.message);
    }
  }

  // Fallback: api-sports.io
  if (AS_KEY) {
    try {
      const res = await axios.get(`${AS_BASE}/fixtures`, {
        headers: { 'x-apisports-key': AS_KEY },
        params: { id: matchId },
        timeout: 10000,
      });
      const f = res.data.response?.[0];
      if (!f) return null;
      const st = f.fixture.status?.short;
      const live = ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT'].includes(st);
      const finished = ['FT', 'AET', 'PEN'].includes(st);
      if (!live && !finished) return { finished: false, live: false, status: st };

      return {
        finished,
        live,
        homeScore: f.goals?.home ?? 0,
        awayScore: f.goals?.away ?? 0,
        status: f.fixture.status?.long || st,
      };
    } catch (err) {
      console.error('[api-sports] Match result erro:', err.message);
    }
  }

  return null;
}

module.exports = { getWorldCupMatches, getMatchResult };
