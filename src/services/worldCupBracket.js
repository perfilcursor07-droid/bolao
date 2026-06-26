/**
 * Enriquece jogos de mata-mata quando football-data.org ainda não definiu os times.
 * Diferencia confrontos CONFIRMADOS (grupos encerrados, 1º×2º) de PROVÁVEIS (3º lugar ou grupo em aberto).
 * Ref: https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_knockout_stage
 */

/** Chaveamento das 16-avos por horário UTC (prefixo do utcDate da API). */
const LAST_32_PAIRINGS = [
  { prefix: '2026-06-28T19', home: '2A', away: '2B' },
  { prefix: '2026-06-29T17', home: '1C', away: '2F' },
  { prefix: '2026-06-29T20', home: '1E', away: '3ACDF' },
  { prefix: '2026-06-30T01', home: '1F', away: '2C' },
  { prefix: '2026-06-30T17', home: '1I', away: '3CDFGH' },
  { prefix: '2026-06-30T21', home: '2E', away: '2I' },
  { prefix: '2026-07-01T01', home: '1A', away: '3CEFHI' },
  { prefix: '2026-07-01T16', home: '1L', away: '3EHIJK' },
  { prefix: '2026-07-01T20', home: '1D', away: '3BEFIJ' },
  { prefix: '2026-07-02T00', home: '1G', away: '3AEHIJ' },
  { prefix: '2026-07-02T19', home: '2K', away: '2L' },
  { prefix: '2026-07-02T23', home: '1H', away: '2J' },
  { prefix: '2026-07-03T03', home: '1B', away: '3EFGIJ' },
  { prefix: '2026-07-03T18', home: '1J', away: '2H' },
  { prefix: '2026-07-03T22', home: '1K', away: '3DEIJL' },
  { prefix: '2026-07-04T01', home: '2D', away: '2G' },
];

const GAMES_PER_GROUP = 6;

function isPlaceholderTeam(name) {
  return !name || name === 'A definir';
}

function parseGroupKey(groupField) {
  if (!groupField) return null;
  const m = String(groupField).match(/GROUP_([A-L])/i);
  return m ? m[1].toUpperCase() : null;
}

function parseSlot(slot) {
  if (!slot || slot.length < 2) return null;
  if (slot[0] === '3') {
    return { type: 'third', groups: slot.slice(1).split('') };
  }
  const pos = parseInt(slot[0], 10);
  const group = slot.slice(1).toUpperCase();
  if (!pos || !group) return null;
  return { type: 'position', group, pos };
}

function buildGroupProgress(matches) {
  const progress = {};
  for (const m of matches) {
    if (m.stage !== 'GROUP_STAGE') continue;
    const group = parseGroupKey(m.group);
    if (!group) continue;
    if (!progress[group]) progress[group] = { total: 0, finished: 0 };
    progress[group].total++;
    if (m.status === 'FINISHED') progress[group].finished++;
  }
  return progress;
}

function isGroupComplete(progress, group) {
  const p = progress[group];
  if (!p) return false;
  return p.finished >= GAMES_PER_GROUP || (p.total >= GAMES_PER_GROUP && p.finished === p.total);
}

function buildGroupTables(matches) {
  const tables = {};

  for (const m of matches) {
    if (m.stage !== 'GROUP_STAGE' || m.status !== 'FINISHED') continue;
    const group = parseGroupKey(m.group);
    if (!group) continue;
    if (m.homeScore === null || m.awayScore === null) continue;

    if (!tables[group]) tables[group] = {};

    const register = (teamName) => {
      if (!teamName || isPlaceholderTeam(teamName)) return;
      if (!tables[group][teamName]) {
        tables[group][teamName] = { team: teamName, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 };
      }
      return tables[group][teamName];
    };

    const home = register(m.homeTeam);
    const away = register(m.awayTeam);
    if (!home || !away) continue;

    const hs = m.homeScore;
    const as = m.awayScore;
    home.p++;
    away.p++;
    home.gf += hs;
    home.ga += as;
    away.gf += as;
    away.ga += hs;

    if (hs > as) {
      home.w++;
      away.l++;
    } else if (hs < as) {
      away.w++;
      home.l++;
    } else {
      home.d++;
      away.d++;
    }
  }

  const ranked = {};
  for (const [group, teams] of Object.entries(tables)) {
    ranked[group] = Object.values(teams)
      .map((t) => ({ ...t, pts: t.w * 3 + t.d, gd: t.gf - t.ga }))
      .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.team.localeCompare(b.team));
  }
  return ranked;
}

