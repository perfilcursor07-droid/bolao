const HALFTIME_BREAK_MIN = 15;
const FIRST_HALF_END = 45;

function isPausedStatus(status) {
  if (!status) return false;
  const s = String(status).toUpperCase();
  return s === 'PAUSED' || s === 'HT' || s.includes('HALF');
}

function estimateMinuteFromKickoff(gameDate) {
  const kickoff = new Date(gameDate).getTime();
  if (Number.isNaN(kickoff)) return null;

  const elapsed = Math.floor((Date.now() - kickoff) / 60000);
  if (elapsed < 0) return { minute: 0, label: "0'" };

  if (elapsed <= FIRST_HALF_END) {
    return { minute: elapsed, label: `${elapsed}'` };
  }

  const halftimeEnd = FIRST_HALF_END + HALFTIME_BREAK_MIN;
  if (elapsed <= halftimeEnd) {
    return { minute: FIRST_HALF_END, label: 'Intervalo' };
  }

  const matchMinute = elapsed - HALFTIME_BREAK_MIN;
  return { minute: matchMinute, label: `${matchMinute}'` };
}

/**
 * Rótulo do minuto para jogos ao vivo (ex.: "54'", "45+2'", "Intervalo").
 */
function formatLiveMatchMinute(game) {
  if (!game || game.status !== 'closed') return null;

  if (isPausedStatus(game.api_match_status)) {
    return 'Intervalo';
  }

  if (game.match_minute != null && Number.isFinite(Number(game.match_minute))) {
    const min = Number(game.match_minute);
    const extra = game.match_injury_time != null ? Number(game.match_injury_time) : 0;
    if (extra > 0) return `${min}+${extra}'`;
    return `${min}'`;
  }

  return estimateMinuteFromKickoff(game.game_date)?.label || null;
}

module.exports = {
  formatLiveMatchMinute,
  estimateMinuteFromKickoff,
  isPausedStatus,
};
