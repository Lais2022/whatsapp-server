// ============================================
// SERVIDOR WHATSAPP v4.5.0 - MUTEX ABSOLUTO
// ============================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, isJidBroadcast } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const SERVER_VERSION = '4.5.0';

const app = express();
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.SELF_URL || '';
const DATA_FOLDER = process.env.DATA_FOLDER || './data';
const AUTH_FOLDER = path.join(DATA_FOLDER, 'auth_info');
const KEEPALIVE_INTERVAL = parseInt(process.env.KEEPALIVE_INTERVAL) || 240000;

fs.mkdirSync(AUTH_FOLDER, { recursive: true });

let sock = null;
let qrCodeData = null;
let qrAttempts = 0;
const MAX_QR_ATTEMPTS = 5;

let connectionMutex = null;
let pendingReconnect = null;

let state = {
  isConnected: false,
  isReady: false,
  isAuthenticated: false,
  hasSession: false,
  qrAvailable: false,
  status: 'disconnected',
  lastConnection: null,
  reconnectAttempts: 0,
  isConnecting: false,
  messagesCount: 0,
  lastError: null,
  sessionInfo: null
};

const messages = [];
const MAX_MESSAGES = 200;

const log = (msg, data = null) => {
  const timestamp = new Date().toISOString();
  if (data) {
    console.log(`[${timestamp}] ${msg}`, typeof data === 'object' ? JSON.stringify(data) : data);
  } else {
    console.log(`[${timestamp}] ${msg}`);
  }
};

const formatPhone = (phone) => {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '55' + cleaned.substring(1);
  if (!cleaned.startsWith('55') && cleaned.length <= 11) cleaned = '55' + cleaned;
  return cleaned;
};

const checkSession = () => {
  try {
    const files = fs.readdirSync(AUTH_FOLDER).filter(f => f.endsWith('.json'));
    return files.length > 0;
  } catch { return false; }
};

const updateState = (updates) => {
  const prev = { ...state };
  state = { ...state, ...updates };
  if (prev.status !== state.status) {
    log(`📊 Status: ${prev.status} → ${state.status}`);
  }
};

const startKeepAlive = () => {
  if (!SELF_URL) {
    log('⚠️ SELF_URL não configurado - keep-alive desativado');
    return;
  }
  log(`✅ Keep-alive configurado: ${KEEPALIVE_INTERVAL}ms para ${SELF_URL}`);
  setInterval(async () => {
    try {
      const res = await fetch(`${SELF_URL}/health`);
      log(`🏓 Keep-alive ping ${res.ok ? 'OK' : 'FAIL'}`);
    } catch (err) {
      log('❌ Keep-alive falhou:', err.message);
    }
  }, KEEPALIVE_INTERVAL);
};

function scheduleReconnect(delay, reason) {
  if (pendingReconnect) {
    clearTimeout(pendingReconnect);
    pendingReconnect = null;
  }
  log(`⏰ Reconectando em ${delay}ms (${reason})`);
  pendingReconnect = setTimeout(() => {
    pendingReconnect = null;
    connectWhatsApp();
  }, delay);
}

function cancelPendingReconnect() {
  if (pendingReconnect) {
    clearTimeout(pendingReconnect);
    pendingReconnect = null;
    log('🚫 Reconexão pendente cancelada');
  }
}

