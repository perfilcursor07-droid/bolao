const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pool = require('../../config/database');

const AUTH_DIR = path.join(__dirname, '..', '..', '..', 'data', 'whatsapp-auth');

const noopLogger = {
  level: 'silent',
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return this;
  },
};

const state = {
  status: 'disconnected',
  qrRaw: null,
  qrDataUrl: null,
  phone: null,
  lastError: null,
  connecting: false,
  manualLogout: false,
};

let sock = null;
let baileysModule = null;
let reconnectTimer = null;
let socketPromise = null;

async function loadBaileys() {
  if (!baileysModule) {
    try {
      baileysModule = await import('@whiskeysockets/baileys');
    } catch (err) {
      const missing =
        err.code === 'ERR_MODULE_NOT_FOUND' ||
        err.code === 'MODULE_NOT_FOUND' ||
        /Cannot find package '@whiskeysockets\/baileys'/.test(err.message || '');
      if (missing) {
        const hint = new Error(
          'Dependência @whiskeysockets/baileys não instalada. No servidor: cd ~/htdocs/bolaopix.site && npm install && pm2 restart bolaopix'
        );
        hint.code = 'BAILEYS_NOT_INSTALLED';
        throw hint;
      }
      throw err;
    }
  }
  return baileysModule;
}

function ensureAuthDir() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
}

function hasSavedSession() {
  ensureAuthDir();
  try {
    return fs.readdirSync(AUTH_DIR).some((f) => f.startsWith('creds'));
  } catch {
    return false;
  }
}

async function persistMeta(partial) {
  try {
    if (partial.phone !== undefined) {
      await pool.query(
        `INSERT INTO settings (setting_key, setting_value) VALUES ('whatsapp_last_phone', ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [partial.phone || '']
      );
    }
    if (partial.status !== undefined) {
      await pool.query(
        `INSERT INTO settings (setting_key, setting_value) VALUES ('whatsapp_link_status', ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [partial.status]
      );
    }
  } catch {
    /* ignora se settings indisponível */
  }
}

async function updateQrDataUrl(qrRaw) {
  state.qrRaw = qrRaw;
  if (qrRaw) {
    try {
      state.qrDataUrl = await QRCode.toDataURL(qrRaw, { margin: 1, width: 280 });
      state.status = 'qr';
      await persistMeta({ status: 'qr' });
    } catch {
      state.qrDataUrl = null;
    }
  } else {
    state.qrDataUrl = null;
  }
}

function extractPhoneFromSocket(socket) {
  const id = socket?.user?.id || '';
  const num = id.split(':')[0].split('@')[0];
  return num || null;
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function destroySocket() {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners();
    sock.ws?.close();
  } catch {
    /* ignora */
  }
  sock = null;
}

function shouldAutoReconnect(statusCode, DisconnectReason) {
  if (state.manualLogout) return false;
  if (!hasSavedSession()) return false;

  const noReconnect = [
    DisconnectReason.loggedOut,
    DisconnectReason.badSession,
    DisconnectReason.forbidden,
    DisconnectReason.connectionReplaced,
    DisconnectReason.multideviceMismatch,
  ];

  return !noReconnect.includes(statusCode);
}

function reconnectDelayMs(statusCode, DisconnectReason) {
  if (statusCode === DisconnectReason.restartRequired) return 500;
  if (statusCode === DisconnectReason.connectionClosed) return 1500;
  return 4000;
}

function scheduleReconnect(statusCode, DisconnectReason) {
  if (!shouldAutoReconnect(statusCode, DisconnectReason)) return;

  clearReconnectTimer();
  state.status = 'connecting';
  state.connecting = true;
  persistMeta({ status: 'connecting' }).catch(() => {});

  const delay = reconnectDelayMs(statusCode, DisconnectReason);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createSocketInternal().catch((err) => {
      state.connecting = false;
      state.lastError = err.message;
      console.error('[whatsapp] Reconexão falhou:', err.message);
    });
  }, delay);
}

