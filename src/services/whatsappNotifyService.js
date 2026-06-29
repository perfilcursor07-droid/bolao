const pool = require('../config/database');
const { formatCents } = require('../routes/games');
const { translateTeamName } = require('../utils/teamNamesPt');
const { cleanPhone, normalizeBrazilPhone } = require('./whatsapp/phone');
const { enqueueMessage } = require('./whatsapp/outbox');
const {
  getConsultarUrl,
  SUPPORT_PHONE_DISPLAY,
  PRIZE_TRANSFER_HOURS,
} = require('../config/support');

const API_FINISHED_STATUSES = new Set(['FINISHED', 'AWARDED']);

async function isNotificationsEnabled() {
  try {
    const [rows] = await pool.query(
      "SELECT setting_value FROM settings WHERE setting_key = 'whatsapp_notifications_enabled' LIMIT 1"
    );
    return rows[0]?.setting_value === '1';
  } catch {
    return false;
  }
}

function formatPlacar(h, a) {
  return `${h}×${a}`;
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'Apostador';
}

function isGameResultConfirmed(game) {
  if (!game || game.status !== 'finished') return false;
  if (game.home_score === null || game.away_score === null) return false;
  if (game.api_match_id) {
    return API_FINISHED_STATUSES.has(String(game.api_match_status || '').toUpperCase());
  }
  return true;
}

/**
 * Apostas ganhadoras conferidas: is_winner + palpite = placar final do jogo.
 */
async function loadVerifiedWinningBets(gameId) {
  const [rows] = await pool.query(
    `SELECT b.*, u.name, u.phone, u.cpf, g.home_score, g.away_score, g.title, g.home_team, g.away_team, g.status
     FROM bets b
     JOIN users u ON u.id = b.user_id
     JOIN games g ON g.id = b.game_id
     WHERE b.game_id = ?
       AND g.status = 'finished'
       AND b.is_winner = TRUE
       AND b.home_score_prediction = g.home_score
       AND b.away_score_prediction = g.away_score`,
    [gameId]
  );
  return rows;
}

async function notifyPaymentConfirmed(paymentId) {
  if (!(await isNotificationsEnabled())) return;

  const [rows] = await pool.query(
    `SELECT p.*, u.name, u.phone, g.title, g.home_team, g.away_team
     FROM payments p
     JOIN users u ON u.id = p.user_id
     JOIN games g ON g.id = p.game_id
     WHERE p.id = ? AND p.status = 'paid'`,
    [paymentId]
  );
  if (rows.length === 0) return;

  const payment = rows[0];
  const phone = cleanPhone(payment.phone);
  if (!normalizeBrazilPhone(phone)) return;

  let placares = [];
  try {
    const data = typeof payment.prediction_data === 'string'
      ? JSON.parse(payment.prediction_data)
      : payment.prediction_data;
    placares = Array.isArray(data?.placares) ? data.placares : [];
  } catch {
    placares = [];
  }

  const palpitesLines = placares.length
    ? placares.map((p) => `• ${formatPlacar(p.home, p.away)}`).join('\n')
    : '• Registrado';

  const matchLabel = `${translateTeamName(payment.home_team)} × ${translateTeamName(payment.away_team)}`;
  const body = [
    '✅ *Pagamento confirmado!*',
    '',
    `Olá, ${firstName(payment.name)}!`,
    '',
    `Bolão: *${payment.title}*`,
    `Jogo: ${matchLabel}`,
    `Valor: *${formatCents(payment.amount_cents)}*`,
    '',
    'Palpites registrados:',
    palpitesLines,
    '',
    'Boa sorte! 🍀',
    '',
    '_Bolão Online_',
  ].join('\n');

  await enqueueMessage({
    userId: payment.user_id,
    phone: normalizeBrazilPhone(phone),
    messageType: 'payment_confirmed',
    referenceKey: `payment_${paymentId}`,
    body,
  });
}

/**
 * Envia WhatsApp SOMENTE para ganhadores verificados (palpite = placar final).
 * Nunca envia automaticamente — só via ação explícita do admin.
 */
