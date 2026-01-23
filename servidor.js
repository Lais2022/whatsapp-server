// ============================================
// SERVIDOR WHATSAPP v4.3.0 - MENSAGENS FUNCIONAIS
// ============================================

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
    console.log(`[${timestamp}] ${msg}`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
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
  if (prev.status !== state.status) log(`📊 Status: ${prev.status} → ${state.status}`);
  if (prev.isReady !== state.isReady) log(`🎯 Ready: ${prev.isReady} → ${state.isReady}`);
};

const startKeepAlive = () => {
  if (!SELF_URL) {
    log('⚠️ SELF_URL não configurado - keep-alive desativado');
    return;
  }
  setInterval(async () => {
    try {
      const res = await fetch(`${SELF_URL}/health`);
      log(`🏓 Keep-alive: ${res.status}`);
    } catch (err) {
      log('❌ Keep-alive falhou:', err.message);
    }
  }, KEEPALIVE_INTERVAL);
  log(`✅ Keep-alive ativo: ${KEEPALIVE_INTERVAL}ms`);
};

async function connectWhatsApp() {
  if (state.isConnecting) {
    log('⏳ Já está conectando...');
    return;
  }
  
  log('🔄 Iniciando conexão WhatsApp...');
  updateState({ isConnecting: true, status: 'connecting', lastError: null });
  
  const hasSession = checkSession();
  updateState({ hasSession });
  log(hasSession ? '📂 Sessão existente encontrada' : '🆕 Nova sessão será criada');

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    
    log(`📱 Iniciando Baileys v${version.join('.')}`);

    sock = makeWASocket({
      version,
      logger: pino({ level: 'warn' }),
      printQRInTerminal: true,
      auth: authState,
      browser: ['VoxyAI CRM', 'Chrome', '120'],
      connectTimeoutMs: 60000,
      shouldIgnoreJid: jid => isJidBroadcast(jid),
      markOnlineOnConnect: true,
    });

    sock.ev.on('creds.update', () => {
      log('💾 Credenciais atualizadas');
      saveCreds();
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;
      
      log('📡 Connection update:', { connection, hasQR: !!qr });

      if (qr && !state.isConnected && qrAttempts < MAX_QR_ATTEMPTS) {
        log('📲 Novo QR Code gerado');
        qrCodeData = await qrcode.toDataURL(qr);
        qrAttempts++;
        updateState({ qrAvailable: true, status: 'waiting_qr', isAuthenticated: false, isReady: false });
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        log(`❌ Conexão fechada - Código: ${statusCode}`);
        
        updateState({ 
          isConnected: false, 
          isReady: false,
          isAuthenticated: false,
          isConnecting: false,
          qrAvailable: false,
          status: 'disconnected',
          lastError: `Desconectado: ${statusCode}`
        });

        if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession || statusCode === 401) {
          log('🗑️ Limpando sessão inválida...');
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          fs.mkdirSync(AUTH_FOLDER, { recursive: true });
          qrCodeData = null;
          qrAttempts = 0;
          updateState({ hasSession: false, sessionInfo: null });
          setTimeout(connectWhatsApp, 2000);
        } else if (statusCode !== DisconnectReason.loggedOut) {
          const delay = Math.min(5000 + (state.reconnectAttempts * 2000), 30000);
          log(`🔄 Reconectando em ${delay}ms...`);
          updateState({ reconnectAttempts: state.reconnectAttempts + 1 });
          setTimeout(connectWhatsApp, delay);
        }
      }

      if (connection === 'open') {
        log('🔌 Socket conectado!');
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
        
        try {
          if (sock.user) {
            updateState({ sessionInfo: { id: sock.user.id, name: sock.user.name || 'WhatsApp User' } });
            log('👤 Sessão:', state.sessionInfo);
          }
        } catch {}
      }

      if (receivedPendingNotifications === true || connection === 'open') {
        setTimeout(() => {
          if (state.isConnected && !state.isReady) {
            log('✅ WhatsApp READY para enviar/receber mensagens!');
            updateState({ isReady: true, status: 'ready' });
          }
        }, 1000);
      }
    });

    sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
      log(`📨 messages.upsert - Tipo: ${type}, Quantidade: ${msgs.length}`);
      
      for (const msg of msgs) {
        try {
          if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;
          if (msg.key.remoteJid?.includes('@g.us')) continue;
          
          const text = msg.message.conversation || 
                       msg.message.extendedTextMessage?.text || 
                       msg.message.imageMessage?.caption || '';
          
          const messageType = Object.keys(msg.message)[0];
          
          log(`📩 Mensagem ${msg.key.fromMe ? 'ENVIADA' : 'RECEBIDA'}:`, {
            id: msg.key.id,
            from: msg.key.remoteJid,
            pushName: msg.pushName,
            type: messageType,
            text: text.substring(0, 100)
          });
          
          messages.unshift({
            id: msg.key.id,
            from: msg.key.remoteJid,
            fromMe: msg.key.fromMe,
            text,
            type: messageType,
            timestamp: Date.now(),
            pushName: msg.pushName
          });
          
          if (messages.length > MAX_MESSAGES) messages.pop();
          updateState({ messagesCount: messages.length });
        } catch (err) {
          log('❌ Erro ao processar mensagem:', err.message);
        }
      }
    });

  } catch (err) {
    log('❌ Erro na conexão:', err.message);
    updateState({ isConnecting: false, status: 'error', lastError: err.message, isReady: false });
    setTimeout(connectWhatsApp, 5000);
  }
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '4.3.0', timestamp: new Date().toISOString(), whatsapp: { connected: state.isConnected, ready: state.isReady, status: state.status } });
});