function getTeamAtPosition(tables, group, position) {
  const row = tables[group]?.[position - 1];
  return row?.team || null;
}

function getThirdPlaceCandidates(tables) {
  const thirds = [];
  for (const [group, rows] of Object.entries(tables)) {
    if (rows.length >= 3) {
      const third = rows[2];
      thirds.push({ group, ...third });
    }
  }
  return thirds.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
}

function resolveThirdPlace(tables, eligibleGroups, usedThirdGroups) {
  const eligible = new Set(eligibleGroups.map((g) => g.toUpperCase()));
  const candidates = getThirdPlaceCandidates(tables).filter(
    (c) => eligible.has(c.group) && !usedThirdGroups.has(c.group)
  );
  return candidates[0]?.team || null;
}

function resolveSlot(slotCode, tables, usedThirdGroups) {
  const slot = parseSlot(slotCode);
  if (!slot) return null;

  if (slot.type === 'position') {
    return getTeamAtPosition(tables, slot.group, slot.pos);
  }

  const team = resolveThirdPlace(tables, slot.groups, usedThirdGroups);
  if (team) {
    const candidate = getThirdPlaceCandidates(tables).find((c) => c.team === team);
    if (candidate) usedThirdGroups.add(candidate.group);
  }
  return team;
}

function slotLabel(slotCode) {
  const slot = parseSlot(slotCode);
  if (!slot) return slotCode;
  if (slot.type === 'third') return `3º (${slot.groups.join(',')})`;
  return `${slot.pos}º Gr. ${slot.group}`;
}

function isSlotConfirmed(slotCode, progress, fromApi) {
  if (fromApi) return true;
  const slot = parseSlot(slotCode);
  if (!slot) return false;
  if (slot.type === 'third') return false;
  return isGroupComplete(progress, slot.group);
}

function computeMatchCertainty(pairing, { homeFromApi, awayFromApi, progress }) {
  const homeSlot = parseSlot(pairing.home);
  const awaySlot = parseSlot(pairing.away);

  if (homeSlot?.type === 'third' || awaySlot?.type === 'third') {
    return 'tentative';
  }

  const homeOk = isSlotConfirmed(pairing.home, progress, homeFromApi);
  const awayOk = isSlotConfirmed(pairing.away, progress, awayFromApi);

  if (homeOk && awayOk) return 'confirmed';
  return 'tentative';
}

function findPairing(utcDate) {
  if (!utcDate) return null;
  const iso = new Date(utcDate).toISOString().slice(0, 13);
  return LAST_32_PAIRINGS.find((p) => iso.startsWith(p.prefix.slice(0, 13))) || null;
}

/**
 * @param {Array} matches - lista já parseada (getWorldCupMatches)
 */
function enrichKnockoutMatches(matches) {
  if (!matches?.length) return matches;

  const tables = buildGroupTables(matches);
  const progress = buildGroupProgress(matches);
  const usedThirdGroups = new Set();

  return matches.map((m) => {
    if (m.stage !== 'LAST_32') return m;

    const pairing = findPairing(m.date);
    if (!pairing) return m;

    const enriched = { ...m };
    const homeFromApi = !isPlaceholderTeam(enriched.homeTeam);
    const awayFromApi = !isPlaceholderTeam(enriched.awayTeam);

    if (!homeFromApi) {
      const team = resolveSlot(pairing.home, tables, usedThirdGroups);
      if (team) {
        enriched.homeTeam = team;
        enriched.homeProjected = true;
      }
    }

    if (!awayFromApi) {
      const team = resolveSlot(pairing.away, tables, usedThirdGroups);
      if (team) {
        enriched.awayTeam = team;
        enriched.awayProjected = true;
      }
    }

    if (homeFromApi || awayFromApi || enriched.homeProjected || enriched.awayProjected) {
      enriched.bracketSlotHome = slotLabel(pairing.home);
      enriched.bracketSlotAway = slotLabel(pairing.away);
      enriched.bracketCertainty = computeMatchCertainty(pairing, {
        homeFromApi,
        awayFromApi,
        progress,
      });
      enriched.bracketProjected = enriched.bracketCertainty === 'tentative';
    }

    return enriched;
  });
}

module.exports = {
  enrichKnockoutMatches,
  buildGroupTables,
  buildGroupProgress,
  isGroupComplete,
  LAST_32_PAIRINGS,
};
