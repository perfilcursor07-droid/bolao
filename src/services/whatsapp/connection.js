const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pool = require('../../config/database');
const { resolveRecipientJid } = require('./resolve');

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
/** Evita abrir vários sockets ao mesmo tempo (causa connectionReplaced). */
let socketBusy = false;

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

function clearAuthFiles() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  } catch (err) {
    console.error('[whatsapp] Erro ao limpar sessão:', err.message);
  }
}

function hasSavedSession() {
  ensureAuthDir();
  try {
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (!fs.existsSync(credsPath)) return false;
    const raw = fs.readFileSync(credsPath, 'utf8');
    const creds = JSON.parse(raw);
    return Boolean(creds?.me?.id || creds?.registered);
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
    /* ignora */
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

function releaseSocketBusy() {
  socketBusy = false;
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
  if (statusCode === DisconnectReason.restartRequired) return 800;
  if (statusCode === DisconnectReason.connectionClosed) return 2000;
  return 5000;
}

function scheduleReconnect(statusCode, DisconnectReason) {
  if (!shouldAutoReconnect(statusCode, DisconnectReason)) {
    releaseSocketBusy();
    return;
  }

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
      releaseSocketBusy();
      console.error('[whatsapp] Reconexão falhou:', err.message);
    });
  }, delay);
}

async function createSocketInternal() {
  if (state.status === 'connected' && sock) {
    return getPublicState();
  }
  if (socketBusy) {
    return getPublicState();
  }

  socketBusy = true;

  try {
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

    console.log('[whatsapp] Abrindo socket…');

    sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, noopLogger),
      },
      printQRInTerminal: false,
      logger: noopLogger,
      browser: ['Bolao Online', 'Chrome', '120.0.0'],
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      keepAliveIntervalMs: 30000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      getMessage: async () => undefined,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        releaseSocketBusy();
        await updateQrDataUrl(qr);
        console.log('[whatsapp] QR Code gerado — escaneie no celular');
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
        releaseSocketBusy();
        await persistMeta({ status: 'connected', phone: state.phone || '' });
        console.log('[whatsapp] Conectado:', state.phone || '(sem número)');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        destroySocket();
        state.connecting = false;

        if (state.manualLogout) {
          state.status = 'disconnected';
          state.phone = null;
          releaseSocketBusy();
          await persistMeta({ status: 'disconnected', phone: '' });
          console.log('[whatsapp] Desconectado pelo admin');
          return;
        }

        if (loggedOut || statusCode === DisconnectReason.badSession) {
          clearReconnectTimer();
          clearAuthFiles();
          state.status = 'disconnected';
          state.phone = null;
          state.lastError =
            'Sessão inválida ou expirada. Clique em Desconectar (se ainda conectando) e depois Conectar para escanear um novo QR.';
          releaseSocketBusy();
          await persistMeta({ status: 'disconnected', phone: '' });
          console.log('[whatsapp] Sessão inválida removida — código', statusCode);
          return;
        }

        const reasonMsg = lastDisconnect?.error?.message || `Código ${statusCode || '?'}`;
        console.log('[whatsapp] Conexão fechada — código', statusCode, '—', reasonMsg);

        if (shouldAutoReconnect(statusCode, DisconnectReason)) {
          state.lastError = null;
          releaseSocketBusy();
          scheduleReconnect(statusCode, DisconnectReason);
        } else {
          state.status = 'disconnected';
          state.lastError = `Falha ${statusCode}: ${reasonMsg}. Desconecte e escaneie o QR novamente.`;
          releaseSocketBusy();
          await persistMeta({ status: 'disconnected' });
        }
      }
    });

    return getPublicState();
  } catch (err) {
    state.status = 'disconnected';
    state.connecting = false;
    state.lastError = err.message;
    releaseSocketBusy();
    throw err;
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
  if (socketBusy || reconnectTimer) return false;
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
  releaseSocketBusy();

  if (sock && logout) {
    try {
      await sock.logout();
    } catch {
      /* ignora — socket pode já estar morto */
    }
  }

  destroySocket();
  state.status = 'disconnected';
  state.qrRaw = null;
  state.qrDataUrl = null;
  state.phone = null;
  state.lastError = null;
  await persistMeta({ status: 'disconnected', phone: '' });

  clearAuthFiles();
}

async function sendTextMessage(phone, text) {
  if (!sock || state.status !== 'connected') {
    throw new Error('WhatsApp não conectado');
  }

  const { jid, normalized } = await resolveRecipientJid(sock, phone);
  const sent = await sock.sendMessage(jid, { text });

  if (!sent?.key?.id) {
    throw new Error('WhatsApp não confirmou o envio da mensagem');
  }

  console.log('[whatsapp] Enviado para', normalized, '→', jid, 'msg', sent.key.id);
  return { jid, normalized, messageId: sent.key.id };
}

function getPublicState() {
  let displayStatus = state.status;

  if (
    displayStatus === 'disconnected' &&
    hasSavedSession() &&
    !state.manualLogout &&
    !state.lastError &&
    (state.connecting || reconnectTimer || socketBusy)
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
    connecting: state.connecting || Boolean(reconnectTimer) || socketBusy,
  };
}

function isConnected() {
  return state.status === 'connected' && Boolean(sock);
}

function isConnecting() {
  return state.connecting || Boolean(reconnectTimer) || socketBusy;
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
