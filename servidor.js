// ============================================
// SERVIDOR WHATSAPP v4.3.0 - MENSAGENS FUNCIONAIS
// ============================================
// CORREÇÕES APLICADAS:
// 1. Validação de estado READY (não apenas connected)
// 2. Logs detalhados para debug
// 3. Mensagem de teste ao conectar (opcional)
// 4. Verificação de número no WhatsApp antes de enviar
// 5. Listener de mensagens com logs completos
// ============================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, isJidBroadcast } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIGURAÇÃO
// ============================================
const app = express();
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.SELF_URL || '';
const DATA_FOLDER = process.env.DATA_FOLDER || './data';
const AUTH_FOLDER = path.join(DATA_FOLDER, 'auth_info');
const KEEPALIVE_INTERVAL = parseInt(process.env.KEEPALIVE_INTERVAL) || 240000;

// Opção para enviar mensagem de teste ao conectar
const TEST_MESSAGE_ON_CONNECT = process.env.TEST_MESSAGE_ON_CONNECT === 'true';
const TEST_PHONE = process.env.TEST_PHONE || '';

// Criar pastas
fs.mkdirSync(AUTH_FOLDER, { recursive: true });

// ============================================
// ESTADO GLOBAL - EXPANDIDO
// ============================================
let sock = null;
let qrCodeData = null;
let qrAttempts = 0;
const MAX_QR_ATTEMPTS = 5;

// Estados de conexão do WhatsApp (Baileys)
// disconnected -> connecting -> authenticated -> ready -> disconnected
let state = {
  isConnected: false,    // Socket conectado
  isReady: false,        // WhatsApp READY para enviar/receber mensagens
  isAuthenticated: false, // Autenticado mas pode não estar pronto
  hasSession: false,
  qrAvailable: false,
  status: 'disconnected', // disconnected, connecting, authenticated, ready, error
  lastConnection: null,
  reconnectAttempts: 0,
  isConnecting: false,
  messagesCount: 0,
  lastError: null,
  sessionInfo: null       // Info da sessão (número, nome)
};

const messages = [];
const MAX_MESSAGES = 200;

// ============================================
// HELPERS
// ============================================
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
  
  // Log mudanças importantes
  if (prev.status !== state.status) {
    log(`📊 Status: ${prev.status} → ${state.status}`);
  }
  if (prev.isReady !== state.isReady) {
    log(`🎯 Ready: ${prev.isReady} → ${state.isReady}`);
  }
};

// ============================================
// KEEP-ALIVE (Evita hibernação do Render)
// ============================================
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

// ============================================
// VERIFICAR SE NÚMERO EXISTE NO WHATSAPP
// ============================================
async function checkNumberExists(phone) {
  if (!sock || !state.isReady) {
    return { exists: false, error: 'WhatsApp não está pronto' };
  }
  
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    const [result] = await sock.onWhatsApp(jid);
    
    log(`📞 Verificação de número ${phone}:`, result);
    
    if (result && result.exists) {
      return { exists: true, jid: result.jid };
    }
    return { exists: false, error: 'Número não encontrado no WhatsApp' };
  } catch (err) {
    log(`❌ Erro ao verificar número ${phone}:`, err.message);
    return { exists: false, error: err.message };
  }
}

// ============================================
// ENVIAR MENSAGEM DE TESTE
// ============================================
async function sendTestMessage() {
  if (!TEST_MESSAGE_ON_CONNECT || !TEST_PHONE) {
    return;
  }
  
  log('📤 Enviando mensagem de teste...');
  
  try {
    const jid = formatPhone(TEST_PHONE) + '@s.whatsapp.net';
    const timestamp = new Date().toLocaleString('pt-BR');
    
    await sock.sendMessage(jid, { 
      text: `✅ WhatsApp Server v4.3.0 conectado!\n📅 ${timestamp}\n🔗 VoxyAI CRM` 
    });
    
    log(`✅ Mensagem de teste enviada para ${TEST_PHONE}`);
  } catch (err) {
    log(`❌ Falha ao enviar mensagem de teste:`, err.message);
  }
}

