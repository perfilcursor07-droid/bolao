const pool = require('../config/database');
const { formatCents } = require('../routes/games');
const { translateTeamName } = require('../utils/teamNamesPt');
const { cleanPhone } = require('./whatsapp/phone');
const { enqueueMessage } = require('./whatsapp/outbox');

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
  if (phone.length < 10) return;

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
    phone,
    messageType: 'payment_confirmed',
    referenceKey: `payment_${paymentId}`,
    body,
  });
}

async function notifyGameResults(gameId) {
  if (!(await isNotificationsEnabled())) return;

  const [games] = await pool.query('SELECT * FROM games WHERE id = ? AND status = ?', [gameId, 'finished']);
  if (games.length === 0) return;
  const game = games[0];

  const [bets] = await pool.query(
    `SELECT b.*, u.name, u.phone
     FROM bets b
     JOIN users u ON u.id = b.user_id
     WHERE b.game_id = ?`,
    [gameId]
  );
  if (bets.length === 0) return;

  const resultLine = formatPlacar(game.home_score, game.away_score);
  const matchLabel = `${translateTeamName(game.home_team)} × ${translateTeamName(game.away_team)}`;

  const byUser = {};
  for (const bet of bets) {
    const phone = cleanPhone(bet.phone);
    if (phone.length < 10) continue;
    if (!byUser[bet.user_id]) {
      byUser[bet.user_id] = { name: bet.name, phone, bets: [] };
    }
    byUser[bet.user_id].bets.push(bet);
  }

  for (const [userId, group] of Object.entries(byUser)) {
    const lines = [];
    let hasWinner = false;

    for (const bet of group.bets) {
      const palpite = formatPlacar(bet.home_score_prediction, bet.away_score_prediction);
      if (bet.is_winner) {
        hasWinner = true;
        lines.push(`🏆 Palpite ${palpite} — *GANHOU* ${formatCents(bet.prize_amount_cents)}`);
      } else if (bet.prize_amount_cents > 0 && !bet.is_winner) {
        lines.push(`↩️ Palpite ${palpite} — reembolso ${formatCents(bet.prize_amount_cents)}`);
      } else {
        lines.push(`❌ Palpite ${palpite} — não acertou`);
      }
    }

    let header;
    if (hasWinner) {
      header = '🏆 *Parabéns, você ganhou!*';
    } else if (lines.some((l) => l.includes('reembolso'))) {
      header = '📋 *Resultado do bolão* (reembolso)';
    } else {
      header = '📋 *Resultado do bolão*';
    }

    const body = [
      header,
      '',
      `Olá, ${firstName(group.name)}!`,
      '',
      `*${game.title}*`,
      `Resultado final: *${resultLine}*`,
      `(${matchLabel})`,
      '',
      ...lines,
      '',
      hasWinner
        ? 'O prêmio será enviado para sua chave PIX cadastrada.'
        : 'Obrigado por participar! Boa sorte no próximo bolão. ⚽',
      '',
      '_Bolão Online_',
    ].join('\n');

    await enqueueMessage({
      userId: parseInt(userId, 10),
      phone: group.phone,
      messageType: 'bet_result',
      referenceKey: `game_${gameId}_user_${userId}`,
      body,
    });
  }
}

module.exports = {
  isNotificationsEnabled,
  notifyPaymentConfirmed,
  notifyGameResults,
};
