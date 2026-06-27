const pool = require('../config/database');
const { translateTeamName } = require('../utils/teamNamesPt');
const { toMySQLDateTime } = require('../utils/dateTime');
const { deleteGamesByIds } = require('./gameDelete');

function normalizeTeamName(name) {
  return translateTeamName(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function gameDateMinuteKey(gameDate) {
  const mysql = toMySQLDateTime(gameDate);
  const match = String(mysql).match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
  return match ? match[1] : String(mysql).slice(0, 16);
}

function gameFingerprint(homeTeam, awayTeam, gameDate) {
  return `${normalizeTeamName(homeTeam)}|${normalizeTeamName(awayTeam)}|${gameDateMinuteKey(gameDate)}`;
}

function gameDedupeKey(game) {
  if (game.api_match_id) return `api:${String(game.api_match_id)}`;
  return `fp:${gameFingerprint(game.home_team, game.away_team, game.game_date)}`;
}

function scoreGameForKeep(game) {
  const bets = Number(game.total_bets ?? game.bet_count ?? game.real_bet_count ?? 0);
  const pool = Number(game.prize_pool_cents ?? 0);
  const featured = game.featured ? 1 : 0;
  const hasApi = game.api_match_id ? 1 : 0;
  return bets * 1_000_000 + pool * 100 + featured * 10 + hasApi;
}

function pickBestGame(games) {
  return [...games].sort((a, b) => {
    const scoreDiff = scoreGameForKeep(b) - scoreGameForKeep(a);
    if (scoreDiff !== 0) return scoreDiff;
    return (a.id || 0) - (b.id || 0);
  })[0];
}

function dedupeGamesForDisplay(games) {
  if (!games?.length) return [];

  const groups = new Map();
  for (const game of games) {
    const key = gameDedupeKey(game);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(game);
  }

  const result = [];
  for (const group of groups.values()) {
    result.push(pickBestGame(group));
  }

  return result.sort((a, b) => {
    if (Boolean(b.featured) !== Boolean(a.featured)) return (b.featured ? 1 : 0) - (a.featured ? 1 : 0);
    return new Date(a.game_date).getTime() - new Date(b.game_date).getTime();
  });
}

async function findExistingGame({ apiMatchId, homeTeam, awayTeam, gameDate }) {
  if (apiMatchId) {
    const [rows] = await pool.query('SELECT id FROM games WHERE api_match_id = ? LIMIT 1', [String(apiMatchId)]);
    if (rows.length > 0) return rows[0];
  }

  const home = translateTeamName(homeTeam);
  const away = translateTeamName(awayTeam);
  const minute = gameDateMinuteKey(gameDate);

  const [rows] = await pool.query(
    `SELECT id FROM games
     WHERE DATE_FORMAT(game_date, '%Y-%m-%d %H:%i') = ?
       AND (
         (home_team = ? AND away_team = ?)
         OR (home_team = ? AND away_team = ?)
       )
     LIMIT 1`,
    [minute, home, away, homeTeam, awayTeam]
  );

  return rows[0] || null;
}

async function loadExistingGameKeys() {
  const [rows] = await pool.query(
    `SELECT api_match_id, home_team, away_team, game_date FROM games`
  );

  const apiMatchIds = [];
  const fingerprints = new Set();

  for (const row of rows) {
    if (row.api_match_id) apiMatchIds.push(String(row.api_match_id));
    fingerprints.add(gameFingerprint(row.home_team, row.away_team, row.game_date));
  }

  return { apiMatchIds, fingerprints: [...fingerprints] };
}

async function findDuplicateGroups() {
  const [games] = await pool.query(
    `SELECT g.*,
      (SELECT COUNT(*) FROM bets b WHERE b.game_id = g.id) as bet_count,
      (SELECT COUNT(*) FROM payments p WHERE p.game_id = g.id AND p.status = 'paid') as paid_count
     FROM games g
     ORDER BY g.game_date DESC, g.id ASC`
  );

  const groups = new Map();
  for (const game of games) {
    const key = gameDedupeKey(game);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(game);
  }

  return [...groups.values()].filter((g) => g.length > 1);
}

async function removeSafeDuplicateGames() {
  const duplicateGroups = await findDuplicateGroups();
  const toDelete = [];

  for (const group of duplicateGroups) {
    const keep = pickBestGame(group);
    for (const game of group) {
      if (game.id === keep.id) continue;
      if (Number(game.bet_count) === 0 && Number(game.paid_count) === 0) {
        toDelete.push(game.id);
      }
    }
  }

  if (toDelete.length === 0) {
    return { deleted: 0, skippedGroups: duplicateGroups.length };
  }

  const deleted = await deleteGamesByIds(toDelete);
  return { deleted, skippedGroups: duplicateGroups.filter((g) => g.length > 1).length };
}

function markDuplicateIds(games) {
  const counts = new Map();
  for (const game of games) {
    const key = gameDedupeKey(game);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const duplicateIds = new Set();
  for (const game of games) {
    if ((counts.get(gameDedupeKey(game)) || 0) > 1) {
      duplicateIds.add(game.id);
    }
  }

  return duplicateIds;
}

module.exports = {
  gameFingerprint,
  gameDedupeKey,
  dedupeGamesForDisplay,
  findExistingGame,
  loadExistingGameKeys,
  findDuplicateGroups,
  removeSafeDuplicateGames,
  markDuplicateIds,
  pickBestGame,
};