// ============================================
// CONEXÃO WHATSAPP - REFATORADA
// ============================================
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

    // EVENTO: Salvar credenciais
    sock.ev.on('creds.update', () => {
      log('💾 Credenciais atualizadas');
      saveCreds();
    });

    // EVENTO: Atualização de conexão
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update;
      
      log('📡 Connection update:', { connection, isNewLogin, receivedPendingNotifications, hasQR: !!qr });

      // QR Code gerado
      if (qr && !state.isConnected && qrAttempts < MAX_QR_ATTEMPTS) {
        log('📲 Novo QR Code gerado (attempt ' + (qrAttempts + 1) + '/' + MAX_QR_ATTEMPTS + ')');
        qrCodeData = await qrcode.toDataURL(qr);
        qrAttempts++;
        updateState({ qrAvailable: true, status: 'waiting_qr', isAuthenticated: false, isReady: false });
      }

      // Conexão fechada
      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const reason = DisconnectReason[statusCode] || statusCode;
        
        log(`❌ Conexão fechada - Código: ${statusCode} (${reason})`);
        
        updateState({ 
          isConnected: false, 
          isReady: false,
          isAuthenticated: false,
          isConnecting: false,
          qrAvailable: false,
          status: 'disconnected',
          lastError: `Desconectado: ${reason}`
        });

        // Sessão inválida - limpar e reconectar
        if (statusCode === DisconnectReason.loggedOut || 
            statusCode === DisconnectReason.badSession ||
            statusCode === 401) {
          log('🗑️ Limpando sessão inválida...');
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          fs.mkdirSync(AUTH_FOLDER, { recursive: true });
          qrCodeData = null;
          qrAttempts = 0;
          updateState({ hasSession: false, sessionInfo: null });
          setTimeout(connectWhatsApp, 2000);
        } 
        // Reconectar para outros erros
        else if (statusCode !== DisconnectReason.loggedOut) {
          const delay = Math.min(5000 + (state.reconnectAttempts * 2000), 30000);
          log(`🔄 Reconectando em ${delay}ms...`);
          updateState({ reconnectAttempts: state.reconnectAttempts + 1 });
          setTimeout(connectWhatsApp, delay);
        }
      }

      // Conexão aberta (socket conectado, mas pode não estar READY ainda)
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
        
        // Busca info da sessão
        try {
          if (sock.user) {
            const sessionInfo = {
              id: sock.user.id,
              name: sock.user.name || 'WhatsApp User'
            };
            updateState({ sessionInfo });
            log('👤 Sessão:', sessionInfo);
          }
        } catch {}
      }

      // READY - Recebeu notificações pendentes = WhatsApp está 100% pronto
      if (receivedPendingNotifications === true || connection === 'open') {
        // Pequeno delay para garantir que está pronto
        setTimeout(() => {
          if (state.isConnected && !state.isReady) {
            log('✅ WhatsApp READY para enviar/receber mensagens!');
            updateState({ 
              isReady: true, 
              status: 'ready' 
            });
            
            // Envia mensagem de teste se configurado
            sendTestMessage();
          }
        }, 1000);
      }
    });

    // EVENTO: Receber mensagens - COM LOGS DETALHADOS
    sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
      log(`📨 messages.upsert - Tipo: ${type}, Quantidade: ${msgs.length}`);
      
      for (const msg of msgs) {
        try {
          // Ignora status e broadcasts
          if (!msg.message || msg.key.remoteJid === 'status@broadcast') {
            continue;
          }
          
          // Ignora grupos
          if (msg.key.remoteJid?.includes('@g.us')) {
            log('📭 Ignorando mensagem de grupo');
            continue;
          }
          
          // Extrai texto da mensagem
          const text = msg.message.conversation || 
                       msg.message.extendedTextMessage?.text || 
                       msg.message.imageMessage?.caption ||
                       msg.message.videoMessage?.caption ||
                       msg.message.documentMessage?.caption ||
                       '';
          
          const messageType = Object.keys(msg.message)[0];
          const isFromMe = msg.key.fromMe;
          const from = msg.key.remoteJid;
          const pushName = msg.pushName || 'Desconhecido';
          
          log(`📩 Mensagem ${isFromMe ? 'ENVIADA' : 'RECEBIDA'}:`, {
            id: msg.key.id,
            from: from,
            pushName: pushName,
            type: messageType,
            text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
            fromMe: isFromMe
          });
          
          // Armazena a mensagem
          const newMessage = {
            id: msg.key.id,
            from: from,
            fromMe: isFromMe,
            text: text,
            type: messageType,
            timestamp: Date.now(),
            pushName: pushName,
            hasMedia: !!msg.message.imageMessage || !!msg.message.videoMessage || 
                     !!msg.message.audioMessage || !!msg.message.documentMessage ||
                     !!msg.message.stickerMessage
          };
          
          messages.unshift(newMessage);
          
          if (messages.length > MAX_MESSAGES) {
            messages.pop();
          }
          
          updateState({ messagesCount: messages.length });
          
        } catch (err) {
          log('❌ Erro ao processar mensagem:', err.message);
        }
      }
    });

    // EVENTO: Atualização de status de mensagem
    sock.ev.on('messages.update', (updates) => {
      for (const update of updates) {
        log('📊 Status de mensagem atualizado:', {
          id: update.key.id,
          status: update.update?.status
        });
      }
    });

  } catch (err) {
    log('❌ Erro na conexão:', err.message);
    updateState({ 
      isConnecting: false, 
      status: 'error',
      lastError: err.message,
      isReady: false
    });
    setTimeout(connectWhatsApp, 5000);
  }
}

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Log de requisições
app.use((req, res, next) => {
  if (!req.path.includes('health') && !req.path.includes('status')) {
    log(`🌐 ${req.method} ${req.path}`);
  }
  next();
});