async function connectWhatsApp(options = {}) {
  const { force = false, source = 'auto' } = options;
  
  if (connectionMutex) {
    if (!force) {
      log(`🔒 [${source}] Conexão bloqueada - mutex ativo`);
      return connectionMutex;
    }
    log(`⚡ [${source}] Força passagem do mutex`);
  }
  
  let resolveMutex;
  connectionMutex = new Promise(resolve => { resolveMutex = resolve; });
  
  log(`🔄 [${source}] Iniciando conexão WhatsApp...`);
  updateState({ isConnecting: true, status: 'connecting', lastError: null });
  
  const hasSession = checkSession();
  updateState({ hasSession });

  try {
    if (sock) {
      log('🔌 Fechando socket anterior...');
      try {
        sock.ev.removeAllListeners();
        sock.end();
      } catch (e) {}
      sock = null;
    }
    
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    
    log(`📱 Baileys v${version.join('.')}`);

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: authState,
      browser: ['VoxyAI CRM', 'Chrome', '120'],
      connectTimeoutMs: 60000,
      shouldIgnoreJid: jid => isJidBroadcast(jid),
      markOnlineOnConnect: true,
      retryRequestDelayMs: 500,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;
      
      log('📡 Connection update:', { connection, hasQR: !!qr });

      if (qr && !state.isConnected && qrAttempts < MAX_QR_ATTEMPTS) {
        qrCodeData = await qrcode.toDataURL(qr);
        qrAttempts++;
        log('📲 QR Code gerado');
        updateState({ qrAvailable: true, status: 'waiting_qr' });
        resolveMutex?.();
        connectionMutex = null;
      }

      if (connection === 'close') {
        const boom = new Boom(lastDisconnect?.error);
        const statusCode = boom?.output?.statusCode;
        const reason = DisconnectReason[statusCode] || statusCode;
        
        log(`❌ Conexão fechada: ${JSON.stringify({statusCode, reason})}`);
        
        resolveMutex?.();
        connectionMutex = null;
        
        updateState({ 
          isConnected: false, 
          isReady: false,
          isAuthenticated: false,
          isConnecting: false,
          qrAvailable: false,
          status: 'disconnected'
        });

        if (statusCode === 440) {
          log('⚠️ connectionReplaced (440) - NÃO reconectando automaticamente');
          updateState({ lastError: 'Outra sessão assumiu. Use /force-reset.' });
          return;
        }

        if (statusCode === DisconnectReason.loggedOut || 
            statusCode === DisconnectReason.badSession ||
            statusCode === 401) {
          log('🗑️ Sessão inválida - limpando...');
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          fs.mkdirSync(AUTH_FOLDER, { recursive: true });
          qrCodeData = null;
          qrAttempts = 0;
          updateState({ hasSession: false, sessionInfo: null });
          scheduleReconnect(2000, 'session_invalid');
          return;
        }
        
        const attempt = state.reconnectAttempts + 1;
        const delay = Math.min(5000 * attempt, 30000);
        updateState({ reconnectAttempts: attempt });
        scheduleReconnect(delay, `tentativa ${attempt}`);
      }

      if (connection === 'open') {
        log('✅ Conexão estabelecida!');
        
        resolveMutex?.();
        connectionMutex = null;
        
        qrCodeData = null;
        qrAttempts = 0;
        updateState({
          isConnected: true,
          isAuthenticated: true,
          isConnecting: false,
          qrAvailable: false,
          hasSession: true,
          status: 'authenticated',
          lastConnection: new Date().toISOString(),
          reconnectAttempts: 0,
          lastError: null
        });
        
        if (sock?.user) {
          updateState({ sessionInfo: { id: sock.user.id, name: sock.user.name || 'User' } });
        }
        
        setTimeout(() => {
          if (state.isConnected && !state.isReady) {
            log('✅ Timeout - marcando como READY');
            updateState({ isReady: true, status: 'ready' });
          }
        }, 3000);
      }

      if (receivedPendingNotifications === true && state.isConnected) {
        log('✅ Primeira mensagem recebida - sessão READY');
        updateState({ isReady: true, status: 'ready' });
      }
    });

    sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
      for (const msg of msgs) {
        try {
          if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;
          if (msg.key.remoteJid?.includes('@g.us')) continue;
          
          const text = msg.message.conversation || 
                       msg.message.extendedTextMessage?.text || 
                       msg.message.imageMessage?.caption || '';
          
          const newMessage = {
            id: msg.key.id,
            from: msg.key.remoteJid,
            fromMe: msg.key.fromMe,
            text,
            type: Object.keys(msg.message)[0],
            timestamp: Date.now(),
            pushName: msg.pushName || 'Desconhecido',
            hasMedia: !!msg.message.imageMessage || !!msg.message.videoMessage || 
                     !!msg.message.audioMessage || !!msg.message.documentMessage
          };
          
          messages.unshift(newMessage);
          if (messages.length > MAX_MESSAGES) messages.pop();
          
          log(`📩 ${newMessage.fromMe ? 'ENVIADA' : 'RECEBIDA'}: ${text.substring(0, 50)}`);
        } catch (err) {
          log('❌ Erro ao processar mensagem:', err.message);
        }
      }
    });

  } catch (err) {
    log('❌ Erro na conexão:', err.message);
    resolveMutex?.();
    connectionMutex = null;
    updateState({ 
      isConnecting: false, 
      status: 'error',
      lastError: err.message,
      isReady: false
    });
    scheduleReconnect(5000, 'connection_error');
  }
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: SERVER_VERSION, 
    timestamp: new Date().toISOString(),
    whatsapp: { connected: state.isConnected, ready: state.isReady, status: state.status }
  });
});

app.get('/status', (req, res) => {
  res.json({
    ...state,
    connected: state.isConnected,
    ready: state.isReady,
    hasQR: state.qrAvailable,
    messagesCount: messages.length,
    version: SERVER_VERSION,
    uptime: process.uptime()
  });
});

app.get('/whatsapp-status', (req, res) => {
  res.json({
    connected: state.isConnected,
    isConnected: state.isConnected,
    isReady: state.isReady,
    isAuthenticated: state.isAuthenticated,
    hasSession: state.hasSession,
    qrAvailable: state.qrAvailable,
    qrCode: qrCodeData,
    status: state.status,
    lastError: state.lastError,
    sessionInfo: state.sessionInfo,
    version: SERVER_VERSION
  });
});

