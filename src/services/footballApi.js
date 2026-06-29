const axios = require('axios');
const { translateTeamName } = require('../utils/teamNamesPt');
const { enrichKnockoutMatches } = require('./worldCupBracket');

// ═══ football-data.org (principal — gratuito, 10 req/min) ═══
const FD_BASE = 'https://api.football-data.org/v4';
const FD_KEY = process.env.FOOTBALL_API_KEY || '';

// ═══ api-sports.io (alternativa — 100 req/dia no free) ═══
const AS_BASE = 'https://v3.football.api-sports.io';
const AS_KEY = process.env.APISPORTS_KEY || '';

const FD_MIN_INTERVAL_MS = 6500; // ~9 req/min (limite gratuito: 10/min)
const WC_CACHE_TTL_DEFAULT_MS = 15 * 60 * 1000;
const WC_CACHE_TTL_LIVE_MS = 45 * 1000;
const WC_CACHE_TTL_TODAY_MS = 5 * 60 * 1000;
const MATCH_CACHE_FINISHED_MS = 24 * 60 * 60 * 1000;
const MATCH_CACHE_LIVE_MS = 45 * 1000;
const MATCH_CACHE_PENDING_MS = 10 * 60 * 1000;

let fdLastRequestAt = 0;
let rateLimitedUntil = 0;
let worldCupCache = { result: null, expiresAt: 0, fetchedAt: 0 };
const matchResultCache = new Map();

function extractFootballDataScores(m) {
  const ft = m.score?.fullTime;
  const rt = m.score?.regularTime;
  // REGRA DO BOLÃO: Apenas placar do tempo regulamentar (90min + acréscimos)
  // Prorrogação e pênaltis NÃO são considerados.
  // regularTime = 90min. fullTime pode incluir extra time.
  // Prioridade: regularTime > fullTime (em jogos sem prorrogação, fullTime == regularTime)
  if (rt?.home != null && rt?.away != null) return { home: rt.home, away: rt.away };
  // fallback: fullTime só se regularTime não disponível (fase de grupos não tem prorrogação)
  if (ft?.home != null && ft?.away != null) return { home: ft.home, away: ft.away };
  return { home: null, away: null };
}

function computeWorldCupCacheTtl(matches) {
  if (!matches?.length) return WC_CACHE_TTL_TODAY_MS;
  if (matches.some((m) => ['IN_PLAY', 'PAUSED', 'LIVE'].includes(m.status))) {
    return WC_CACHE_TTL_LIVE_MS;
  }
  const todayStr = new Date().toDateString();
  const hasPendingToday = matches.some((m) => {
    const d = new Date(m.date);
    return d.toDateString() === todayStr && !['FINISHED', 'AWARDED'].includes(m.status);
  });
  if (hasPendingToday) return WC_CACHE_TTL_TODAY_MS;
  return WC_CACHE_TTL_DEFAULT_MS;
}

function invalidateWorldCupCache() {
  worldCupCache.expiresAt = 0;
}

function getWorldCupCacheInfo() {
  return {
    fetchedAt: worldCupCache.fetchedAt || null,
    expiresAt: worldCupCache.expiresAt || null,
    hasData: Boolean(worldCupCache.result?.matches?.length),
  };
}

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
  if (Date.now() < rateLimitedUntil) {
    const err = new Error('RATE_LIMIT_COOLDOWN');
    err.code = 'RATE_LIMIT_COOLDOWN';
    throw err;
  }

  await throttleFootballData();
  try {
    return await axios.get(url, config);
  } catch (err) {
    if (err.response?.status !== 429) throw err;
    const waitSec = parseRateLimitWaitSeconds(err.response?.data?.message);
    rateLimitedUntil = Date.now() + (waitSec + 2) * 1000;
    console.warn(`[football-data.org] Rate limit — aguardando ${waitSec}s`);
    await sleep((waitSec + 2) * 1000);
    fdLastRequestAt = Date.now();
    return axios.get(url, config);
  }
}

function cacheMatchResult(matchId, data) {
  if (!matchId || !data) return;
  const ttl = data.finished
    ? MATCH_CACHE_FINISHED_MS
    : data.live
      ? MATCH_CACHE_LIVE_MS
      : MATCH_CACHE_PENDING_MS;
  matchResultCache.set(String(matchId), { data, expiresAt: Date.now() + ttl });
}

