// ============================================
// WHATSAPP SERVER v4.3.0 - VoxyAI CRM
// Otimizado para Render Free Tier
// ============================================

const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();

// ============================================
// CONFIGURAÇÃO
// ============================================
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL;
const DATA_FOLDER = process.env.DATA_FOLDER || './data';
const AUTH_FOLDER = path.join(DATA_FOLDER, 'auth_info');
const KEEPALIVE_INTERVAL = parseInt(process.env.KEEPALIVE_INTERVAL) || 240000;

// Criar pastas necessárias
if (!fs.existsSync(DATA_FOLDER)) fs.mkdirSync(DATA_FOLDER, { recursive: true });
if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

// ============================================
// ESTADO GLOBAL
// ============================================
let sock = null;
let qrCode = null;
let qrDataUrl = null;
let connectionStatus = 'disconnected';
let isConnected = false;
let isAuthenticated = false;
let isReady = false;
let lastError = null;
let messages = [];
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const startTime = Date.now();

// ============================================
// MIDDLEWARES
// ============================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============================================
// HELPERS
// ============================================
function log(msg, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${msg}`, data ? JSON.stringify(data) : '');
}

function formatPhone(phone) {
  if (!phone) return null;
  let cleaned = phone.toString().replace(/\D/g, '');
  if (cleaned.length === 11 && cleaned.startsWith('9')) {
    cleaned = '55' + cleaned;
  } else if (cleaned.length === 10 || cleaned.length === 11) {
    cleaned = '55' + cleaned;
  }
  return cleaned;
}

function checkSession() {
  try {
    const credsPath = path.join(AUTH_FOLDER, 'creds.json');
    return fs.existsSync(credsPath);
  } catch {
    return false;
  }
}

function updateState(updates) {
  Object.assign({ connectionStatus, isConnected, isAuthenticated, isReady, lastError }, updates);
  if (updates.connectionStatus !== undefined) connectionStatus = updates.connectionStatus;
  if (updates.isConnected !== undefined) isConnected = updates.isConnected;
  if (updates.isAuthenticated !== undefined) isAuthenticated = updates.isAuthenticated;
  if (updates.isReady !== undefined) isReady = updates.isReady;
  if (updates.lastError !== undefined) lastError = updates.lastError;
}

// ============================================
// KEEP-ALIVE (Render Free)
// ============================================
if (SELF_URL) {
  setInterval(() => {
    fetch(`${SELF_URL}/health`)
      .then(() => log('Keep-alive ping OK'))
      .catch(err => log('Keep-alive ping failed', err.message));
  }, KEEPALIVE_INTERVAL);
  log(`Keep-alive configurado: ${KEEPALIVE_INTERVAL}ms para ${SELF_URL}`);
}

// ============================================
// CONEXÃO WHATSAPP
// ============================================
async function connectWhatsApp() {
  try {
    log('Iniciando conexão WhatsApp...');
    
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }),
      browser: ['VoxyAI CRM', 'Chrome', '120.0.0'],
      connectTimeoutMs: 60000,
      qrTimeout: 60000,
      defaultQueryTimeoutMs: 60000,
    });

    // Salvar credenciais
    sock.ev.on('creds.update', saveCreds);

    // Atualização de conexão
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      log('Connection update:', { connection, hasQR: !!qr });

      if (qr) {
        qrCode = qr;
        qrDataUrl = await QRCode.toDataURL(qr);
        updateState({
          connectionStatus: 'waiting_qr',
          isConnected: false,
          isAuthenticated: false,
          isReady: false
        });
        log('QR Code gerado');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = DisconnectReason[statusCode] || statusCode;
        
        log('Conexão fechada:', { statusCode, reason });
        
        updateState({
          connectionStatus: 'disconnected',
          isConnected: false,
          isReady: false
        });
        
        qrCode = null;
        qrDataUrl = null;

        // Limpar sessão se logout ou não autorizado
        if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
          log('Sessão expirada, limpando...');
          try {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
            fs.mkdirSync(AUTH_FOLDER, { recursive: true });
          } catch (e) {
            log('Erro ao limpar sessão:', e.message);
          }
          reconnectAttempts = 0;
        }

        // Reconectar
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          const delay = Math.min(5000 * reconnectAttempts, 30000);
          log(`Reconectando em ${delay}ms (tentativa ${reconnectAttempts})`);
          setTimeout(connectWhatsApp, delay);
        } else {
          log('Máximo de tentativas atingido');
          updateState({ lastError: 'Máximo de tentativas de reconexão atingido' });
        }
      }

      if (connection === 'open') {
        log('Conexão estabelecida!');
        reconnectAttempts = 0;
        qrCode = null;
        qrDataUrl = null;
        updateState({
          connectionStatus: 'connected',
          isConnected: true,
          isAuthenticated: true,
          lastError: null
        });
      }
    });

    // Mensagens recebidas - marca como READY
    sock.ev.on('messages.upsert', async ({ messages: newMessages, type }) => {
      // Primeira mensagem = sessão está pronta
      if (!isReady && isConnected) {
        log('Primeira mensagem recebida - sessão READY');
        updateState({ isReady: true });
      }

      if (type === 'notify') {
        for (const msg of newMessages) {
          if (!msg.key.fromMe && msg.message) {
            const phone = msg.key.remoteJid?.replace('@s.whatsapp.net', '');
            const text = msg.message?.conversation || 
                        msg.message?.extendedTextMessage?.text || 
                        '[mídia]';
            
            log('Mensagem recebida:', { phone, text: text.substring(0, 50) });
            
            messages.unshift({
              id: msg.key.id,
              phone,
              text,
              timestamp: Date.now(),
              fromMe: false,
              type: 'text'
            });
            
            if (messages.length > 200) messages = messages.slice(0, 200);
          }
        }
      }
    });

    // Timeout para marcar ready se não receber mensagens
    setTimeout(() => {
      if (isConnected && !isReady) {
        log('Timeout - marcando como READY');
        updateState({ isReady: true });
      }
    }, 10000);

  } catch (error) {
    log('Erro na conexão:', error.message);
    updateState({ lastError: error.message });
    
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      setTimeout(connectWhatsApp, 5000);
    }
  }
}

// ============================================
// ROTAS - STATUS
// ============================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '4.3.0',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString()
  });
});

app.get('/debug', (req, res) => {
  res.json({
    version: '4.3.0',
    connectionStatus,
    isConnected,
    isAuthenticated,
    isReady,
    hasSession: checkSession(),
    hasQR: !!qrCode,
    messagesCount: messages.length,
    reconnectAttempts,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastError
  });
});

app.get('/status', (req, res) => {
  res.json({
    ok: true,
    success: true,
    version: '4.3.0',
    status: connectionStatus,
    isConnected,
    isAuthenticated,
    isReady,
    hasSession: checkSession(),
    hasQR: !!qrCode,
    timestamp: Date.now()
  });
});

app.get('/whatsapp-status', (req, res) => {
  res.json({
    ok: true,
    success: true,
    version: '4.3.0',
    connected: isConnected,
    ready: isReady,
    status: connectionStatus,
    isConnected,
    isAuthenticated,
    isReady,
    hasQR: !!qrCode,
    qrCode: qrDataUrl,
    timestamp: Date.now()
  });
});

// ============================================
// ROTAS - QR CODE
// ============================================
app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.json({
      ok: true,
      connected: true,
      message: 'Já conectado'
    });
  }
  
  if (qrDataUrl) {
    return res.json({
      ok: true,
      qr: qrDataUrl,
      qrCode: qrDataUrl,
      status: connectionStatus
    });
  }
  
  res.status(202).json({
    ok: false,
    message: 'QR Code ainda não disponível',
    status: connectionStatus
  });
});

app.get('/qr.png', async (req, res) => {
  if (!qrCode) {
    return res.status(404).send('QR não disponível');
  }
  
  try {
    const buffer = await QRCode.toBuffer(qrCode, { width: 300 });
    res.setHeader('Content-Type', 'image/png');
    res.send(buffer);
  } catch (error) {
    res.status(500).send('Erro ao gerar QR');
  }
});

// ============================================
// ROTAS - MENSAGENS
// ============================================
app.get('/messages', (req, res) => {
  res.json({
    ok: true,
    success: true,
    messages,
    count: messages.length
  });
});

app.post('/send', async (req, res) => {
  const phone = req.body.phone || req.body.to;
  const message = req.body.message || req.body.text;
  
  if (!phone || !message) {
    return res.status(400).json({
      ok: false,
      success: false,
      error: 'phone e message são obrigatórios'
    });
  }
  
  if (!isConnected || !isReady) {
    return res.status(503).json({
      ok: false,
      success: false,
      error: 'WhatsApp não está pronto',
      status: connectionStatus,
      isConnected,
      isReady
    });
  }
  
  try {
    const formattedPhone = formatPhone(phone);
    const jid = `${formattedPhone}@s.whatsapp.net`;
    
    await sock.sendMessage(jid, { text: message });
    
    messages.unshift({
      id: `sent-${Date.now()}`,
      phone: formattedPhone,
      text: message,
      timestamp: Date.now(),
      fromMe: true,
      type: 'text'
    });
    
    log('Mensagem enviada:', { phone: formattedPhone });
    
    res.json({
      ok: true,
      success: true,
      message: 'Mensagem enviada',
      phone: formattedPhone
    });
  } catch (error) {
    log('Erro ao enviar:', error.message);
    res.status(500).json({
      ok: false,
      success: false,
      error: error.message
    });
  }
});

// ============================================
// ROTAS - MÍDIA
// ============================================
app.post('/send-image', async (req, res) => {
  const phone = req.body.phone || req.body.to;
  const { image, caption } = req.body;
  
  if (!phone || !image) {
    return res.status(400).json({ ok: false, error: 'phone e image obrigatórios' });
  }
  
  if (!isConnected || !isReady) {
    return res.status(503).json({ ok: false, error: 'WhatsApp não pronto' });
  }
  
  try {
    const formattedPhone = formatPhone(phone);
    const jid = `${formattedPhone}@s.whatsapp.net`;
    const imageBuffer = Buffer.from(image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    
    await sock.sendMessage(jid, {
      image: imageBuffer,
      caption: caption || ''
    });
    
    log('Imagem enviada:', { phone: formattedPhone });
    res.json({ ok: true, success: true, message: 'Imagem enviada' });
  } catch (error) {
    log('Erro ao enviar imagem:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/send-audio', async (req, res) => {
  const phone = req.body.phone || req.body.to;
  const { audio } = req.body;
  
  if (!phone || !audio) {
    return res.status(400).json({ ok: false, error: 'phone e audio obrigatórios' });
  }
  
  if (!isConnected || !isReady) {
    return res.status(503).json({ ok: false, error: 'WhatsApp não pronto' });
  }
  
  try {
    const formattedPhone = formatPhone(phone);
    const jid = `${formattedPhone}@s.whatsapp.net`;
    const audioBuffer = Buffer.from(audio.replace(/^data:audio\/\w+;base64,/, ''), 'base64');
    
    await sock.sendMessage(jid, {
      audio: audioBuffer,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true
    });
    
    log('Áudio enviado:', { phone: formattedPhone });
    res.json({ ok: true, success: true, message: 'Áudio enviado' });
  } catch (error) {
    log('Erro ao enviar áudio:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/send-document', async (req, res) => {
  const phone = req.body.phone || req.body.to;
  const { document, filename, mimetype } = req.body;
  
  if (!phone || !document) {
    return res.status(400).json({ ok: false, error: 'phone e document obrigatórios' });
  }
  
  if (!isConnected || !isReady) {
    return res.status(503).json({ ok: false, error: 'WhatsApp não pronto' });
  }
  
  try {
    const formattedPhone = formatPhone(phone);
    const jid = `${formattedPhone}@s.whatsapp.net`;
    const docBuffer = Buffer.from(document.replace(/^data:[^;]+;base64,/, ''), 'base64');
    
    await sock.sendMessage(jid, {
      document: docBuffer,
      fileName: filename || 'documento',
      mimetype: mimetype || 'application/octet-stream'
    });
    
    log('Documento enviado:', { phone: formattedPhone, filename });
    res.json({ ok: true, success: true, message: 'Documento enviado' });
  } catch (error) {
    log('Erro ao enviar documento:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// ROTAS - CONTROLE
// ============================================
app.post('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      sock.end();
    }
    
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    
    updateState({
      connectionStatus: 'disconnected',
      isConnected: false,
      isAuthenticated: false,
      isReady: false
    });
    
    qrCode = null;
    qrDataUrl = null;
    
    log('Logout realizado');
    
    setTimeout(connectWhatsApp, 2000);
    
    res.json({ ok: true, message: 'Desconectado' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/force-reset', async (req, res) => {
  try {
    log('Force reset iniciado...');
    
    if (sock) {
      try {
        sock.end();
      } catch (e) {
        log('Erro ao encerrar socket:', e.message);
      }
    }
    
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    
    updateState({
      connectionStatus: 'disconnected',
      isConnected: false,
      isAuthenticated: false,
      isReady: false,
      lastError: null
    });
    
    qrCode = null;
    qrDataUrl = null;
    reconnectAttempts = 0;
    
    setTimeout(connectWhatsApp, 1000);
    
    log('Force reset concluído');
    res.json({ ok: true, message: 'Reset realizado, novo QR em breve' });
  } catch (error) {
    log('Erro no force-reset:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// PÁGINA DE CONEXÃO
// ============================================
app.get('/connect', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp - VoxyAI</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 20px;
      padding: 40px;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
      text-align: center;
    }
    h1 { color: #1a1a2e; margin-bottom: 10px; font-size: 24px; }
    .version { color: #888; font-size: 12px; margin-bottom: 20px; }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 20px;
    }
    .status.connected { background: #d4edda; color: #155724; }
    .status.waiting { background: #fff3cd; color: #856404; }
    .status.disconnected { background: #f8d7da; color: #721c24; }
    .status.ready { background: #cce5ff; color: #004085; }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      animation: pulse 1.5s infinite;
    }
    .connected .dot { background: #28a745; }
    .waiting .dot { background: #ffc107; }
    .disconnected .dot { background: #dc3545; }
    .ready .dot { background: #007bff; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    #qr-container {
      background: #f8f9fa;
      border-radius: 15px;
      padding: 20px;
      margin: 20px 0;
    }
    #qr-container img {
      max-width: 250px;
      width: 100%;
      border-radius: 10px;
    }
    .info { color: #666; font-size: 14px; margin: 15px 0; }
    .buttons { display: flex; gap: 10px; justify-content: center; margin-top: 20px; }
    button {
      padding: 12px 24px;
      border: none;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-primary { background: #667eea; color: white; }
    .btn-primary:hover { background: #5a6fd6; }
    .btn-danger { background: #dc3545; color: white; }
    .btn-danger:hover { background: #c82333; }
    .debug { margin-top: 20px; font-size: 11px; color: #999; text-align: left; background: #f5f5f5; padding: 10px; border-radius: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🟢 WhatsApp VoxyAI</h1>
    <div class="version">Servidor v4.3.0</div>
    
    <div id="status" class="status disconnected">
      <span class="dot"></span>
      <span id="status-text">Verificando...</span>
    </div>
    
    <div id="qr-container">
      <div id="qr-content">Carregando...</div>
    </div>
    
    <p class="info">Escaneie o QR Code com seu WhatsApp</p>
    
    <div class="buttons">
      <button class="btn-primary" onclick="refresh()">🔄 Atualizar</button>
      <button class="btn-danger" onclick="reset()">⚠️ Reset</button>
    </div>
    
    <div class="debug" id="debug"></div>
  </div>

  <script>
    async function checkStatus() {
      try {
        const res = await fetch('/whatsapp-status');
        const data = await res.json();
        
        const statusEl = document.getElementById('status');
        const statusText = document.getElementById('status-text');
        const qrContent = document.getElementById('qr-content');
        const debug = document.getElementById('debug');
        
        debug.innerHTML = 'isConnected: ' + data.isConnected + '<br>' +
                         'isReady: ' + data.isReady + '<br>' +
                         'status: ' + data.status + '<br>' +
                         'hasQR: ' + data.hasQR;
        
        if (data.isReady) {
          statusEl.className = 'status ready';
          statusText.textContent = '✅ PRONTO';
          qrContent.innerHTML = '<div style="font-size:48px">✅</div><p>WhatsApp conectado e pronto!</p>';
        } else if (data.isConnected) {
          statusEl.className = 'status connected';
          statusText.textContent = 'Conectado (aguardando ready)';
          qrContent.innerHTML = '<div style="font-size:48px">⏳</div><p>Sincronizando...</p>';
        } else if (data.qrCode) {
          statusEl.className = 'status waiting';
          statusText.textContent = 'Aguardando scan';
          qrContent.innerHTML = '<img src="' + data.qrCode + '" alt="QR Code">';
        } else {
          statusEl.className = 'status disconnected';
          statusText.textContent = 'Gerando QR...';
          qrContent.innerHTML = '<div style="font-size:48px">⏳</div><p>Aguarde...</p>';
        }
      } catch (e) {
        document.getElementById('status-text').textContent = 'Erro: ' + e.message;
      }
    }
    
    async function refresh() {
      await checkStatus();
    }
    
    async function reset() {
      if (confirm('Resetar sessão e gerar novo QR?')) {
        await fetch('/force-reset', { method: 'POST' });
        setTimeout(checkStatus, 2000);
      }
    }
    
    checkStatus();
    setInterval(checkStatus, 3000);
  </script>
</body>
</html>
  `);
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
  log(`Servidor WhatsApp v4.3.0 rodando na porta ${PORT}`);
  connectWhatsApp();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM recebido, encerrando...');
  if (sock) sock.end();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('SIGINT recebido, encerrando...');
  if (sock) sock.end();
  process.exit(0);
});
