const pool = require('../config/database');
const connection = require('./whatsapp/connection');
const outbox = require('./whatsapp/outbox');
const { cleanPhone } = require('./whatsapp/phone');

async function getNotificationsEnabled() {
  const [rows] = await pool.query(
    "SELECT setting_value FROM settings WHERE setting_key = 'whatsapp_notifications_enabled' LIMIT 1"
  );
  return rows[0]?.setting_value === '1';
}

async function setNotificationsEnabled(enabled) {
  await pool.query(
    `INSERT INTO settings (setting_key, setting_value) VALUES ('whatsapp_notifications_enabled', ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [enabled ? '1' : '0']
  );
}

async function getFullStatus() {
  if (connection.hasSavedSession() && !connection.isConnected() && !connection.isConnecting()) {
    connection.ensureConnected().catch((err) => {
      console.error('[whatsapp] ensureConnected:', err.message);
    });
  }

  const conn = connection.getPublicState();
  const enabled = await getNotificationsEnabled();
  const { stats, recent } = await outbox.getOutboxStats();

  let persistedPhone = null;
  try {
    const [rows] = await pool.query(
      "SELECT setting_value FROM settings WHERE setting_key = 'whatsapp_last_phone' LIMIT 1"
    );
    persistedPhone = rows[0]?.setting_value || null;
  } catch {
    /* ignora */
  }

  return {
    ...conn,
    phone: conn.phone || persistedPhone || null,
    notificationsEnabled: enabled,
    outbox: stats,
    recentMessages: recent,
    rateLimits: outbox.RATE,
  };
}

async function initWhatsAppModule() {
  outbox.startOutboxWorker();
  if (connection.hasSavedSession()) {
    try {
      console.log('[whatsapp] Sessão encontrada, reconectando…');
      await connection.startConnection();
    } catch (err) {
      console.error('[whatsapp] Falha ao reconectar:', err.message);
    }
  }
}

async function connect() {
  return connection.startConnection();
}

async function disconnect() {
  await connection.disconnect(true);
}

async function sendTestMessage(phone, text) {
  const cleaned = cleanPhone(phone);
  if (cleaned.length < 10) {
    throw new Error('Telefone inválido');
  }
  return outbox.enqueueMessage({
    userId: null,
    phone: cleaned,
    messageType: 'test',
    referenceKey: `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    body: text || '✅ Teste de mensagem — Bolão Online',
  });
}

module.exports = {
  initWhatsAppModule,
  getFullStatus,
  connect,
  disconnect,
  sendTestMessage,
  getNotificationsEnabled,
  setNotificationsEnabled,
  isConnected: connection.isConnected,
};