app.get('/status', (req, res) => {
  res.json({ ...state, connected: state.isConnected, ready: state.isReady, hasQR: state.qrAvailable, messagesCount: messages.length, version: '4.3.0', uptime: process.uptime() });
});

app.get('/whatsapp-status', (req, res) => {
  res.json({ connected: state.isConnected, isConnected: state.isConnected, isReady: state.isReady, hasSession: state.hasSession, qrAvailable: state.qrAvailable, qrCode: qrCodeData, status: state.status, lastError: state.lastError, sessionInfo: state.sessionInfo, version: '4.3.0' });
});

app.get('/qr', (req, res) => {
  res.json({ qr: qrCodeData, qrCode: qrCodeData, available: !!qrCodeData, isConnected: state.isConnected, isReady: state.isReady, status: state.status });
});

app.get('/connect', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp v4.3.0</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:#fff;border-radius:20px;padding:40px;text-align:center;box-shadow:0 25px 50px rgba(0,0,0,.25);max-width:400px;width:90%}h1{color:#25d366;margin-bottom:10px}#qr{margin:20px 0;min-height:256px;display:flex;align-items:center;justify-content:center}#qr img{border-radius:10px;max-width:256px}.status{padding:12px 24px;border-radius:30px;font-weight:600;margin-top:20px;display:inline-block}.ready{background:#dcfce7;color:#16a34a}.connected{background:#dbeafe;color:#2563eb}.waiting{background:#fef3c7;color:#d97706}.error{background:#fee2e2;color:#dc2626}.spinner{width:50px;height:50px;border:4px solid #f3f3f3;border-top:4px solid #667eea;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.btn{background:#667eea;color:#fff;border:none;padding:12px 30px;border-radius:30px;cursor:pointer;font-size:16px;margin:10px 5px}.btn-danger{background:#dc2626}.btn-success{background:#16a34a}</style></head><body><div class="card"><h1>📱 WhatsApp</h1><p style="color:#999;font-size:12px">VoxyAI CRM - v4.3.0</p><div id="qr"><div class="spinner"></div></div><div id="status" class="status waiting">Carregando...</div><div id="actions"></div></div><script>async function check(){try{const r=await fetch('/whatsapp-status'),d=await r.json(),q=document.getElementById('qr'),s=document.getElementById('status'),a=document.getElementById('actions');if(d.isReady){q.innerHTML='<div style="font-size:80px">✅</div>';s.className='status ready';s.textContent='PRONTO!';a.innerHTML='<button class="btn btn-danger" onclick="logout()">Desconectar</button><button class="btn btn-success" onclick="testMsg()">Testar</button>'}else if(d.isConnected){q.innerHTML='<div style="font-size:60px">🔌</div>';s.className='status connected';s.textContent='Conectado, aguardando...';a.innerHTML=''}else if(d.qrCode){q.innerHTML='<img src="'+d.qrCode+'">';s.className='status waiting';s.textContent='Escaneie o QR';a.innerHTML=''}else{q.innerHTML='<div class="spinner"></div>';s.className='status waiting';s.textContent='Gerando QR...';a.innerHTML='<button class="btn" onclick="reset()">Reset</button>'}}catch(e){document.getElementById('status').className='status error';document.getElementById('status').textContent='Erro'}}async function logout(){await fetch('/logout',{method:'POST'});setTimeout(check,1000)}async function reset(){await fetch('/force-reset',{method:'POST'});setTimeout(check,2000)}async function testMsg(){const p=prompt('Número (ex: 5511999999999):');if(!p)return;const r=await fetch('/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:p,message:'✅ Teste v4.3.0'})});const d=await r.json();alert(d.ok?'Enviado!':'Erro: '+(d.error||'Falha'))}check();setInterval(check,3000)</script></body></html>`);
});