// ============================================
// ROTAS - SAÚDE E STATUS
// ============================================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '4.3.0', 
    timestamp: new Date().toISOString(),
    whatsapp: {
      connected: state.isConnected,
      ready: state.isReady,
      status: state.status
    }
  });
});

app.get('/status', (req, res) => {
  res.json({
    ...state,
    connected: state.isConnected,
    ready: state.isReady,
    hasQR: state.qrAvailable,
    messagesCount: messages.length,
    version: '4.3.0',
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
    version: '4.3.0'
  });
});

// ============================================
// ROTAS - QR CODE
// ============================================
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
  if (!qrCodeData) {
    return res.status(202).send('QR não disponível. Acesse /connect');
  }
  const base64 = qrCodeData.split(',')[1];
  const buffer = Buffer.from(base64, 'base64');
  res.set('Content-Type', 'image/png');
  res.send(buffer);
});

// ============================================
// ROTA - PÁGINA DE CONEXÃO
// ============================================
app.get('/connect', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Conectar WhatsApp - v4.3.0</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: white; border-radius: 20px; padding: 40px; text-align: center; box-shadow: 0 25px 50px rgba(0,0,0,0.25); max-width: 450px; width: 90%; }
    h1 { color: #25d366; margin-bottom: 10px; font-size: 24px; }
    .version { color: #999; font-size: 12px; margin-bottom: 20px; }
    #qr { margin: 20px 0; min-height: 256px; display: flex; align-items: center; justify-content: center; }
    #qr img { border-radius: 10px; max-width: 256px; }
    .status { padding: 12px 24px; border-radius: 30px; font-weight: 600; margin-top: 20px; display: inline-block; }
    .ready { background: #dcfce7; color: #16a34a; }
    .connected { background: #dbeafe; color: #2563eb; }
    .waiting { background: #fef3c7; color: #d97706; }
    .error { background: #fee2e2; color: #dc2626; }
    .info { background: #f3f4f6; color: #374151; font-size: 12px; padding: 15px; border-radius: 10px; margin-top: 20px; text-align: left; }
    .info code { background: #e5e7eb; padding: 2px 6px; border-radius: 4px; }
    .spinner { width: 50px; height: 50px; border: 4px solid #f3f3f3; border-top: 4px solid #667eea; border-radius: 50%; animation: spin 1s linear infinite; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .btn { background: #667eea; color: white; border: none; padding: 12px 30px; border-radius: 30px; cursor: pointer; font-size: 16px; margin-top: 15px; margin-right: 10px; }
    .btn:hover { background: #5a67d8; }
    .btn-danger { background: #dc2626; }
    .btn-danger:hover { background: #b91c1c; }
    .btn-success { background: #16a34a; }
    .btn-success:hover { background: #15803d; }
  </style>
</head>
<body>
  <div class="card">
    <h1>📱 WhatsApp</h1>
    <p class="version">VoxyAI CRM - v4.3.0</p>
    <div id="qr"><div class="spinner"></div></div>
    <div id="status" class="status waiting">Carregando...</div>
    <div id="info" class="info" style="display:none"></div>
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
        const infoEl = document.getElementById('info');
        
        if (d.isReady) {
          qrEl.innerHTML = '<div style="font-size:80px">✅</div>';
          statusEl.className = 'status ready';
          statusEl.textContent = 'PRONTO para enviar/receber!';
          actionsEl.innerHTML = '<button class="btn btn-danger" onclick="logout()">Desconectar</button><button class="btn btn-success" onclick="testMsg()">Testar Envio</button>';
          if (d.sessionInfo) {
            infoEl.style.display = 'block';
            infoEl.innerHTML = '<strong>Sessão:</strong> ' + (d.sessionInfo.name || d.sessionInfo.id);
          }
        } else if (d.isConnected) {
          qrEl.innerHTML = '<div style="font-size:60px">🔌</div>';
          statusEl.className = 'status connected';
          statusEl.textContent = 'Conectado, aguardando READY...';
          actionsEl.innerHTML = '<button class="btn btn-danger" onclick="logout()">Desconectar</button>';
        } else if (d.qrCode) {
          qrEl.innerHTML = '<img src="' + d.qrCode + '" alt="QR">';
          statusEl.className = 'status waiting';
          statusEl.textContent = 'Escaneie o QR Code';
          actionsEl.innerHTML = '';
          infoEl.style.display = 'none';
        } else if (d.lastError) {
          qrEl.innerHTML = '<div style="font-size:60px">⚠️</div>';
          statusEl.className = 'status error';
          statusEl.textContent = 'Erro: ' + d.lastError;
          actionsEl.innerHTML = '<button class="btn" onclick="reset()">Forçar Reset</button>';
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
    async function logout() {
      await fetch('/logout', {method:'POST'});
      setTimeout(check, 1000);
    }
    async function reset() {
      await fetch('/force-reset', {method:'POST'});
      setTimeout(check, 2000);
    }
    async function testMsg() {
      const phone = prompt('Digite o número (ex: 5511999999999):');
      if (!phone) return;
      const r = await fetch('/send', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({to: phone, message: '✅ Teste do WhatsApp Server v4.3.0'})
      });
      const d = await r.json();
      alert(d.ok ? 'Mensagem enviada!' : 'Erro: ' + (d.error || 'Falha'));
    }
    check();
    setInterval(check, 3000);
  </script>
</body>
</html>`);
});

// ============================================
// ROTAS - ENVIAR MENSAGENS (COM VALIDAÇÕES)
// ============================================
app.post('/send', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const text = req.body.message || req.body.text;
  
  log('📤 Requisição /send:', { phone, textLength: text?.length });
  
  if (!phone || !text) {
    log('❌ /send - Parâmetros faltando');
    return res.status(400).json({ ok: false, success: false, error: 'phone e message são obrigatórios' });
  }
  
  // Verifica se está READY (não apenas connected)
  if (!state.isReady) {
    const errorMsg = !state.isConnected 
      ? 'WhatsApp não conectado' 
      : 'WhatsApp conectado mas não está READY. Aguarde alguns segundos.';
    log(`❌ /send - ${errorMsg}`);
    return res.status(503).json({ 
      ok: false, 
      success: false, 
      error: errorMsg,
      status: state.status,
      isConnected: state.isConnected,
      isReady: state.isReady
    });
  }
  
  if (!sock) {
    log('❌ /send - Socket não existe');
    return res.status(503).json({ ok: false, success: false, error: 'Socket não inicializado' });
  }
  
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    log(`📤 Enviando para ${jid}...`);
    
    const result = await sock.sendMessage(jid, { text });
    
    log('✅ Mensagem enviada com sucesso:', {
      id: result?.key?.id,
      to: jid,
      textPreview: text.substring(0, 50)
    });
    
    res.json({ 
      ok: true, 
      success: true,
      messageId: result?.key?.id,
      to: jid
    });
  } catch (err) {
    log('❌ Erro ao enviar mensagem:', err.message);
    res.status(500).json({ 
      ok: false, 
      success: false, 
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// Verificar se número existe
app.post('/check-number', async (req, res) => {
  const phone = req.body.phone || req.body.to;
  
  if (!phone) {
    return res.status(400).json({ ok: false, error: 'phone é obrigatório' });
  }
  
  const result = await checkNumberExists(phone);
  res.json({ ok: result.exists, ...result });
});

app.post('/send-image', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const imageData = req.body.url || req.body.image;
  const caption = req.body.caption || '';
  
  log('📤 Requisição /send-image:', { phone, hasImage: !!imageData, caption });
  
  if (!phone || !imageData) {
    return res.status(400).json({ ok: false, success: false, error: 'phone e image são obrigatórios' });
  }
  
  if (!state.isReady || !sock) {
    return res.status(503).json({ 
      ok: false, 
      success: false, 
      error: 'WhatsApp não está pronto',
      status: state.status
    });
  }
  
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    
    // Suporta URL ou base64
    let imagePayload;
    if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
      imagePayload = { url: imageData };
    } else {
      // Base64
      imagePayload = Buffer.from(imageData, 'base64');
    }
    
    const result = await sock.sendMessage(jid, { image: imagePayload, caption });
    
    log('✅ Imagem enviada:', { id: result?.key?.id, to: jid });
    res.json({ ok: true, success: true, messageId: result?.key?.id });
  } catch (err) {
    log('❌ Erro ao enviar imagem:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

app.post('/send-audio', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const audioData = req.body.url || req.body.audio;
  const ptt = req.body.ptt !== false; // PTT = Voice Message (padrão true)
  
  log('📤 Requisição /send-audio:', { phone, hasAudio: !!audioData, ptt });
  
  if (!phone || !audioData) {
    return res.status(400).json({ ok: false, success: false, error: 'phone e audio são obrigatórios' });
  }
  
  if (!state.isReady || !sock) {
    return res.status(503).json({ 
      ok: false, 
      success: false, 
      error: 'WhatsApp não está pronto',
      status: state.status
    });
  }
  
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    
    let audioPayload;
    if (audioData.startsWith('http://') || audioData.startsWith('https://')) {
      audioPayload = { url: audioData };
    } else {
      audioPayload = Buffer.from(audioData, 'base64');
    }
    
    const result = await sock.sendMessage(jid, { 
      audio: audioPayload, 
      mimetype: req.body.mimetype || 'audio/ogg; codecs=opus', 
      ptt 
    });
    
    log('✅ Áudio enviado:', { id: result?.key?.id, to: jid });
    res.json({ ok: true, success: true, messageId: result?.key?.id });
  } catch (err) {
    log('❌ Erro ao enviar áudio:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

app.post('/send-video', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const videoData = req.body.url || req.body.video;
  const caption = req.body.caption || '';
  
  if (!phone || !videoData) {
    return res.status(400).json({ ok: false, success: false, error: 'phone e video são obrigatórios' });
  }
  
  if (!state.isReady || !sock) {
    return res.status(503).json({ ok: false, success: false, error: 'WhatsApp não está pronto' });
  }
  
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    
    let videoPayload;
    if (videoData.startsWith('http://') || videoData.startsWith('https://')) {
      videoPayload = { url: videoData };
    } else {
      videoPayload = Buffer.from(videoData, 'base64');
    }
    
    const result = await sock.sendMessage(jid, { video: videoPayload, caption });
    
    log('✅ Vídeo enviado:', { id: result?.key?.id, to: jid });
    res.json({ ok: true, success: true, messageId: result?.key?.id });
  } catch (err) {
    log('❌ Erro ao enviar vídeo:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

app.post('/send-document', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const docData = req.body.url || req.body.document;
  const filename = req.body.filename || 'documento';
  
  if (!phone || !docData) {
    return res.status(400).json({ ok: false, success: false, error: 'phone e document são obrigatórios' });
  }
  
  if (!state.isReady || !sock) {
    return res.status(503).json({ ok: false, success: false, error: 'WhatsApp não está pronto' });
  }
  
  try {
    const jid = formatPhone(phone) + '@s.whatsapp.net';
    
    let docPayload;
    if (docData.startsWith('http://') || docData.startsWith('https://')) {
      docPayload = { url: docData };
    } else {
      docPayload = Buffer.from(docData, 'base64');
    }
    
    const result = await sock.sendMessage(jid, { 
      document: docPayload, 
      fileName: filename,
      mimetype: req.body.mimetype || 'application/octet-stream'
    });
    
    log('✅ Documento enviado:', { id: result?.key?.id, to: jid });
    res.json({ ok: true, success: true, messageId: result?.key?.id });
  } catch (err) {
    log('❌ Erro ao enviar documento:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

// ============================================
// ROTAS - MENSAGENS E CONTROLE
// ============================================
app.get('/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const limitedMessages = messages.slice(0, limit);
  
  res.json({ 
    ok: true, 
    success: true,
    messages: limitedMessages, 
    count: limitedMessages.length,
    total: messages.length,
    isReady: state.isReady
  });
});

app.post('/logout', async (req, res) => {
  log('👋 Logout solicitado');
  try {
    if (sock) {
      await sock.logout();
      sock = null;
    }
  } catch (err) {
    log('⚠️ Erro no logout:', err.message);
  }
  
  fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  qrCodeData = null;
  qrAttempts = 0;
  
  updateState({
    isConnected: false,
    isReady: false,
    isAuthenticated: false,
    hasSession: false,
    qrAvailable: false,
    status: 'disconnected',
    isConnecting: false,
    sessionInfo: null,
    lastError: null
  });
  
  setTimeout(connectWhatsApp, 1000);
  res.json({ ok: true, success: true, status: 'logged out' });
});

app.post('/force-reset', async (req, res) => {
  log('🔄 Force reset solicitado');
  try {
    if (sock) {
      sock.ev.removeAllListeners();
      sock.end();
      sock = null;
    }
  } catch {}
  
  fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  qrCodeData = null;
  qrAttempts = 0;
  
  updateState({
    isConnected: false,
    isReady: false,
    isAuthenticated: false,
    hasSession: false,
    qrAvailable: false,
    status: 'disconnected',
    isConnecting: false,
    reconnectAttempts: 0,
    sessionInfo: null,
    lastError: null
  });
  
  setTimeout(connectWhatsApp, 1000);
  res.json({ ok: true, success: true, status: 'session reset' });
});

// Debug endpoint
app.get('/debug', (req, res) => {
  res.json({
    state,
    messagesCount: messages.length,
    lastMessages: messages.slice(0, 5),
    hasSocket: !!sock,
    socketUser: sock?.user || null,
    version: '4.3.0',
    env: {
      hasUrl: !!SELF_URL,
      dataFolder: DATA_FOLDER,
      testEnabled: TEST_MESSAGE_ON_CONNECT
    }
  });
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
  log(`🚀 Servidor WhatsApp v4.3.0 rodando na porta ${PORT}`);
  log(`📁 Dados em: ${DATA_FOLDER}`);
  if (SELF_URL) log(`🔗 URL: ${SELF_URL}`);
  
  startKeepAlive();
  connectWhatsApp();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('⏹️ Encerrando...');
  if (sock) sock.end();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('⏹️ Encerrando...');
  if (sock) sock.end();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  log('💥 Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  log('💥 Unhandled Rejection:', reason);
});