async function notifyWinners(gameId, options = {}) {
  if (!(await isNotificationsEnabled())) {
    return { skipped: true, reason: 'notifications_disabled' };
  }

  const force = options.force === true;

  const [games] = await pool.query('SELECT * FROM games WHERE id = ?', [gameId]);
  if (games.length === 0) return { skipped: true, reason: 'game_not_found' };
  const game = games[0];

  if (!isGameResultConfirmed(game)) {
    return {
      skipped: true,
      reason: 'result_not_confirmed',
      message: 'Placar ainda não confirmado pela API (aguarde status FINISHED) ou jogo não finalizado.',
    };
  }

  if (game.results_whatsapp_sent_at && !force) {
    return {
      skipped: true,
      reason: 'already_sent',
      message: 'WhatsApp de ganhadores já foi enviado para este placar. Use reenvio forçado se necessário.',
    };
  }

  const winningBets = await loadVerifiedWinningBets(gameId);
  if (winningBets.length === 0) {
    return { skipped: true, reason: 'no_verified_winners' };
  }

  const resultLine = formatPlacar(game.home_score, game.away_score);
  const matchLabel = `${translateTeamName(game.home_team)} × ${translateTeamName(game.away_team)}`;
  const referenceSuffix = `_final_${game.home_score}x${game.away_score}`;

  const byUser = {};
  for (const bet of winningBets) {
    const phone = cleanPhone(bet.phone);
    if (!normalizeBrazilPhone(phone)) continue;
    if (!byUser[bet.user_id]) {
      byUser[bet.user_id] = { name: bet.name, phone: normalizeBrazilPhone(phone), pixKey: bet.cpf || '', bets: [] };
    }
    byUser[bet.user_id].bets.push(bet);
  }

  let queued = 0;
  let duplicates = 0;
  const consultarUrl = getConsultarUrl();

  for (const [userId, group] of Object.entries(byUser)) {
    const lines = group.bets.map((bet) => {
      const palpite = formatPlacar(bet.home_score_prediction, bet.away_score_prediction);
      return `🏆 Palpite ${palpite} — *GANHOU* ${formatCents(bet.prize_amount_cents)}`;
    });

    const body = [
      '🏆 *Parabéns, você ganhou!*',
      '',
      `Olá, ${firstName(group.name)}!`,
      '',
      `*${game.title}*`,
      `Resultado final confirmado: *${resultLine}*`,
      `(${matchLabel})`,
      '',
      ...lines,
      '',
      '💰 *Pagamento do prêmio*',
      `A transferência será realizada em *até ${PRIZE_TRANSFER_HOURS} horas* para a chave PIX cadastrada.`,
      group.pixKey ? `📌 *Sua chave PIX:* ${group.pixKey}` : '📌 Consulte sua chave em /consultar com seu WhatsApp',
      '',
      `📲 *Acompanhe o status:* ${consultarUrl}`,
      `💬 Dúvidas: *${SUPPORT_PHONE_DISPLAY}*`,
      '',
      '_Bolão Online_',
    ].join('\n');

    const enqueueResult = await enqueueMessage({
      userId: parseInt(userId, 10),
      phone: group.phone,
      messageType: 'bet_result',
      referenceKey: `game_${gameId}_user_${userId}${referenceSuffix}`,
      body,
    });
    if (enqueueResult.queued) queued++;
    else if (enqueueResult.duplicate) duplicates++;
  }

  if (queued > 0) {
    await pool.query('UPDATE games SET results_whatsapp_sent_at = NOW() WHERE id = ?', [gameId]);
  }

  return { queued, duplicates, verifiedWinners: winningBets.length };
}

/**
 * Aviso de correção para participantes (ex.: placar provisório errado).
 * Não menciona vitória — só o resultado oficial.
 */
async function notifyResultCorrection(gameId) {
  if (!(await isNotificationsEnabled())) {
    return { skipped: true, reason: 'notifications_disabled' };
  }

  const [games] = await pool.query('SELECT * FROM games WHERE id = ? AND status = ?', [gameId, 'finished']);
  if (games.length === 0) return { skipped: true, reason: 'game_not_finished' };
  const game = games[0];

  const resultLine = formatPlacar(game.home_score, game.away_score);
  const matchLabel = `${translateTeamName(game.home_team)} × ${translateTeamName(game.away_team)}`;

  const [bets] = await pool.query(
    `SELECT b.user_id, b.home_score_prediction, b.away_score_prediction, b.is_winner,
            u.name, u.phone
     FROM bets b
     JOIN users u ON u.id = b.user_id
     WHERE b.game_id = ?`,
    [gameId]
  );

  const byUser = {};
  for (const bet of bets) {
    const phone = cleanPhone(bet.phone);
    if (!normalizeBrazilPhone(phone)) continue;
    if (!byUser[bet.user_id]) {
      byUser[bet.user_id] = { name: bet.name, phone: normalizeBrazilPhone(phone), bets: [] };
    }
    byUser[bet.user_id].bets.push(bet);
  }

  let queued = 0;
  const suffix = `_correction_${game.home_score}x${game.away_score}`;

  for (const [userId, group] of Object.entries(byUser)) {
    const hasVerifiedWin = group.bets.some(
      (b) =>
        b.is_winner &&
        b.home_score_prediction === game.home_score &&
        b.away_score_prediction === game.away_score
    );

    const body = [
      '⚠️ *Correção de resultado — Bolão Online*',
      '',
      `Olá, ${firstName(group.name)}!`,
      '',
      `*${game.title}* (${matchLabel})`,
      '',
      `O *resultado final confirmado* é *${resultLine}*.`,
      '',
      hasVerifiedWin
        ? 'Seu palpite acertou o placar final. O prêmio será pago conforme as regras do bolão.'
        : 'Se você recebeu mensagem anterior com placar diferente, *desconsidere* — foi enviada antes da confirmação oficial do jogo.',
      '',
      'Pedimos desculpas pelo transtorno.',
      '',
      `📲 Consulte suas apostas: ${getConsultarUrl()}`,
      `💬 Contato: *${SUPPORT_PHONE_DISPLAY}*`,
      '',
      '_Bolão Online_',
    ].join('\n');

    const enqueueResult = await enqueueMessage({
      userId: parseInt(userId, 10),
      phone: group.phone,
      messageType: 'bet_result',
      referenceKey: `game_${gameId}_user_${userId}${suffix}`,
      body,
    });
    if (enqueueResult.queued) queued++;
  }

  return { queued };
}

/** @deprecated Use notifyWinners — nunca envia para quem não ganhou. */
async function notifyGameResults(gameId, options = {}) {
  if (options.winnersOnly) return notifyWinners(gameId, options);
  return { skipped: true, reason: 'broadcast_disabled' };
}

module.exports = {
  isNotificationsEnabled,
  isGameResultConfirmed,
  loadVerifiedWinningBets,
  notifyPaymentConfirmed,
  notifyGameResults,
  notifyWinners,
  notifyResultCorrection,
};
