const axios = require('axios');
const { translateTeamName } = require('../utils/teamNamesPt');
const { parseUsDateAsUtcToBrazil, parseUsDateInZoneToBrazil } = require('../utils/dateTime');

const WC26_BASE = (process.env.WORLDCUP26_API_URL || 'https://worldcup26.ir').replace(/\/$/, '');
const WC26_ENABLED = !['0', 'false', 'no'].includes(String(process.env.WORLDCUP26_API || '1').toLowerCase());

const STADIUM_META = {
  1: { region: 'Central', country_en: 'Mexico', timeZone: 'America/Mexico_City' },
  2: { region: 'Central', country_en: 'Mexico', timeZone: 'America/Mexico_City' },
  3: { region: 'Central', country_en: 'Mexico', timeZone: 'America/Monterrey' },
  4: { region: 'Central', country_en: 'United States', timeZone: 'America/Chicago' },
  5: { region: 'Central', country_en: 'United States', timeZone: 'America/Chicago' },
  6: { region: 'Central', country_en: 'United States', timeZone: 'America/Chicago' },
  7: { region: 'Eastern', country_en: 'United States', timeZone: 'America/New_York' },
  8: { region: 'Eastern', country_en: 'United States', timeZone: 'America/New_York' },
  9: { region: 'Eastern', country_en: 'United States', timeZone: 'America/New_York' },
  10: { region: 'Eastern', country_en: 'United States', timeZone: 'America/New_York' },
  11: { region: 'Eastern', country_en: 'United States', timeZone: 'America/New_York' },
  12: { region: 'Eastern', country_en: 'Canada', timeZone: 'America/Toronto' },
  13: { region: 'Western', country_en: 'Canada', timeZone: 'America/Vancouver' },
  14: { region: 'Western', country_en: 'United States', timeZone: 'America/Los_Angeles' },
  15: { region: 'Western', country_en: 'United States', timeZone: 'America/Los_Angeles' },
  16: { region: 'Western', country_en: 'United States', timeZone: 'America/Los_Angeles' },
};

const CACHE_TTL_LIVE_MS = 20 * 1000;
const CACHE_TTL_TODAY_MS = 5 * 60 * 1000;
const CACHE_TTL_DEFAULT_MS = 15 * 60 * 1000;

let gamesCache = { matches: null, fetchedAt: 0, expiresAt: 0 };

function isWorldCup26Enabled() {
  return WC26_ENABLED;
}

