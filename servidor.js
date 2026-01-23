const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, isJidBroadcast } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

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

let state = {
  isConnected: false,
  hasSession: false,
  qrAvailable: false,
  status: 'disconnected',
  lastConnection: null,
  reconnectAttempts: 0,
  isConnecting: false,
  messagesCount: 0
};

const messages = [];
const MAX_MESSAGES = 100;

const log = (msg, data = null) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${msg}`, data ? JSON.stringify(data) : '');
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
  state = { ...state, ...updates };
  log('Estado atualizado:', state);
};

const startKeepAlive = () => {
  if (!SELF_URL) {
    log('SELF_URL não configurado - keep-alive desativado');
    return;
  }
  setInterval(async () => {
    try {
      const res = await fetch(`${SELF_URL}/health`);
      log(`Keep-alive: ${res.status}`);
    } catch (err) {
      log('Keep-alive falhou:', err.message);
    }
  }, KEEPALIVE_INTERVAL);
  log(`Keep-alive ativo: ${KEEPALIVE_INTERVAL}ms`);
};

async function connectWhatsApp() {
  if (state.isConnecting) {
    log('Já está conectando...');
    return;
  }
  
  updateState({ isConnecting: true, status: 'connecting' });
  
  const hasSession = checkSession();
  updateState({ hasSession });
  log(hasSession ? 'Sessão existente encontrada' : 'Nova sessão será criada');

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    
    log(`Baileys v${version.join('.')}`);

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: authState,
      browser: ['VoxyAI CRM', 'Chrome', '120'],
      connectTimeoutMs: 60000,
      shouldIgnoreJid: jid => isJidBroadcast(jid)
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !state.isConnected && qrAttempts < MAX_QR_ATTEMPTS) {
        log('Novo QR Code gerado');
        qrCodeData = await qrcode.toDataURL(qr);
        qrAttempts++;
        updateState({ qrAvailable: true, status: 'waiting_qr' });
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        log(`Conexão fechada: ${statusCode}`);
        
        updateState({ 
          isConnected: false, 
          isConnecting: false,
          qrAvailable: false,
          status: 'disconnected'
        });

        if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession) {
          log('Limpando sessão inválida...');
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          fs.mkdirSync(AUTH_FOLDER, { recursive: true });
          qrCodeData = null;
          qrAttempts = 0;
          updateState({ hasSession: false });
          setTimeout(connectWhatsApp, 2000);
        } else if (shouldReconnect) {
          const delay = Math.min(5000 + (state.reconnectAttempts * 2000), 30000);
          log(`Reconectando em ${delay}ms...`);
          updateState({ reconnectAttempts: state.reconnectAttempts + 1 });
          setTimeout(connectWhatsApp, delay);
        }
      }

      if (connection === 'open') {
        log('WhatsApp conectado!');
        qrCodeData = null;
        qrAttempts = 0;
        updateState({
          isConnected: true,
          isConnecting: false,
          qrAvailable: false,
          hasSession: true,
          status: 'connected',
          lastConnection: new Date().toISOString(),
          reconnectAttempts: 0
        });
      }
    });

    sock.ev.on('messages.upsert', ({ messages: msgs }) => {
      for (const msg of msgs) {
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;
        
        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     msg.message.imageMessage?.caption || '';
        
        messages.unshift({
          id: msg.key.id,
          from: msg.key.remoteJid,
          fromMe: msg.key.fromMe,
          text,
          timestamp: Date.now(),
          pushName: msg.pushName
        });
        
        if (messages.length > MAX_MESSAGES) messages.pop();
        updateState({ messagesCount: messages.length });
        
        log(`Mensagem de ${msg.pushName}: ${text.substring(0, 50)}`);
      }
    });

  } catch (err) {
    log('Erro na conexão:', err.message);
    updateState({ isConnecting: false, status: 'error' });
    setTimeout(connectWhatsApp, 5000);
  }
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '4.2.0', timestamp: new Date().toISOString() });
});

app.get('/status', (req, res) => {
  res.json({
    ...state,
    connected: state.isConnected,
    hasQR: state.qrAvailable,
    messagesCount: messages.length,
    version: '4.2.0',
    uptime: process.uptime()
  });
});

app.get('/whatsapp-status', (req, res) => {
  res.json({
    connected: state.isConnected,
    isConnected: state.isConnected,
    hasSession: state.hasSession,
    qrAvailable: state.qrAvailable,
    qrCode: qrCodeData,
    status: state.status,
    version: '4.2.0'
  });
});

app.get('/qr', (req, res) => {
  res.json({
    qr: qrCodeData,
    qrCode: qrCodeData,
    available: !!qrCodeData,
    isConnected: state.isConnected,
    status: state.status
  });
});

app.get('/qr.png', async (req, res) => {
  if (!qrCodeData) {
    return res.status(202).send('QR não disponível. Acesse /connect');
  }
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
  <title>Conectar WhatsApp</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: white; border-radius: 20px; padding: 40px; text-align: center; box-shadow: 0 25px 50px rgba(0,0,0,0.25); max-width: 400px; width: 90%; }
    h1 { color: #25d366; margin-bottom: 10px; font-size: 24px; }
    .subtitle { color: #666; margin-bottom: 30px; }
    #qr { margin: 20px 0; min-height: 256px; display: flex; align-items: center; justify-content: center; }
    #qr img { border-radius: 10px; max-width: 256px; }
    .status { padding: 12px 24px; border-radius: 30px; font-weight: 600; margin-top: 20px; display: inline-block; }
    .connected { background: #dcfce7; color: #16a34a; }
    .waiting { background: #fef3c7; color: #d97706; }
    .error { background: #fee2e2; color: #dc2626; }
    .spinner { width: 50px; height: 50px; border: 4px solid #f3f3f3; border-top: 4px solid #667eea; border-radius: 50%; animation: spin 1s linear infinite; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .btn { background: #667eea; color: white; border: none; padding: 12px 30px; border-radius: 30px; cursor: pointer; font-size: 16px; margin-top: 20px; }
    .btn:hover { background: #5a67d8; }
    .btn-danger { background: #dc2626; }
    .btn-danger:hover { background: #b91c1c; }
  </style>
</head>
<body>
  <div class="card">
    <h1>📱 WhatsApp</h1>
    <p class="subtitle">VoxyAI CRM</p>
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
        if (d.isConnected) {
          qrEl.innerHTML = '<div style="font-size:80px">✅</div>';
          statusEl.className = 'status connected';
          statusEl.textContent = 'Conectado!';
          actionsEl.innerHTML = '<button class="btn btn-danger" onclick="logout()">Desconectar</button>';
        } else if (d.qrCode) {
          qrEl.innerHTML = '<img src="' + d.qrCode + '" alt="QR">';
          statusEl.className = 'status waiting';
          statusEl.textContent = 'Escaneie o QR Code';
          actionsEl.innerHTML = '';
        } else {
          qrEl.innerHTML = '<div class="spinner"></div>';
          statusEl.className = 'status waiting';
          statusEl.textContent = 'Gerando QR Code...';
          actionsEl.innerHTML = '<button class="btn" onclick="reset()">Forçar Reset</button>';
        }
      } catch(e) {
        document.getElementById('status').className = 'status error';
        document.getElementById('status').textContent = 'Erro de conexão';
      }
    }
    async function logout() { await fetch('/logout', {method:'POST'}); setTimeout(check, 1000); }
    async function reset() { await fetch('/force-reset', {method:'POST'}); setTimeout(check, 2000); }
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
  if (!state.isConnected || !sock) return res.status(503).json({ ok: false, error: 'WhatsApp não conectado' });
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text });
    log(`Mensagem enviada para ${phone}`);
    res.json({ ok: true, success: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/send-image', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const url = req.body.url || req.body.image;
  const caption = req.body.caption || '';
  if (!phone || !url) return res.status(400).json({ ok: false, error: 'phone e url obrigatórios' });
  if (!state.isConnected || !sock) return res.status(503).json({ ok: false, error: 'WhatsApp não conectado' });
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    await sock.sendMessage(jid, { image: { url }, caption });
    res.json({ ok: true, success: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/send-audio', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const url = req.body.url || req.body.audio;
  if (!phone || !url) return res.status(400).json({ ok: false, error: 'phone e url obrigatórios' });
  if (!state.isConnected || !sock) return res.status(503).json({ ok: false, error: 'WhatsApp não conectado' });
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    await sock.sendMessage(jid, { audio: { url }, mimetype: 'audio/ogg; codecs=opus', ptt: true });
    res.json({ ok: true, success: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/send-video', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const url = req.body.url || req.body.video;
  const caption = req.body.caption || '';
  if (!phone || !url) return res.status(400).json({ ok: false, error: 'phone e url obrigatórios' });
  if (!state.isConnected || !sock) return res.status(503).json({ ok: false, error: 'WhatsApp não conectado' });
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    await sock.sendMessage(jid, { video: { url }, caption });
    res.json({ ok: true, success: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/send-document', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const url = req.body.url || req.body.document;
  const filename = req.body.filename || 'documento';
  if (!phone || !url) return res.status(400).json({ ok: false, error: 'phone e url obrigatórios' });
  if (!state.isConnected || !sock) return res.status(503).json({ ok: false, error: 'WhatsApp não conectado' });
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    await sock.sendMessage(jid, { document: { url }, fileName: filename });
    res.json({ ok: true, success: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/messages', (req, res) => {
  res.json({ ok: true, messages, count: messages.length });
});

app.post('/logout', async (req, res) => {
  log('Logout solicitado');
  try { if (sock) { await sock.logout(); sock = null; } } catch {}
  fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  qrCodeData = null;
  qrAttempts = 0;
  updateState({ isConnected: false, hasSession: false, qrAvailable: false, status: 'disconnected', isConnecting: false });
  setTimeout(connectWhatsApp, 1000);
  res.json({ ok: true, status: 'logged out' });
});

app.post('/force-reset', async (req, res) => {
  log('Force reset solicitado');
  try { if (sock) { sock.ev.removeAllListeners(); sock.end(); sock = null; } } catch {}
  fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  qrCodeData = null;
  qrAttempts = 0;
  updateState({ isConnected: false, hasSession: false, qrAvailable: false, status: 'disconnected', isConnecting: false, reconnectAttempts: 0 });
  setTimeout(connectWhatsApp, 1000);
  res.json({ ok: true, status: 'session reset' });
});

app.listen(PORT, () => {
  log(`Servidor rodando na porta ${PORT}`);
  log(`Dados em: ${DATA_FOLDER}`);
  if (SELF_URL) log(`URL: ${SELF_URL}`);
  startKeepAlive();
  connectWhatsApp();
});

process.on('SIGTERM', () => { log('Encerrando...'); if (sock) sock.end(); process.exit(0); });
process.on('SIGINT', () => { log('Encerrando...'); if (sock) sock.end(); process.exit(0); });
