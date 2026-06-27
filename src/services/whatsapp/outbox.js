const pool = require('../../config/database');
const { phoneToJid } = require('./phone');
const { isConnected, sendTextMessage } = require('./connection');

/** Limites conservadores para evitar bloqueio do número. */
const RATE = {
  minDelayMs: 6000,
  maxJitterMs: 6000,
  maxPerMinute: 6,
  maxPerHour: 150,
  maxAttempts: 3,
};

const sendHistory = [];
let processing = false;
let lastSendAt = 0;
let workerTimer = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pruneHistory() {
  const hourAgo = Date.now() - 3600000;
  while (sendHistory.length && sendHistory[0] < hourAgo) {
    sendHistory.shift();
  }
}

function canSendNow() {
  pruneHistory();
  const now = Date.now();
  const lastMinute = sendHistory.filter((t) => now - t < 60000);
  if (lastMinute.length >= RATE.maxPerMinute) return false;
  if (sendHistory.length >= RATE.maxPerHour) return false;
  if (now - lastSendAt < RATE.minDelayMs) return false;
  return true;
}

function getWaitMs() {
  const now = Date.now();
  const sinceLast = now - lastSendAt;
  const base = Math.max(0, RATE.minDelayMs - sinceLast);
  const jitter = Math.floor(Math.random() * RATE.maxJitterMs);
  return base + jitter;
}

async function enqueueMessage({ userId, phone, messageType, referenceKey, body }) {
  try {
    await pool.query(
      `INSERT INTO whatsapp_outbox (user_id, phone, message_type, reference_key, body, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [userId || null, phone, messageType, referenceKey, body]
    );
    return { queued: true };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return { queued: false, duplicate: true };
    }
    throw err;
  }
}

async function markSkipped(id, reason) {
  await pool.query(
    `UPDATE whatsapp_outbox SET status = 'skipped', error_message = ?, sent_at = NOW() WHERE id = ?`,
    [reason.slice(0, 255), id]
  );
}

async function markSent(id) {
  await pool.query(
    `UPDATE whatsapp_outbox SET status = 'sent', sent_at = NOW(), error_message = NULL WHERE id = ?`,
    [id]
  );
}

async function markFailed(id, errorMessage, attempts) {
  const status = attempts >= RATE.maxAttempts ? 'failed' : 'pending';
  await pool.query(
    `UPDATE whatsapp_outbox SET status = ?, attempts = ?, error_message = ? WHERE id = ?`,
    [status, attempts, errorMessage.slice(0, 255), id]
  );
}

async function processOne() {
  if (!isConnected()) return false;

  if (!canSendNow()) {
    await sleep(getWaitMs());
    if (!canSendNow()) return false;
  }

  const [rows] = await pool.query(
    `SELECT * FROM whatsapp_outbox
     WHERE status = 'pending' AND attempts < ?
     ORDER BY created_at ASC
     LIMIT 1`,
    [RATE.maxAttempts]
  );

  if (rows.length === 0) return false;

  const msg = rows[0];
  const jid = phoneToJid(msg.phone);
  if (!jid) {
    await markSkipped(msg.id, 'Telefone inválido');
    return true;
  }

  await pool.query(`UPDATE whatsapp_outbox SET status = 'processing' WHERE id = ?`, [msg.id]);

  const wait = getWaitMs();
  if (wait > 0) await sleep(wait);

  try {
    await sendTextMessage(jid, msg.body);
    lastSendAt = Date.now();
    sendHistory.push(lastSendAt);
    await markSent(msg.id);
    return true;
  } catch (err) {
    const attempts = (msg.attempts || 0) + 1;
    await markFailed(msg.id, err.message || 'Erro ao enviar', attempts);
    lastSendAt = Date.now();
    return true;
  }
}

async function processQueueLoop() {
  if (processing) return;
  processing = true;
  try {
    let processed = 0;
    while (processed < 3 && (await processOne())) {
      processed += 1;
    }
  } catch (err) {
    console.error('[whatsapp/outbox]', err.message);
  } finally {
    processing = false;
  }
}

function startOutboxWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    processQueueLoop().catch((err) => console.error('[whatsapp/outbox]', err.message));
  }, 15000);
  setTimeout(() => processQueueLoop().catch(() => {}), 3000);
}

async function getOutboxStats() {
  const [rows] = await pool.query(
    `SELECT status, COUNT(*) as c FROM whatsapp_outbox GROUP BY status`
  );
  const stats = { pending: 0, sent: 0, failed: 0, skipped: 0, processing: 0 };
  for (const r of rows) {
    stats[r.status] = r.c;
  }

  const [recent] = await pool.query(
    `SELECT id, phone, message_type, status, error_message, created_at, sent_at
     FROM whatsapp_outbox ORDER BY id DESC LIMIT 15`
  );

  return { stats, recent };
}

module.exports = {
  RATE,
  enqueueMessage,
  processQueueLoop,
  startOutboxWorker,
  getOutboxStats,
};
