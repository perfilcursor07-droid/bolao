const axios = require('axios');
const { translateTeamName } = require('../utils/teamNamesPt');

// ═══ football-data.org (principal — gratuito, 10 req/min) ═══
const FD_BASE = 'https://api.football-data.org/v4';
const FD_KEY = process.env.FOOTBALL_API_KEY || '';

// ═══ api-sports.io (alternativa — 100 req/dia no free) ═══
const AS_BASE = 'https://v3.football.api-sports.io';
const AS_KEY = process.env.APISPORTS_KEY || '';

/**
 * Lista partidas da Copa do Mundo 2026 via football-data.org
 * Competition code: WC
 */
async function getWorldCupMatches() {
  // Tenta football-data.org primeiro
  if (FD_KEY) {
    try {
      const res = await axios.get(`${FD_BASE}/competitions/WC/matches`, {
        headers: { 'X-Auth-Token': FD_KEY },
        params: { season: 2026 },
        timeout: 10000,
      });

      const matches = res.data.matches || [];
      return matches.map(parseFootballDataMatch);
    } catch (err) {
      console.error('[football-data.org] Erro:', err.response?.status, err.response?.data?.message || err.message);
      // Se a season 2026 não existir ainda, tenta sem filtro
      if (err.response?.status === 400) {
        try {
          const res2 = await axios.get(`${FD_BASE}/competitions/WC/matches`, {
            headers: { 'X-Auth-Token': FD_KEY },
            timeout: 10000,
          });
          const matches = res2.data.matches || [];
          return matches.map(parseFootballDataMatch);
        } catch (err2) {
          console.error('[football-data.org] Fallback erro:', err2.response?.status, err2.message);
        }
      }
    }
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
      return fixtures.map(parseApiSportsMatch);
    } catch (err) {
      console.error('[api-sports] Erro:', err.response?.status, err.message);
    }
  }

  return null;
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
      const finished = m.status === 'FINISHED';
      if (!finished) return { finished: false, status: m.status };
      return {
        finished: true,
        homeScore: m.score?.fullTime?.home,
        awayScore: m.score?.fullTime?.away,
        status: m.status,
      };
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
      const finished = ['FT', 'AET', 'PEN'].includes(f.fixture.status?.short);
      if (!finished) return { finished: false, status: f.fixture.status?.short };
      return {
        finished: true,
        homeScore: f.goals?.home,
        awayScore: f.goals?.away,
        status: f.fixture.status?.long,
      };
    } catch (err) {
      console.error('[api-sports] Match result erro:', err.message);
    }
  }

  return null;
}

module.exports = { getWorldCupMatches, getMatchResult };