async function createSocketInternal() {
  if (socketPromise) return socketPromise;

  socketPromise = (async () => {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
    } = await loadBaileys();

    ensureAuthDir();
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    destroySocket();

    state.connecting = true;
    state.status = 'connecting';
    state.lastError = null;
    await persistMeta({ status: 'connecting' });

    sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, noopLogger),
      },
      printQRInTerminal: false,
      logger: noopLogger,
      browser: ['Bolao Online', 'Chrome', '120.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      keepAliveIntervalMs: 25000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        await updateQrDataUrl(qr);
      }

      if (connection === 'connecting') {
        state.status = 'connecting';
        state.connecting = true;
      }

      if (connection === 'open') {
        state.status = 'connected';
        state.connecting = false;
        state.qrRaw = null;
        state.qrDataUrl = null;
        state.phone = extractPhoneFromSocket(sock);
        state.lastError = null;
        state.manualLogout = false;
        clearReconnectTimer();
        await persistMeta({ status: 'connected', phone: state.phone || '' });
        console.log('[whatsapp] Conectado:', state.phone || '(sem número)');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        destroySocket();
        state.connecting = false;

        if (state.manualLogout || loggedOut) {
          state.status = 'disconnected';
          state.phone = null;
          await persistMeta({ status: 'disconnected', phone: '' });
          return;
        }

        const reasonMsg = lastDisconnect?.error?.message || `Código ${statusCode || '?'}`;
        console.log('[whatsapp] Conexão fechada, reconectando…', statusCode || reasonMsg);

        if (shouldAutoReconnect(statusCode, DisconnectReason)) {
          state.lastError = null;
          scheduleReconnect(statusCode, DisconnectReason);
        } else {
          state.status = 'disconnected';
          state.lastError = reasonMsg;
          await persistMeta({ status: 'disconnected' });
        }
      }
    });

    return getPublicState();
  })();

  try {
    return await socketPromise;
  } finally {
    socketPromise = null;
  }
}

async function startConnection() {
  state.manualLogout = false;
  clearReconnectTimer();

  if (state.status === 'connected' && sock) {
    return getPublicState();
  }

  return createSocketInternal();
}

async function ensureConnected() {
  if (state.status === 'connected' && sock) return true;
  if (state.connecting || socketPromise || reconnectTimer) return false;
  if (!hasSavedSession() || state.manualLogout) return false;

  try {
    await createSocketInternal();
    return state.status === 'connected';
  } catch {
    return false;
  }
}

async function disconnect(logout = true) {
  state.manualLogout = true;
  clearReconnectTimer();
  state.connecting = false;

  if (sock && logout) {
    try {
      await sock.logout();
    } catch {
      /* ignora */
    }
  }

  destroySocket();
  state.status = 'disconnected';
  state.qrRaw = null;
  state.qrDataUrl = null;
  state.phone = null;
  await persistMeta({ status: 'disconnected', phone: '' });

  if (logout && fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }
}

async function sendTextMessage(jid, text) {
  if (!sock || state.status !== 'connected') {
    throw new Error('WhatsApp não conectado');
  }
  await sock.sendMessage(jid, { text });
}

function getPublicState() {
  let displayStatus = state.status;

  if (
    displayStatus === 'disconnected' &&
    hasSavedSession() &&
    !state.manualLogout &&
    !state.lastError &&
    (state.connecting || reconnectTimer || socketPromise)
  ) {
    displayStatus = 'connecting';
  }

  return {
    status: displayStatus,
    rawStatus: state.status,
    qrDataUrl: state.qrDataUrl,
    phone: state.phone,
    lastError: state.lastError,
    hasSession: hasSavedSession(),
    connecting: state.connecting || Boolean(reconnectTimer) || Boolean(socketPromise),
  };
}

function isConnected() {
  return state.status === 'connected' && Boolean(sock);
}

function isConnecting() {
  return state.connecting || Boolean(reconnectTimer) || Boolean(socketPromise);
}

module.exports = {
  AUTH_DIR,
  startConnection,
  ensureConnected,
  disconnect,
  sendTextMessage,
  getPublicState,
  isConnected,
  isConnecting,
  hasSavedSession,
};
