const axios = require('axios');
const { translateTeamName } = require('../utils/teamNamesPt');
const { enrichKnockoutMatches } = require('./worldCupBracket');
const {
  isWorldCup26Enabled,
  fetchWorldCup26Games,
  fetchWorldCup26LiveMatches,
  getWorldCup26MatchResult,
  invalidateWorldCup26Cache,
  getWorldCup26CacheInfo,
} = require('./worldcup26Api');

// ═══ api-sports.io (PRINCIPAL — melhor para live, 100 req/dia free) ═══
// score.fulltime = placar dos 90 minutos
// score.extratime = gols na prorrogação
// score.penalty = pênaltis
// goals = total incluindo tudo
// REGRA DO BOLÃO: usar score.fulltime (90min + acréscimos)
const AS_BASE = 'https://v3.football.api-sports.io';
const AS_KEY = process.env.APISPORTS_KEY || '';

// ═══ football-data.org (FALLBACK — 10 req/min free) ═══
// regularTime = placar dos 90 minutos
// fullTime = pode incluir prorrogação + pênaltis!
// REGRA DO BOLÃO: usar regularTime primeiro
const FD_BASE = 'https://api.football-data.org/v4';
const FD_KEY = process.env.FOOTBALL_API_KEY || '';

const FD_MIN_INTERVAL_MS = 6500; // ~9 req/min (limite gratuito: 10/min)
const WC_CACHE_TTL_DEFAULT_MS = 15 * 60 * 1000;
const WC_CACHE_TTL_LIVE_MS = 20 * 1000;
const WC_CACHE_TTL_TODAY_MS = 5 * 60 * 1000;
const MATCH_CACHE_FINISHED_MS = 24 * 60 * 60 * 1000;
const MATCH_CACHE_LIVE_MS = 20 * 1000;
const MATCH_CACHE_PENDING_MS = 10 * 60 * 1000;

const WC_SEASON = 2026;
const WC_LEAGUE_AS = 1;

let fdLastRequestAt = 0;
let rateLimitedUntil = 0;
let worldCupCache = { result: null, expiresAt: 0, fetchedAt: 0 };
const matchResultCache = new Map();
let liveFixturesCache = { matches: null, expiresAt: 0 };
let fdLiveFixturesCache = { matches: null, expiresAt: 0 };
/** null = ainda não testado; true/false após primeira busca da Copa 2026 na API-Football */
let asWc2026Available = null;

function isApiSportsWorldCupFixture(f) {
  return f?.league?.id === WC_LEAGUE_AS && Number(f.league?.season) === WC_SEASON;
}

function useApiSportsForWc2026() {
  return Boolean(AS_KEY && asWc2026Available === true);
}

function getFootballApiStatus() {
  if (isWorldCup26Enabled()) {
    return {
      primary: 'worldcup26',
      label: 'worldcup26.ir (Copa 2026 ao vivo)',
      hasApiSports: Boolean(AS_KEY),
      hasFootballData: Boolean(FD_KEY),
      hasWorldCup26: true,
      wc2026Source: 'worldcup26',
    };
  }
  if (useApiSportsForWc2026()) {
    return {
      primary: 'api-sports',
      label: 'API-Football (api-sports.io)',
      hasApiSports: true,
      hasFootballData: Boolean(FD_KEY),
      wc2026Source: 'api-sports',
    };
  }
  if (FD_KEY) {
    const note = AS_KEY && asWc2026Available === false
      ? 'API-Football ainda sem Copa 2026 — usando football-data.org'
      : null;
    return {
      primary: 'football-data',
      label: 'football-data.org (Copa 2026 ao vivo)',
      hasApiSports: Boolean(AS_KEY),
      hasFootballData: true,
      wc2026Source: 'football-data',
      note,
    };
  }
  if (AS_KEY) {
    return {
      primary: 'api-sports',
      label: 'API-Football (aguardando dados Copa 2026)',
      hasApiSports: true,
      hasFootballData: false,
      wc2026Source: 'pending',
    };
  }
  return { primary: 'none', label: 'Nenhuma API configurada', hasApiSports: false, hasFootballData: false, wc2026Source: 'none' };
}

