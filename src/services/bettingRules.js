/** Regras de aposta — módulo sem dependências para evitar ciclo prizeService ↔ gameStatusService */

const BETTING_CLOSE_MINUTES = 5;

function parseGameDate(game) {
  if (!game || !game.game_date) return null;
  const d = game.game_date;
  if (d instanceof Date) return d;
  // MySQL retorna DATETIME sem timezone — forçar interpretação como UTC
  let str = String(d);
  // Se não tem Z ou offset, é UTC vindo do banco
  if (!str.endsWith('Z') && !str.includes('+') && !str.includes('T')) {
    str = str.replace(' ', 'T') + 'Z';
  }
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function hasGameStarted(game) {
  const kickoff = parseGameDate(game);
  if (!kickoff) return false;
  return Date.now() >= kickoff.getTime();
}

/** Horário limite para novas apostas (5 min antes do jogo). */
function getBettingDeadline(game) {
  const kickoff = parseGameDate(game);
  if (!kickoff) return null;
  return new Date(kickoff.getTime() - BETTING_CLOSE_MINUTES * 60 * 1000);
}

function isBettingOpen(game) {
  if (!game || game.status !== 'open') return false;
  if (hasGameStarted(game)) return false;
  const deadline = getBettingDeadline(game);
  if (!deadline) return false;
  return Date.now() < deadline.getTime();
}

module.exports = {
  BETTING_CLOSE_MINUTES,
  parseGameDate,
  hasGameStarted,
  getBettingDeadline,
  isBettingOpen,
};
