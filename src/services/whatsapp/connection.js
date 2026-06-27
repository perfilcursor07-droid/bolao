const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

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
  status: 'disconnected', // disconnected | connecting | connected | qr
  qrRaw: null,
  qrDataUrl: null,
  phone: null,
  lastError: null,
  connecting: false,
};

let sock = null;
let saveCredsFn = null;
let baileysModule = null;

async function loadBaileys() {
  if (!baileysModule) {
    baileysModule = await import('@whiskeysockets/baileys');
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
  return fs.readdirSync(AUTH_DIR).some((f) => f.startsWith('creds'));
}

async function updateQrDataUrl(qrRaw) {
  state.qrRaw = qrRaw;
  if (qrRaw) {
    try {
      state.qrDataUrl = await QRCode.toDataURL(qrRaw, { margin: 1, width: 280 });
      state.status = 'qr';
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

async function startConnection() {
  if (state.connecting || state.status === 'connected') {
    return getPublicState();
  }

  state.connecting = true;
  state.lastError = null;
  state.status = 'connecting';

  try {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
    } = await loadBaileys();

    ensureAuthDir();
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    saveCredsFn = saveCreds;

    const { version } = await fetchLatestBaileysVersion();

    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.ws?.close();
      } catch {
        /* ignora */
      }
      sock = null;
    }

    sock = makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      logger: noopLogger,
      browser: ['Bolao Online', 'Chrome', '120.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        await updateQrDataUrl(qr);
      }

      if (connection === 'open') {
        state.status = 'connected';
        state.qrRaw = null;
        state.qrDataUrl = null;
        state.phone = extractPhoneFromSocket(sock);
        state.connecting = false;
        state.lastError = null;
      }

      if (connection === 'close') {
        state.connecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          state.status = 'disconnected';
          state.phone = null;
          sock = null;
          return;
        }

        state.status = 'disconnected';
        state.lastError = lastDisconnect?.error?.message || 'Conexão encerrada';

        // Reconectar apenas se havia sessão salva e não foi logout manual
        if (hasSavedSession() && !loggedOut) {
          setTimeout(() => {
            startConnection().catch((err) => {
              state.lastError = err.message;
            });
          }, 5000);
        }
      }
    });

    return getPublicState();
  } catch (err) {
    state.status = 'disconnected';
    state.connecting = false;
    state.lastError = err.message;
    throw err;
  }
}

async function disconnect(logout = true) {
  state.connecting = false;
  if (sock && logout) {
    try {
      await sock.logout();
    } catch {
      /* ignora */
    }
  }
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.ws?.close();
    } catch {
      /* ignora */
    }
  }
  sock = null;
  state.status = 'disconnected';
  state.qrRaw = null;
  state.qrDataUrl = null;
  state.phone = null;

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

function getSocket() {
  return sock;
}

function getPublicState() {
  return {
    status: state.status,
    qrDataUrl: state.qrDataUrl,
    phone: state.phone,
    lastError: state.lastError,
    hasSession: hasSavedSession(),
    connecting: state.connecting,
  };
}

function isConnected() {
  return state.status === 'connected' && Boolean(sock);
}

module.exports = {
  AUTH_DIR,
  startConnection,
  disconnect,
  sendTextMessage,
  getSocket,
  getPublicState,
  isConnected,
  hasSavedSession,
};