app.get('/qr', (req, res) => {
  res.json({
    qr: qrCodeData,
    qrCode: qrCodeData,
    available: !!qrCodeData,
    isConnected: state.isConnected,
    isReady: state.isReady,
    status: state.status
  });
});

app.get('/qr.png', async (req, res) => {
  if (!qrCodeData) return res.status(202).send('QR não disponível');
  const base64 = qrCodeData.split(',')[1];
  const buffer = Buffer.from(base64, 'base64');
  res.set('Content-Type', 'image/png');
  res.send(buffer);
});

app.get('/connect', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Conectar WhatsApp - v${SERVER_VERSION}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: white; border-radius: 20px; padding: 40px; text-align: center; box-shadow: 0 25px 50px rgba(0,0,0,0.25); max-width: 450px; width: 90%; }
    h1 { color: #25d366; margin-bottom: 10px; }
    .version { color: #999; font-size: 12px; margin-bottom: 20px; }
    #qr { margin: 20px 0; min-height: 256px; display: flex; align-items: center; justify-content: center; }
    #qr img { border-radius: 10px; max-width: 256px; }
    .status { padding: 12px 24px; border-radius: 30px; font-weight: 600; margin-top: 20px; display: inline-block; }
    .ready { background: #dcfce7; color: #16a34a; }
    .waiting { background: #fef3c7; color: #d97706; }
    .error { background: #fee2e2; color: #dc2626; }
    .spinner { width: 50px; height: 50px; border: 4px solid #f3f3f3; border-top: 4px solid #667eea; border-radius: 50%; animation: spin 1s linear infinite; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .btn { background: #667eea; color: white; border: none; padding: 12px 30px; border-radius: 30px; cursor: pointer; font-size: 16px; margin-top: 15px; }
    .btn:hover { background: #5a67d8; }
    .btn-danger { background: #dc2626; }
  </style>
</head>
<body>
  <div class="card">
    <h1>📱 WhatsApp</h1>
    <p class="version">VoxyAI CRM - v${SERVER_VERSION}</p>
    <div id="qr"><div class="spinner"></div></div>
    <div id="status" class="status waiting">Carregando...</div>
    <div id="actions"></div>
  </div>
  <script>
    async function check() {
      try {
        const r = await fetch('/whatsapp-status');
        const d = await r.json();
        const qrEl = document.getElementById('qr');
        const statusEl = document.getElementById('status');
        const actionsEl = document.getElementById('actions');
        
        if (d.isReady) {
          qrEl.innerHTML = '<div style="font-size:80px">✅</div>';
          statusEl.className = 'status ready';
          statusEl.textContent = 'PRONTO!';
          actionsEl.innerHTML = '<button class="btn btn-danger" onclick="reset()">Desconectar</button>';
        } else if (d.qrCode) {
          qrEl.innerHTML = '<img src="' + d.qrCode + '" alt="QR">';
          statusEl.className = 'status waiting';
          statusEl.textContent = 'Escaneie o QR Code';
          actionsEl.innerHTML = '';
        } else if (d.lastError) {
          qrEl.innerHTML = '<div style="font-size:60px">⚠️</div>';
          statusEl.className = 'status error';
          statusEl.textContent = d.lastError;
          actionsEl.innerHTML = '<button class="btn" onclick="reset()">Gerar Novo QR</button>';
        } else {
          qrEl.innerHTML = '<div class="spinner"></div>';
          statusEl.className = 'status waiting';
          statusEl.textContent = 'Gerando QR...';
          actionsEl.innerHTML = '<button class="btn" onclick="reset()">Forçar</button>';
        }
      } catch(e) {
        document.getElementById('status').textContent = 'Erro';
      }
    }
    async function reset() {
      await fetch('/force-reset', {method:'POST'});
      setTimeout(check, 2000);
    }
    check();
    setInterval(check, 3000);
  </script>
</body>
</html>`);
});

app.post('/send', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const text = req.body.message || req.body.text;
  
  if (!phone || !text) return res.status(400).json({ ok: false, error: 'phone e message obrigatórios' });
  if (!state.isReady || !sock) return res.status(503).json({ ok: false, error: 'WhatsApp não está pronto' });
  
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    const result = await sock.sendMessage(jid, { text });
    log(`✅ Mensagem enviada: ${JSON.stringify({phone})}`);
    res.json({ ok: true, success: true, messageId: result?.key?.id });
  } catch (err) {
    log('❌ Erro:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/send-image', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const imageData = req.body.url || req.body.image;
  const caption = req.body.caption || '';
  
  if (!phone || !imageData) return res.status(400).json({ ok: false, error: 'phone e image obrigatórios' });
  if (!state.isReady || !sock) return res.status(503).json({ ok: false, error: 'WhatsApp não está pronto' });
  
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    let imagePayload = imageData.startsWith('http') ? { url: imageData } : Buffer.from(imageData, 'base64');
    const result = await sock.sendMessage(jid, { image: imagePayload, caption });
    log(`✅ Imagem enviada: ${JSON.stringify({phone})}`);
    res.json({ ok: true, success: true, messageId: result?.key?.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/send-audio', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const audioData = req.body.url || req.body.audio;
  const ptt = req.body.ptt !== false;
  
  if (!phone || !audioData) return res.status(400).json({ ok: false, error: 'phone e audio obrigatórios' });
  if (!state.isReady || !sock) return res.status(503).json({ ok: false, error: 'WhatsApp não está pronto' });
  
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    let audioPayload = audioData.startsWith('http') ? { url: audioData } : Buffer.from(audioData, 'base64');
    const result = await sock.sendMessage(jid, { audio: audioPayload, mimetype: 'audio/ogg; codecs=opus', ptt });
    log(`✅ Áudio enviado: ${JSON.stringify({phone})}`);
    res.json({ ok: true, success: true, messageId: result?.key?.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/send-video', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const videoData = req.body.url || req.body.video;
  const caption = req.body.caption || '';
  
  if (!phone || !videoData) return res.status(400).json({ ok: false, error: 'phone e video obrigatórios' });
  if (!state.isReady || !sock) return res.status(503).json({ ok: false, error: 'WhatsApp não está pronto' });
  
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    let videoPayload = videoData.startsWith('http') ? { url: videoData } : Buffer.from(videoData, 'base64');
    const result = await sock.sendMessage(jid, { video: videoPayload, caption });
    res.json({ ok: true, success: true, messageId: result?.key?.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/send-document', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const docData = req.body.url || req.body.document;
  const filename = req.body.filename || 'documento';
  
  if (!phone || !docData) return res.status(400).json({ ok: false, error: 'phone e document obrigatórios' });
  if (!state.isReady || !sock) return res.status(503).json({ ok: false, error: 'WhatsApp não está pronto' });
  
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    let docPayload = docData.startsWith('http') ? { url: docData } : Buffer.from(docData, 'base64');
    const result = await sock.sendMessage(jid, { document: docPayload, fileName: filename, mimetype: 'application/octet-stream' });
    res.json({ ok: true, success: true, messageId: result?.key?.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({ ok: true, messages: messages.slice(0, limit), count: messages.length, isReady: state.isReady });
});

app.post('/logout', async (req, res) => {
  log('👋 Logout');
  cancelPendingReconnect();
  try { if (sock) { await sock.logout(); sock.ev.removeAllListeners(); sock = null; } } catch {}
  fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  qrCodeData = null; qrAttempts = 0; connectionMutex = null;
  updateState({ isConnected: false, isReady: false, isAuthenticated: false, hasSession: false, qrAvailable: false, status: 'disconnected', isConnecting: false, sessionInfo: null, lastError: null, reconnectAttempts: 0 });
  setTimeout(() => connectWhatsApp({ source: 'logout' }), 1500);
  res.json({ ok: true, status: 'logged out' });
});

app.post('/force-reset', async (req, res) => {
  log('🔄 Force reset');
  cancelPendingReconnect();
  try { if (sock) { sock.ev.removeAllListeners(); sock.end(); sock = null; } } catch {}
  fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  qrCodeData = null; qrAttempts = 0; connectionMutex = null;
  updateState({ isConnected: false, isReady: false, isAuthenticated: false, hasSession: false, qrAvailable: false, status: 'disconnected', isConnecting: false, reconnectAttempts: 0, sessionInfo: null, lastError: null });
  setTimeout(() => connectWhatsApp({ force: true, source: 'force-reset' }), 1000);
  res.json({ ok: true, status: 'reset' });
});

app.get('/debug', (req, res) => {
  res.json({ state, messagesCount: messages.length, hasSocket: !!sock, hasMutex: !!connectionMutex, version: SERVER_VERSION });
});

app.listen(PORT, () => {
  log(`🚀 Servidor WhatsApp v${SERVER_VERSION} na porta ${PORT}`);
  startKeepAlive();
  connectWhatsApp({ source: 'startup' });
});

process.on('SIGTERM', () => { log('⏹️ SIGTERM'); if (sock) try { sock.end(); } catch {} process.exit(0); });
process.on('SIGINT', () => { log('⏹️ SIGINT'); if (sock) try { sock.end(); } catch {} process.exit(0); });
process.on('uncaughtException', (err) => { log('💥 Exception:', err.message); });
process.on('unhandledRejection', (reason) => { log('💥 Rejection:', String(reason)); });