function parseScore(val) {
  if (val === null || val === undefined || val === '' || val === 'null') return null;
  const n = parseInt(String(val), 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * A API worldcup26.ir mistura formatos em local_date:
 * - Maioria dos jogos: horário em UTC
 * - Alguns estádios US Central (ex.: meio-dia em Dallas): horário local do estádio
 */
function parseWorldCup26LocalDate(localDate, stadiumId) {
  const m = String(localDate || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;

  const month = +m[1];
  const day = +m[2];
  const hour = +m[4];
  const stadium = STADIUM_META[String(stadiumId)];

  const asUtc = parseUsDateAsUtcToBrazil(localDate);
  if (!stadium) return asUtc;

  const isUsCentral = stadium.region === 'Central' && stadium.country_en === 'United States';
  if (!isUsCentral) return asUtc;

  // Central US: meio-dia local em junho (ex. Costa do Marfim × Noruega, 14h BRT)
  if (hour < 13 && !(month === 7 && hour === 12)) {
    return parseUsDateInZoneToBrazil(localDate, stadium.timeZone) || asUtc;
  }

  return asUtc;
}

function parseTimeElapsed(finished, timeElapsed) {
  const fin = String(finished || '').toUpperCase() === 'TRUE';
  const te = String(timeElapsed || '').trim().toLowerCase();

  if (fin || te === 'finished') {
    return { status: 'FINISHED', statusDetail: 'FT', minute: null, injuryTime: null };
  }
  if (!te || te === 'notstarted' || te === 'not started') {
    return { status: 'SCHEDULED', statusDetail: null, minute: null, injuryTime: null };
  }
  if (te === 'ht' || te === 'halftime' || te === 'half time') {
    return { status: 'PAUSED', statusDetail: 'HT', minute: 45, injuryTime: null };
  }
  if (te.includes('live') || te === 'in_progress' || te === 'playing') {
    return { status: 'IN_PLAY', statusDetail: 'LIVE', minute: null, injuryTime: null };
  }
  const minuteMatch = te.match(/^(\d{1,3})(?:\+(\d{1,2}))?/);
  if (minuteMatch) {
    return {
      status: 'IN_PLAY',
      statusDetail: te,
      minute: parseInt(minuteMatch[1], 10),
      injuryTime: minuteMatch[2] ? parseInt(minuteMatch[2], 10) : null,
    };
  }

  return { status: 'SCHEDULED', statusDetail: te, minute: null, injuryTime: null };
}

function mapStage(type, group) {
  const t = String(type || '').toLowerCase();
  if (t === 'group') return 'GROUP_STAGE';
  if (t === 'r32') return 'ROUND_OF_32';
  if (t === 'r16') return 'ROUND_OF_16';
  if (t === 'qf') return 'QUARTER_FINALS';
  if (t === 'sf') return 'SEMI_FINALS';
  if (t === 'third' || t === '3rd') return 'THIRD_PLACE';
  if (t === 'final') return 'FINAL';
  const g = String(group || '').toUpperCase();
  if (g === 'R32') return 'ROUND_OF_32';
  if (g === 'R16') return 'ROUND_OF_16';
  if (g === 'QF') return 'QUARTER_FINALS';
  if (g === 'SF') return 'SEMI_FINALS';
  if (g === 'FINAL') return 'FINAL';
  if (g === '3RD') return 'THIRD_PLACE';
  return 'KNOCKOUT';
}

function parseWorldCup26Game(g) {
  const { status, statusDetail, minute, injuryTime } = parseTimeElapsed(g.finished, g.time_elapsed);
  const notStarted = status === 'SCHEDULED';
  const homeScore = notStarted ? null : parseScore(g.home_score);
  const awayScore = notStarted ? null : parseScore(g.away_score);

  const homeName = g.home_team_name_en || g.home_team_label || 'A definir';
  const awayName = g.away_team_name_en || g.away_team_label || 'A definir';

  return {
    id: String(g.id),
    homeTeam: translateTeamName(homeName),
    awayTeam: translateTeamName(awayName),
    date: parseWorldCup26LocalDate(g.local_date, g.stadium_id),
    status,
    statusDetail,
    matchday: g.matchday,
    stage: mapStage(g.type, g.group),
    group: String(g.type || '').toLowerCase() === 'group' ? g.group : null,
    homeScore,
    awayScore,
    minute,
    injuryTime,
    source: 'worldcup26',
  };
}

function computeCacheTtl(matches) {
  if (!matches?.length) return CACHE_TTL_TODAY_MS;
  if (matches.some((m) => ['IN_PLAY', 'PAUSED', 'LIVE'].includes(m.status))) {
    return CACHE_TTL_LIVE_MS;
  }
  const todayStr = new Date().toDateString();
  const hasToday = matches.some((m) => {
    if (!m.date) return false;
    const d = new Date(m.date);
    return d.toDateString() === todayStr && m.status === 'SCHEDULED';
  });
  return hasToday ? CACHE_TTL_TODAY_MS : CACHE_TTL_DEFAULT_MS;
}

async function fetchWorldCup26Games(options = {}) {
  if (!isWorldCup26Enabled()) {
    return { matches: null, error: 'worldcup26.ir desabilitada (WORLDCUP26_API=0)' };
  }

  const forceRefresh = options.forceRefresh === true;
  if (!forceRefresh && gamesCache.matches && Date.now() < gamesCache.expiresAt) {
    return {
      matches: gamesCache.matches,
      fetchedAt: gamesCache.fetchedAt,
      fromCache: true,
      error: null,
    };
  }

  try {
    const res = await axios.get(`${WC26_BASE}/get/games`, { timeout: 15000 });
    const raw = Array.isArray(res.data?.games) ? res.data.games : [];
    const matches = raw
      .map(parseWorldCup26Game)
      .sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));

    const ttl = computeCacheTtl(matches);
    gamesCache = {
      matches,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + ttl,
    };

    return { matches, fetchedAt: gamesCache.fetchedAt, fromCache: false, error: null };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('[worldcup26.ir] Erro:', err.response?.status || err.code, msg);
    if (gamesCache.matches) {
      return {
        matches: gamesCache.matches,
        fetchedAt: gamesCache.fetchedAt,
        fromCache: true,
        error: msg,
      };
    }
    return { matches: null, error: msg };
  }
}

function findWorldCup26Match(matchId, matches) {
  const list = matches || gamesCache.matches || [];
  return list.find((m) => String(m.id) === String(matchId)) || null;
}

function worldCup26ToMatchResult(parsed) {
  if (!parsed) return null;
  const live = ['IN_PLAY', 'PAUSED', 'LIVE'].includes(parsed.status);
  const finished = ['FINISHED', 'AWARDED'].includes(parsed.status);
  const paused = parsed.status === 'PAUSED' || parsed.statusDetail === 'HT';

  if (!live && !finished) {
    return { finished: false, live: false, status: parsed.status };
  }

  return {
    finished,
    live,
    homeScore: parsed.homeScore ?? 0,
    awayScore: parsed.awayScore ?? 0,
    status: paused ? 'PAUSED' : parsed.statusDetail || parsed.status,
    matchMinute: parsed.minute ?? null,
    matchInjuryTime: parsed.injuryTime ?? null,
    fixtureId: parsed.id,
  };
}

async function getWorldCup26MatchResult(matchId, options = {}) {
  const { matches } = await fetchWorldCup26Games(options);
  const parsed = findWorldCup26Match(matchId, matches);
  return worldCup26ToMatchResult(parsed);
}

function fetchWorldCup26LiveMatches(options = {}) {
  return fetchWorldCup26Games(options).then(({ matches, ...rest }) => ({
    matches: (matches || []).filter((m) => ['IN_PLAY', 'PAUSED', 'LIVE'].includes(m.status)),
    ...rest,
  }));
}

function invalidateWorldCup26Cache() {
  gamesCache.expiresAt = 0;
}

function getWorldCup26CacheInfo() {
  return {
    fetchedAt: gamesCache.fetchedAt || null,
    expiresAt: gamesCache.expiresAt || null,
    hasData: Boolean(gamesCache.matches?.length),
  };
}

module.exports = {
  isWorldCup26Enabled,
  fetchWorldCup26Games,
  fetchWorldCup26LiveMatches,
  findWorldCup26Match,
  getWorldCup26MatchResult,
  worldCup26ToMatchResult,
  parseWorldCup26Game,
  invalidateWorldCup26Cache,
  getWorldCup26CacheInfo,
};