app.post('/send', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const text = req.body.message || req.body.text;
  
  log('📤 /send:', { phone, textLength: text?.length });
  
  if (!phone || !text) return res.status(400).json({ ok: false, error: 'phone e message obrigatórios' });
  if (!state.isReady) return res.status(503).json({ ok: false, error: 'WhatsApp não está READY', status: state.status });
  if (!sock) return res.status(503).json({ ok: false, error: 'Socket não inicializado' });
  
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    const result = await sock.sendMessage(jid, { text });
    log('✅ Enviado:', { id: result?.key?.id, to: jid });
    res.json({ ok: true, success: true, messageId: result?.key?.id });
  } catch (err) {
    log('❌ Erro envio:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/send-image', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const imageData = req.body.url || req.body.image;
  const caption = req.body.caption || '';
  
  if (!phone || !imageData) return res.status(400).json({ ok: false, error: 'phone e image obrigatórios' });
  if (!state.isReady || !sock) return res.status(503).json({ ok: false, error: 'WhatsApp não pronto' });
  
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    const imagePayload = imageData.startsWith('http') ? { url: imageData } : Buffer.from(imageData, 'base64');
    const result = await sock.sendMessage(jid, { image: imagePayload, caption });
    res.json({ ok: true, success: true, messageId: result?.key?.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/send-audio', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const audioData = req.body.url || req.body.audio;
  
  if (!phone || !audioData) return res.status(400).json({ ok: false, error: 'phone e audio obrigatórios' });
  if (!state.isReady || !sock) return res.status(503).json({ ok: false, error: 'WhatsApp não pronto' });
  
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    const audioPayload = audioData.startsWith('http') ? { url: audioData } : Buffer.from(audioData, 'base64');
    const result = await sock.sendMessage(jid, { audio: audioPayload, mimetype: 'audio/ogg; codecs=opus', ptt: true });
    res.json({ ok: true, success: true, messageId: result?.key?.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({ ok: true, success: true, messages: messages.slice(0, limit), count: messages.length, isReady: state.isReady });
});

app.post('/logout', async (req, res) => {
  log('👋 Logout');
  try { if (sock) { await sock.logout(); sock = null; } } catch {}
  fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  qrCodeData = null;
  qrAttempts = 0;
  updateState({ isConnected: false, isReady: false, isAuthenticated: false, hasSession: false, qrAvailable: false, status: 'disconnected', isConnecting: false, sessionInfo: null });
  setTimeout(connectWhatsApp, 1000);
  res.json({ ok: true, status: 'logged out' });
});

app.post('/force-reset', async (req, res) => {
  log('🔄 Force reset');
  try { if (sock) { sock.ev.removeAllListeners(); sock.end(); sock = null; } } catch {}
  fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  qrCodeData = null;
  qrAttempts = 0;
  updateState({ isConnected: false, isReady: false, isAuthenticated: false, hasSession: false, qrAvailable: false, status: 'disconnected', isConnecting: false, reconnectAttempts: 0, sessionInfo: null });
  setTimeout(connectWhatsApp, 1000);
  res.json({ ok: true, status: 'reset' });
});

app.get('/debug', (req, res) => {
  res.json({ state, messagesCount: messages.length, lastMessages: messages.slice(0, 5), hasSocket: !!sock, version: '4.3.0' });
});

app.listen(PORT, () => {
  log(`🚀 Servidor v4.3.0 na porta ${PORT}`);
  startKeepAlive();
  connectWhatsApp();
});

process.on('SIGTERM', () => { if (sock) sock.end(); process.exit(0); });
process.on('SIGINT', () => { if (sock) sock.end(); process.exit(0); });
process.on('uncaughtException', (err) => log('💥 Exception:', err.message));
process.on('unhandledRejection', (reason) => log('💥 Rejection:', reason));