function getCachedMatchResult(matchId) {
  const cached = matchResultCache.get(String(matchId));
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    matchResultCache.delete(String(matchId));
    return null;
  }
  return cached.data;
}

/**
 * Lista partidas da Copa do Mundo 2026 via football-data.org
 * @param {{ forceRefresh?: boolean }} options
 */
async function getWorldCupMatches(options = {}) {
  const forceRefresh = options.forceRefresh === true;

  if (!forceRefresh && worldCupCache.result && Date.now() < worldCupCache.expiresAt) {
    return {
      ...worldCupCache.result,
      cachedAt: worldCupCache.fetchedAt,
      fromCache: true,
    };
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

      const matches = enrichKnockoutMatches((res.data.matches || []).map(parseFootballDataMatch));
      const result = { matches, error: null };
      const ttl = computeWorldCupCacheTtl(matches);
      worldCupCache = { result, expiresAt: Date.now() + ttl, fetchedAt: Date.now() };
      return { ...result, cachedAt: worldCupCache.fetchedAt, fromCache: false };
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      const status = err.response?.status;
      if (err.code !== 'RATE_LIMIT_COOLDOWN') {
        console.error('[football-data.org] Erro:', status, msg);
      }
      errors.push(`football-data.org (${status || err.code || 'erro'}): ${msg}`);

      // Se a season 2026 não existir ainda, tenta sem filtro
      if (status === 400) {
        try {
          const res2 = await footballDataGet(`${FD_BASE}/competitions/WC/matches`, {
            headers: { 'X-Auth-Token': FD_KEY },
            timeout: 10000,
          });
          const matches = enrichKnockoutMatches((res2.data.matches || []).map(parseFootballDataMatch));
          const result = { matches, error: null };
          const ttl = computeWorldCupCacheTtl(matches);
          worldCupCache = { result, expiresAt: Date.now() + ttl, fetchedAt: Date.now() };
          return { ...result, cachedAt: worldCupCache.fetchedAt, fromCache: false };
        } catch (err2) {
          const msg2 = err2.response?.data?.message || err2.message;
          console.error('[football-data.org] Fallback erro:', err2.response?.status, msg2);
          errors.push(`football-data.org fallback: ${msg2}`);
        }
      }

      if (worldCupCache.result?.matches) {
        return {
          matches: worldCupCache.result.matches,
          error: status === 429 || err.code === 'RATE_LIMIT_COOLDOWN'
            ? 'Lista em cache (API no limite). Tente em 1 minuto.'
            : errors.join(' · '),
          cachedAt: worldCupCache.fetchedAt,
          fromCache: true,
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
  const scores = extractFootballDataScores(m);
  return {
    id: m.id,
    homeTeam: translateTeamName(m.homeTeam?.name || m.homeTeam?.tla || 'A definir'),
    awayTeam: translateTeamName(m.awayTeam?.name || m.awayTeam?.tla || 'A definir'),
    date: m.utcDate,
    status: m.status,
    matchday: m.matchday,
    stage: m.stage,
    group: m.group,
    homeScore: scores.home,
    awayScore: scores.away,
  };
}

function parseApiSportsMatch(f) {
  const statusMap = {
    NS: 'SCHEDULED', TBD: 'SCHEDULED',
    '1H': 'IN_PLAY', '2H': 'IN_PLAY', HT: 'PAUSED',
    FT: 'FINISHED', AET: 'FINISHED', PEN: 'FINISHED',
    PST: 'POSTPONED', CANC: 'CANCELLED',
  };

  const st = f.fixture.status?.short;
  // REGRA: placar dos 90min. Se AET/PEN, usar score.fulltime (que é o placar dos 90min)
  let homeScore, awayScore;
  if (st === 'AET' || st === 'PEN') {
    homeScore = f.score?.fulltime?.home ?? f.goals?.home ?? null;
    awayScore = f.score?.fulltime?.away ?? f.goals?.away ?? null;
  } else {
    homeScore = f.goals?.home ?? null;
    awayScore = f.goals?.away ?? null;
  }

  return {
    id: f.fixture.id,
    homeTeam: translateTeamName(f.teams.home?.name || 'A definir'),
    awayTeam: translateTeamName(f.teams.away?.name || 'A definir'),
    date: f.fixture.date,
    status: statusMap[st] || st || 'SCHEDULED',
    matchday: f.league.round,
    stage: f.league.round?.includes('Group') ? 'GROUP_STAGE' : 'KNOCKOUT',
    group: f.league.round,
    homeScore,
    awayScore,
  };
}

/**
 * Busca resultado de uma partida específica
 * @param {string|number} matchId
 * @param {{ forceRefresh?: boolean }} [options]
 */
async function getMatchResult(matchId, options = {}) {
  if (!matchId) return null;

  if (options.forceRefresh) {
    matchResultCache.delete(String(matchId));
  } else {
    const cached = getCachedMatchResult(matchId);
    if (cached) return cached;
  }

  if (Date.now() < rateLimitedUntil) return null;

  // Tenta football-data.org
  if (FD_KEY) {
    try {
      const res = await footballDataGet(`${FD_BASE}/matches/${matchId}`, {
        headers: { 'X-Auth-Token': FD_KEY },
        timeout: 10000,
      });
      const m = res.data;
      const live = ['IN_PLAY', 'PAUSED', 'LIVE'].includes(m.status);
      const finished = ['FINISHED', 'AWARDED'].includes(m.status);
      if (!live && !finished) {
        const pending = { finished: false, live: false, status: m.status };
        cacheMatchResult(matchId, pending);
        return pending;
      }

      // Para finalizar, EXIGIR que regularTime ou fullTime tenham placar
      // Nunca usar halfTime como placar definitivo
      // REGRA: usar regularTime (90min) — fullTime pode incluir prorrogação
      const rtHome = m.score?.regularTime?.home;
      const rtAway = m.score?.regularTime?.away;
      const ftHome = rtHome ?? m.score?.fullTime?.home;
      const ftAway = rtAway ?? m.score?.fullTime?.away;

      // Se está finished mas não tem fullTime score ainda, não finalizar
      if (finished && (ftHome == null || ftAway == null)) {
        console.warn(`[getMatchResult] Jogo ${matchId} status FINISHED mas sem fullTime score — aguardando`);
        const waiting = { finished: false, live: false, status: 'WAITING_SCORE' };
        cacheMatchResult(matchId, waiting);
        return waiting;
      }

      // Se está ao vivo, usar o placar parcial só para exibição (NÃO para finalizar)
      // Prioridade: regularTime > fullTime > halfTime (para display ao vivo)
      const homeScore = ftHome ?? m.score?.halfTime?.home ?? 0;
      const awayScore = ftAway ?? m.score?.halfTime?.away ?? 0;

      const result = {
        finished: finished && ftHome != null && ftAway != null,
        live,
        homeScore,
        awayScore,
        status: m.status,
        matchMinute: null,
        matchInjuryTime: m.injuryTime ?? null
      };
      cacheMatchResult(matchId, result);
      return result;
    } catch (err) {
      if (err.code !== 'RATE_LIMIT_COOLDOWN') {
        console.error('[football-data.org] Match result erro:', err.message);
      }
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

      // REGRA: usar placar do tempo regulamentar (90min)
      // Em jogos AET/PEN, f.score.fulltime = placar dos 90min, f.goals = placar total com prorrogação
      // Em jogos FT (sem prorrogação), f.goals == f.score.fulltime
      let homeScore, awayScore;
      if (st === 'AET' || st === 'PEN') {
        // Usar fulltime (90min) e não goals (que inclui extra time)
        homeScore = f.score?.fulltime?.home ?? f.goals?.home ?? 0;
        awayScore = f.score?.fulltime?.away ?? f.goals?.away ?? 0;
      } else {
        homeScore = f.goals?.home ?? 0;
        awayScore = f.goals?.away ?? 0;
      }

      const result = {
        finished,
        live,
        homeScore,
        awayScore,
        status: st === 'HT' ? 'PAUSED' : st,
        matchMinute: f.fixture.status?.elapsed ?? null,
        matchInjuryTime: f.fixture.status?.extra ?? null,
      };
      cacheMatchResult(matchId, result);
      return result;
    } catch (err) {
      console.error('[api-sports] Match result erro:', err.message);
    }
  }

  return null;
}

module.exports = {
  getWorldCupMatches,
  getMatchResult,
  invalidateWorldCupCache,
  getWorldCupCacheInfo,
};