function normalizeTeamKey(name) {
  return translateTeamName(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function fixturePairKey(home, away) {
  return `${normalizeTeamKey(home)}|${normalizeTeamKey(away)}`;
}

function parsedMatchToResult(parsed) {
  if (!parsed) return null;
  const live = ['IN_PLAY', 'PAUSED', 'LIVE'].includes(parsed.status);
  const finished = ['FINISHED', 'AWARDED'].includes(parsed.status);
  const paused = parsed.status === 'PAUSED' || parsed.statusDetail === 'HT';

  return {
    finished,
    live,
    homeScore: parsed.homeScore,
    awayScore: parsed.awayScore,
    status: paused ? 'PAUSED' : parsed.statusDetail || parsed.status,
    matchMinute: parsed.minute ?? null,
    matchInjuryTime: parsed.injuryTime ?? null,
    fixtureId: parsed.id,
  };
}

function findParsedMatchForGame(game, matches) {
  if (!game || !matches?.length) return null;
  const key = fixturePairKey(game.home_team, game.away_team);
  return matches.find((m) => fixturePairKey(m.homeTeam, m.awayTeam) === key) || null;
}

/**
 * Jogos ao vivo da Copa — API-Football (só quando há dados da Copa 2026).
 */
async function fetchApiSportsLiveFixtures(options = {}) {
  if (!useApiSportsForWc2026()) return [];

  if (!options.forceRefresh && liveFixturesCache.matches && Date.now() < liveFixturesCache.expiresAt) {
    return liveFixturesCache.matches;
  }

  try {
    const res = await axios.get(`${AS_BASE}/fixtures`, {
      headers: { 'x-apisports-key': AS_KEY },
      params: { league: WC_LEAGUE_AS, season: WC_SEASON, live: 'all' },
      timeout: 12000,
    });
    const matches = (res.data.response || []).map(parseApiSportsMatch);
    liveFixturesCache = { matches, expiresAt: Date.now() + MATCH_CACHE_LIVE_MS };
    return matches;
  } catch (err) {
    console.error('[api-sports] live=all erro:', err.response?.status, err.response?.data?.message || err.message);
    return liveFixturesCache.matches || [];
  }
}

/**
 * Jogos ao vivo da Copa 2026 — football-data.org (1 request, ~20s cache).
 */
async function fetchFootballDataLiveFixtures(options = {}) {
  if (!FD_KEY) return [];

  if (!options.forceRefresh && fdLiveFixturesCache.matches && Date.now() < fdLiveFixturesCache.expiresAt) {
    return fdLiveFixturesCache.matches;
  }

  try {
    const res = await footballDataGet(`${FD_BASE}/competitions/WC/matches`, {
      headers: { 'X-Auth-Token': FD_KEY },
      params: { season: WC_SEASON, status: 'IN_PLAY,PAUSED,LIVE' },
      timeout: 12000,
    });
    const matches = (res.data.matches || []).map(parseFootballDataMatch);
    fdLiveFixturesCache = { matches, expiresAt: Date.now() + MATCH_CACHE_LIVE_MS };
    return matches;
  } catch (err) {
    if (err.code !== 'RATE_LIMIT_COOLDOWN') {
      console.error('[football-data.org] live erro:', err.response?.status, err.response?.data?.message || err.message);
    }
    return fdLiveFixturesCache.matches || [];
  }
}

/**
 * Lista unificada de jogos ao vivo (prioriza API com dados da Copa 2026).
 */
async function fetchLiveWorldCupFixtures(options = {}) {
  if (isWorldCup26Enabled()) {
    const { matches } = await fetchWorldCup26LiveMatches(options);
    if (matches) return matches;
  }
  const asLive = await fetchApiSportsLiveFixtures(options);
  if (asLive.length > 0) return asLive;
  return fetchFootballDataLiveFixtures(options);
}

/**
 * Busca resultado para um bolão local (por ID ou por nomes dos times ao vivo).
 */
async function getMatchResultForGame(game, options = {}) {
  if (!game) return null;

  const liveMatches = await fetchLiveWorldCupFixtures({ forceRefresh: options.forceRefresh });
  const fromLive = findParsedMatchForGame(game, liveMatches);
  if (fromLive) return parsedMatchToResult(fromLive);

  if (game.api_match_id) {
    return getMatchResult(game.api_match_id, options);
  }

  return null;
}

function extractFootballDataScores(m) {
  const rt = m.score?.regularTime;
  const ft = m.score?.fullTime;
  const duration = m.score?.duration;
  // REGRA DO BOLÃO: placar dos 90 minutos APENAS
  // regularTime = 90min exatos (disponível na v4 da football-data.org)
  // fullTime = pode incluir prorrogação + pênaltis!
  if (rt?.home != null && rt?.away != null) return { home: rt.home, away: rt.away };
  // Se duration = REGULAR, fullTime == regularTime (sem prorrogação)
  if (duration === 'REGULAR' && ft?.home != null && ft?.away != null) return { home: ft.home, away: ft.away };
  // Se não tem regularTime E tem prorrogação, não retornar score (evitar erro)
  if (duration === 'EXTRA_TIME' || duration === 'PENALTY_SHOOTOUT') return { home: null, away: null };
  // Fallback para fase de grupos (nunca tem prorrogação)
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
  liveFixturesCache.expiresAt = 0;
  fdLiveFixturesCache.expiresAt = 0;
  invalidateWorldCup26Cache();
}

function getWorldCupCacheInfo() {
  if (isWorldCup26Enabled()) {
    return getWorldCup26CacheInfo();
  }
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
 * Lista partidas da Copa do Mundo 2026 via api-sports.io (principal) ou football-data.org (fallback)
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

  // PRINCIPAL: worldcup26.ir — Copa 2026 pública, sem API key
  if (isWorldCup26Enabled()) {
    try {
      const wc26 = await fetchWorldCup26Games({ forceRefresh });
      if (wc26.matches?.length) {
        const matches = enrichKnockoutMatches(wc26.matches);
        const result = { matches, error: wc26.error || null };
        return {
          ...result,
          cachedAt: wc26.fetchedAt,
          fromCache: wc26.fromCache,
        };
      }
      if (wc26.error) errors.push(`worldcup26.ir: ${wc26.error}`);
    } catch (err) {
      errors.push(`worldcup26.ir: ${err.message}`);
    }
  }

  // FALLBACK: api-sports.io (dados melhores ao vivo, score.fulltime separado)
  if (AS_KEY) {
    try {
      const res = await axios.get(`${AS_BASE}/fixtures`, {
        headers: { 'x-apisports-key': AS_KEY },
        params: { league: 1, season: 2026 }, // league 1 = World Cup
        timeout: 12000,
      });

      const fixtures = res.data.response || [];
      if (fixtures.length > 0) {
        asWc2026Available = true;
        const matches = enrichKnockoutMatches(fixtures.map(parseApiSportsMatch));
        const result = { matches, error: null };
        const ttl = computeWorldCupCacheTtl(matches);
        worldCupCache = { result, expiresAt: Date.now() + ttl, fetchedAt: Date.now() };
        return { ...result, cachedAt: worldCupCache.fetchedAt, fromCache: false };
      }
      asWc2026Available = false;
      errors.push('api-sports: 0 fixtures Copa 2026 — usando football-data.org');
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      console.error('[api-sports] Erro:', err.response?.status, msg);
      errors.push(`api-sports (${err.response?.status || 'erro'}): ${msg}`);
    }
  }

  // FALLBACK: football-data.org
  if (FD_KEY) {
    try {
      const res = await footballDataGet(`${FD_BASE}/competitions/WC/matches`, {
        headers: { 'X-Auth-Token': FD_KEY },
        params: { season: 2026 },
        timeout: 10000,
      });

      const matches = enrichKnockoutMatches((res.data.matches || []).map(parseFootballDataMatch));
      if (AS_KEY && asWc2026Available === null) asWc2026Available = false;
      const result = { matches, error: null };
      const ttl = computeWorldCupCacheTtl(matches);
      worldCupCache = { result, expiresAt: Date.now() + ttl, fetchedAt: Date.now() };
      return { ...result, cachedAt: worldCupCache.fetchedAt, fromCache: false };
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      if (err.code !== 'RATE_LIMIT_COOLDOWN') {
        console.error('[football-data.org] Erro:', err.response?.status, msg);
      }
      errors.push(`football-data.org (${err.response?.status || err.code || 'erro'}): ${msg}`);

      if (err.response?.status === 400) {
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
          errors.push(`football-data.org fallback: ${err2.message}`);
        }
      }

      // Retorna cache se existir
      if (worldCupCache.result?.matches) {
        return {
          matches: worldCupCache.result.matches,
          error: errors.join(' · '),
          cachedAt: worldCupCache.fetchedAt,
          fromCache: true,
        };
      }
    }
  }

  if (!AS_KEY && !FD_KEY) {
    errors.push('Nenhuma API key configurada no .env (APISPORTS_KEY ou FOOTBALL_API_KEY)');
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
    statusDetail: m.status === 'PAUSED' ? 'HT' : m.status,
    matchday: m.matchday,
    stage: m.stage,
    group: m.group,
    homeScore: scores.home,
    awayScore: scores.away,
    minute: m.minute ?? null,
    injuryTime: m.injuryTime ?? null,
  };
}

function parseApiSportsMatch(f) {
  const statusMap = {
    NS: 'SCHEDULED', TBD: 'SCHEDULED',
    '1H': 'IN_PLAY', '2H': 'IN_PLAY', HT: 'PAUSED',
    FT: 'FINISHED', AET: 'FINISHED', PEN: 'FINISHED',
    ET: 'IN_PLAY', BT: 'PAUSED', P: 'IN_PLAY',
    PST: 'POSTPONED', CANC: 'CANCELLED',
    AWD: 'FINISHED', WO: 'FINISHED',
  };

  const st = f.fixture.status?.short;
  // REGRA DO BOLÃO: placar dos 90min APENAS
  // score.fulltime = placar ao final dos 90 minutos
  // goals = total incluindo extra time e pênaltis
  let homeScore, awayScore;
  if (st === 'AET' || st === 'PEN') {
    // Prorrogação/Pênaltis — usar score.fulltime (= 90 minutos)
    homeScore = f.score?.fulltime?.home ?? null;
    awayScore = f.score?.fulltime?.away ?? null;
  } else if (st === 'ET' || st === 'BT' || st === 'P') {
    // Ao vivo em prorrogação — mostrar placar dos 90min (fulltime)
    homeScore = f.score?.fulltime?.home ?? f.goals?.home ?? null;
    awayScore = f.score?.fulltime?.away ?? f.goals?.away ?? null;
  } else {
    // FT, 1H, 2H, HT, NS — goals = placar atual/final dos 90min
    homeScore = f.goals?.home ?? null;
    awayScore = f.goals?.away ?? null;
  }

  // Detectar fase
  const round = f.league.round || '';
  let stage = 'GROUP_STAGE';
  if (round.includes('Round of 32')) stage = 'ROUND_OF_32';
  else if (round.includes('Round of 16')) stage = 'ROUND_OF_16';
  else if (round.includes('Quarter')) stage = 'QUARTER_FINALS';
  else if (round.includes('Semi')) stage = 'SEMI_FINALS';
  else if (round.includes('3rd') || round.includes('Third')) stage = 'THIRD_PLACE';
  else if (round.includes('Final') && !round.includes('Quarter') && !round.includes('Semi')) stage = 'FINAL';
  else if (!round.includes('Group')) stage = 'KNOCKOUT';

  return {
    id: f.fixture.id,
    homeTeam: translateTeamName(f.teams.home?.name || 'A definir'),
    awayTeam: translateTeamName(f.teams.away?.name || 'A definir'),
    date: f.fixture.date,
    status: statusMap[st] || st || 'SCHEDULED',
    statusDetail: st,
    matchday: round,
    stage,
    group: round.includes('Group') ? round : null,
    homeScore,
    awayScore,
    minute: f.fixture.status?.elapsed ?? null,
    injuryTime: f.fixture.status?.extra ?? null,
    extraTime: st === 'AET' || st === 'PEN' || st === 'ET',
  };
}

/**
 * Busca resultado de uma partida específica
 * PRINCIPAL: api-sports.io (melhor live data)
 * FALLBACK: football-data.org
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

  if (isWorldCup26Enabled()) {
    try {
      const wc26Result = await getWorldCup26MatchResult(matchId, options);
      if (wc26Result) {
        if (wc26Result.finished || wc26Result.live) {
          cacheMatchResult(matchId, wc26Result);
        }
        return wc26Result;
      }
    } catch (err) {
      console.error('[worldcup26.ir] Match result erro:', err.message);
    }
  }

  // API-Football — só se o fixture for da Copa 2026 (IDs não são compatíveis com football-data)
  if (AS_KEY && useApiSportsForWc2026()) {
    try {
      const res = await axios.get(`${AS_BASE}/fixtures`, {
        headers: { 'x-apisports-key': AS_KEY },
        params: { id: matchId },
        timeout: 10000,
      });
      const f = res.data.response?.[0];
      if (f && isApiSportsWorldCupFixture(f)) {
        const st = f.fixture.status?.short;
        const live = ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT'].includes(st);
        const finished = ['FT', 'AET', 'PEN'].includes(st);

        if (!live && !finished) {
          const pending = { finished: false, live: false, status: st };
          cacheMatchResult(matchId, pending);
          return pending;
        }

        // REGRA DO BOLÃO: placar dos 90 minutos APENAS
        // score.fulltime = placar ao fim dos 90min (antes da prorrogação)
        // goals = total geral (pode incluir extra time)
        let homeScore, awayScore;
        if (st === 'AET' || st === 'PEN') {
          // Jogo teve prorrogação — usar score.fulltime (= 90min)
          homeScore = f.score?.fulltime?.home;
          awayScore = f.score?.fulltime?.away;
          if (homeScore == null || awayScore == null) {
            // fallback se fulltime não disponível
            homeScore = (f.goals?.home ?? 0) - (f.score?.extratime?.home ?? 0) - (f.score?.penalty?.home ?? 0);
            awayScore = (f.goals?.away ?? 0) - (f.score?.extratime?.away ?? 0) - (f.score?.penalty?.away ?? 0);
          }
        } else {
          // FT normal ou ao vivo — goals = placar atual dos 90min
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
      }
      if (f) {
        console.warn(`[api-sports] fixture ${matchId} ignorado (não é Copa 2026) — tentando football-data`);
      }
    } catch (err) {
      console.error('[api-sports] Match result erro:', err.message);
    }
  }

  // football-data.org (fonte da Copa 2026 enquanto API-Football não publica a temporada)
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

      // REGRA DO BOLÃO: regularTime = 90 minutos
      // fullTime na football-data.org INCLUI prorrogação + pênaltis!
      const rtHome = m.score?.regularTime?.home;
      const rtAway = m.score?.regularTime?.away;

      let homeScore, awayScore;
      if (rtHome != null && rtAway != null) {
        // regularTime disponível — usar (90 min exatos)
        homeScore = rtHome;
        awayScore = rtAway;
      } else if (m.score?.duration === 'REGULAR' || (!m.score?.extraTime?.home && !m.score?.penalties?.home)) {
        // Jogo acabou no tempo regulamentar — fullTime = regularTime
        homeScore = m.score?.fullTime?.home ?? null;
        awayScore = m.score?.fullTime?.away ?? null;
      } else {
        // Tem prorrogação mas sem regularTime — não podemos confiar no fullTime
        console.warn(`[getMatchResult] Jogo ${matchId} tem prorrogação mas sem regularTime — aguardando`);
        const waiting = { finished: false, live, status: 'WAITING_REGULAR_SCORE' };
        cacheMatchResult(matchId, waiting);
        return waiting;
      }

      if (finished && (homeScore == null || awayScore == null)) {
        console.warn(`[getMatchResult] Jogo ${matchId} FINISHED mas sem score regulamentar — aguardando`);
        const waiting = { finished: false, live: false, status: 'WAITING_SCORE' };
        cacheMatchResult(matchId, waiting);
        return waiting;
      }

      const result = {
        finished: finished && homeScore != null && awayScore != null,
        live,
        homeScore: homeScore ?? 0,
        awayScore: awayScore ?? 0,
        status: m.status === 'PAUSED' ? 'PAUSED' : m.status,
        matchMinute: m.minute ?? null,
        matchInjuryTime: m.injuryTime ?? null,
      };
      cacheMatchResult(matchId, result);
      return result;
    } catch (err) {
      if (err.code !== 'RATE_LIMIT_COOLDOWN') {
        console.error('[football-data.org] Match result erro:', err.message);
      }
    }
  }

  return null;
}

module.exports = {
  getWorldCupMatches,
  getMatchResult,
  getMatchResultForGame,
  fetchApiSportsLiveFixtures,
  fetchFootballDataLiveFixtures,
  fetchLiveWorldCupFixtures,
  findParsedMatchForGame,
  parsedMatchToResult,
  getFootballApiStatus,
  useApiSportsForWc2026,
  invalidateWorldCupCache,
  getWorldCupCacheInfo,
};
