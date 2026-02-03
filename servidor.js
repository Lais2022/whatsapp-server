// ============================================
// SERVIDOR WHATSAPP v5.0.0 - ENTERPRISE GRADE
// ============================================
// CORREÇÕES v5.0.0:
// 1. Isolamento TOTAL de erros de mídia (não afeta sessão)
// 2. Estado machine rigoroso com validação
// 3. Timeouts específicos por tipo de operação
// 4. Logs estruturados com níveis
// 5. Rate limiting básico para evitar spam
// 6. Métricas de performance para diagnóstico
// 7. Endpoint /diagnostics para debug enterprise
// ============================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, isJidBroadcast } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const SERVER_VERSION = '5.0.1';

// ============================================
// CONFIGURAÇÃO
// ============================================
const app = express();
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.SELF_URL || '';
const DATA_FOLDER = process.env.DATA_FOLDER || './data';
const AUTH_FOLDER = path.join(DATA_FOLDER, 'auth_info');
const KEEPALIVE_INTERVAL = parseInt(process.env.KEEPALIVE_INTERVAL) || 240000;

// Timeouts específicos por operação
// AUMENTADOS para Render Free (conexões lentas)
const TIMEOUTS = {
  TEXT: 90000,      // 90s para texto (antes 30s - timeouts frequentes)
  IMAGE: 180000,    // 3min para imagem
  AUDIO: 180000,    // 3min para áudio
  VIDEO: 300000,    // 5min para vídeo
  DOCUMENT: 180000  // 3min para documento
};

// Criar pastas
fs.mkdirSync(AUTH_FOLDER, { recursive: true });

// ============================================
// ESTADO GLOBAL - MACHINE RIGOROSO
// ============================================
// Estados válidos: INIT → CONNECTING → WAITING_QR → AUTHENTICATED → READY → DISCONNECTED
const VALID_STATES = ['init', 'connecting', 'waiting_qr', 'authenticated', 'ready', 'disconnected', 'error'];

let sock = null;
let qrCodeData = null;
let qrAttempts = 0;
const MAX_QR_ATTEMPTS = 5;

// Controle de loop de desconexão (ex.: código 405 repetindo)
let lastDisconnectStatusCode = null;
let lastDisconnectAt = 0;
let disconnectStreak = 0;

// MUTEX: Promise-based lock
let connectionMutex = null;
let pendingReconnect = null;

// Estado principal
let state = {
  status: 'init',           // Estado atual da máquina
  isConnected: false,       // Socket conectado
  isReady: false,           // Pronto para enviar (STICKY: só fica false em disconnect real)
  isAuthenticated: false,   // Autenticado com WhatsApp
  hasSession: false,        // Tem sessão salva
  qrAvailable: false,       // QR Code disponível
  lastConnection: null,     // Último timestamp conectado
  reconnectAttempts: 0,     // Tentativas de reconexão
  isConnecting: false,      // Em processo de conexão
  lastError: null,          // Último erro
  sessionInfo: null         // Info da sessão (nome, número)
};

// Mensagens recebidas
const messages = [];
const MAX_MESSAGES = 200;

// Métricas de performance
const metrics = {
  startTime: Date.now(),
  messagesReceived: 0,
  messagesSent: 0,
  mediaErrors: 0,
  connectionDrops: 0,
  lastActivity: null,
  sendLatencies: []  // Últimas 20 latências
};

// Logs estruturados (em memória para diagnóstico)
const recentLogs = [];
const MAX_LOGS = 100;

// ============================================
// HELPERS
// ============================================
const LogLevel = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LOG_LEVEL = process.env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO;

const log = (level, msg, data = null) => {
  if (level < LOG_LEVEL) return;
  
  const timestamp = new Date().toISOString();
  const levelName = ['DEBUG', 'INFO', 'WARN', 'ERROR'][level];
  const logEntry = { timestamp, level: levelName, msg, data };
  
  // Console
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`[${timestamp}] [${levelName}] ${msg}${dataStr}`);
  
  // Memória (para /diagnostics)
  recentLogs.unshift(logEntry);
  if (recentLogs.length > MAX_LOGS) recentLogs.pop();
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

// Transição de estado com validação
const updateState = (updates) => {
  const prev = { ...state };
  state = { ...state, ...updates };
  
  // Log mudanças importantes
  if (prev.status !== state.status) {
    log(LogLevel.INFO, `Estado: ${prev.status} → ${state.status}`);
  }
  if (prev.isReady !== state.isReady) {
    log(LogLevel.INFO, `Ready: ${prev.isReady} → ${state.isReady}`);
  }
};

// Valida se pode enviar
const canSend = () => {
  return state.isReady && sock && sock.ws?.readyState === sock.ws?.OPEN;
};

// ============================================
// RATE LIMITING BÁSICO
// ============================================
const rateLimits = new Map(); // phone -> { count, lastReset }
const RATE_LIMIT = 30; // mensagens por minuto por número
const RATE_WINDOW = 60000;

const checkRateLimit = (phone) => {
  const now = Date.now();
  const key = formatPhone(phone);
  const limit = rateLimits.get(key);
  
  if (!limit || now - limit.lastReset > RATE_WINDOW) {
    rateLimits.set(key, { count: 1, lastReset: now });
    return true;
  }
  
  if (limit.count >= RATE_LIMIT) {
    return false;
  }
  
  limit.count++;
  return true;
};

// ============================================
// KEEP-ALIVE
// ============================================
const startKeepAlive = () => {
  if (!SELF_URL) {
    log(LogLevel.WARN, 'SELF_URL não configurado - keep-alive desativado');
    return;
  }
  
  log(LogLevel.INFO, `Keep-alive: ${KEEPALIVE_INTERVAL}ms para ${SELF_URL}`);
  
  setInterval(async () => {
    try {
      const res = await fetch(`${SELF_URL}/health`);
      log(LogLevel.DEBUG, `Keep-alive ${res.ok ? 'OK' : 'FAIL'}`);
    } catch (err) {
      log(LogLevel.WARN, 'Keep-alive falhou', err.message);
    }
  }, KEEPALIVE_INTERVAL);
};

// ============================================
// RECONEXÃO CONTROLADA
// ============================================
function scheduleReconnect(delay, reason) {
  if (pendingReconnect) {
    clearTimeout(pendingReconnect);
    pendingReconnect = null;
  }
  
  log(LogLevel.INFO, `Reconexão agendada: ${delay}ms`, { reason });
  
  pendingReconnect = setTimeout(() => {
    pendingReconnect = null;
    connectWhatsApp({ source: reason });
  }, delay);
}

function cancelPendingReconnect() {
  if (pendingReconnect) {
    clearTimeout(pendingReconnect);
    pendingReconnect = null;
    log(LogLevel.DEBUG, 'Reconexão cancelada');
  }
}

function trackDisconnect(statusCode) {
  const now = Date.now();
  const withinWindow = now - lastDisconnectAt < 60_000;

  if (withinWindow && statusCode === lastDisconnectStatusCode) {
    disconnectStreak += 1;
  } else {
    disconnectStreak = 1;
  }

  lastDisconnectStatusCode = statusCode;
  lastDisconnectAt = now;

  return { disconnectStreak };
}

// ============================================
// CONEXÃO WHATSAPP - COM MUTEX E ESTADO MACHINE
// ============================================
async function connectWhatsApp(options = {}) {
  const { force = false, source = 'auto' } = options;
  
  // MUTEX: Se já há conexão em andamento
  if (connectionMutex) {
    if (!force) {
      log(LogLevel.DEBUG, `Conexão bloqueada - mutex ativo`, { source });
      return connectionMutex;
    }
    log(LogLevel.INFO, `Forçando nova conexão`, { source });
  }
  
  // Cria nova promise como mutex
  let resolveMutex;
  connectionMutex = new Promise(resolve => { resolveMutex = resolve; });
  
  log(LogLevel.INFO, `Iniciando conexão WhatsApp`, { source });
  updateState({ isConnecting: true, status: 'connecting', lastError: null });
  
  const hasSession = checkSession();
  updateState({ hasSession });

  try {
    // Fecha socket anterior se existir
    if (sock) {
      log(LogLevel.DEBUG, 'Fechando socket anterior');
      try {
        sock.ev.removeAllListeners();
        sock.end();
      } catch {}
      sock = null;
    }
    
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    
    log(LogLevel.INFO, `Baileys v${version.join('.')}`);

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      // printQRInTerminal foi descontinuado no Baileys; removemos a opção para evitar o warning.
      auth: authState,
      browser: ['VoxyAI CRM', 'Chrome', '120'],
      connectTimeoutMs: 60000,
      shouldIgnoreJid: jid => isJidBroadcast(jid),
      markOnlineOnConnect: true,
      retryRequestDelayMs: 500,
      getMessage: async () => undefined
    });

    // Salvar credenciais
    sock.ev.on('creds.update', saveCreds);

    // Atualização de conexão
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;
      
      log(LogLevel.DEBUG, 'Connection update', { connection, hasQR: !!qr });

      // QR Code
      if (qr && !state.isConnected && qrAttempts < MAX_QR_ATTEMPTS) {
        qrCodeData = await qrcode.toDataURL(qr);
        qrAttempts++;
        log(LogLevel.INFO, `QR Code gerado (tentativa ${qrAttempts}/${MAX_QR_ATTEMPTS})`);
        updateState({ qrAvailable: true, status: 'waiting_qr' });
        
        resolveMutex?.();
        connectionMutex = null;
      }

      // Conexão fechada
      if (connection === 'close') {
        // No Baileys, lastDisconnect.error já costuma ser um Boom.
        // Evite re-encapsular com "new Boom(...)" porque isso pode mascarar o statusCode real.
        const err = lastDisconnect?.error;
        const statusCode = Number(
          err?.output?.statusCode ??
          err?.output?.payload?.statusCode ??
          err?.statusCode
        ) || -1;
        const reason = DisconnectReason?.[statusCode] || statusCode;

        const { disconnectStreak: streak } = trackDisconnect(statusCode);
        const lastErrMsg = err?.message || null;
        
        log(LogLevel.WARN, `Conexão fechada`, { statusCode, reason, streak, lastErrMsg });
        metrics.connectionDrops++;
        
        resolveMutex?.();
        connectionMutex = null;
        
        // IMPORTANTE: isReady fica TRUE se foi desconexão temporária (não logout)
        const wasLoggedOut = statusCode === DisconnectReason.loggedOut || 
                            statusCode === DisconnectReason.badSession ||
                            statusCode === 401;

        // Em alguns ambientes cloud, credenciais ficam corrompidas e o Baileys fecha com 405 em loop.
        // Se houver sessão salva e o 405 estiver repetindo, tratamos como sessão inválida e forçamos novo QR.
        const is405LoopWithSession = statusCode === 405 && state.hasSession && streak >= 3;
        
        updateState({ 
          isConnected: false, 
          isReady: wasLoggedOut ? false : state.isReady, // Mantém ready em desconexões temporárias
          isAuthenticated: false,
          isConnecting: false,
          qrAvailable: false,
          status: 'disconnected'
        });

        // 440 = connectionReplaced - NÃO RECONECTA
        if (statusCode === 440) {
          log(LogLevel.WARN, 'Sessão substituída (440) - use /force-reset');
          updateState({ lastError: 'Outra sessão ativa. Use force-reset.', isReady: false });
          return;
        }

        // Sessão inválida - limpa e reconecta
        if (wasLoggedOut || is405LoopWithSession) {
          log(LogLevel.INFO, 'Sessão inválida - limpando');
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          fs.mkdirSync(AUTH_FOLDER, { recursive: true });
          qrCodeData = null;
          qrAttempts = 0;
          updateState({
            hasSession: false,
            sessionInfo: null,
            isReady: false,
            lastError: is405LoopWithSession
              ? 'Loop 405 detectado. Sessão resetada automaticamente; abra /connect para escanear um novo QR.'
              : null
          });
          scheduleReconnect(2000, 'session_invalid');
          return;
        }
        
        // Outros erros - reconecta com backoff
        const attempt = state.reconnectAttempts + 1;
        const delay = Math.min(5000 * attempt, 30000);
        updateState({ reconnectAttempts: attempt });
        scheduleReconnect(delay, `tentativa_${attempt}`);
      }

      // Conexão aberta
      if (connection === 'open') {
        log(LogLevel.INFO, 'Conexão estabelecida!');
        
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
        
        // Marca como READY após sync (3s)
        setTimeout(() => {
          if (state.isConnected && !state.isReady) {
            log(LogLevel.INFO, 'Sessão READY');
            updateState({ isReady: true, status: 'ready' });
          }
        }, 3000);
      }

      // READY imediato se recebeu notificações
      if (receivedPendingNotifications === true && state.isConnected) {
        log(LogLevel.INFO, 'Mensagens pendentes recebidas - READY');
        updateState({ isReady: true, status: 'ready' });
      }
    });

    // Receber mensagens
    sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
      for (const msg of msgs) {
        try {
          if (!msg.message || msg.key.remoteJid === 'status@broadcast') continue;
          if (msg.key.remoteJid?.includes('@g.us')) continue;
          
          const msgContent = msg.message;
          const text = msgContent.conversation || 
                       msgContent.extendedTextMessage?.text || 
                       msgContent.imageMessage?.caption || 
                       msgContent.videoMessage?.caption || '';
          
          // Detecta tipo de mídia e extrai informações
          let mediaType = null;
          let mediaInfo = null;
          
          if (msgContent.imageMessage) {
            mediaType = 'image';
            mediaInfo = {
              mimetype: msgContent.imageMessage.mimetype,
              caption: msgContent.imageMessage.caption,
              fileLength: msgContent.imageMessage.fileLength,
            };
          } else if (msgContent.videoMessage) {
            mediaType = 'video';
            mediaInfo = {
              mimetype: msgContent.videoMessage.mimetype,
              caption: msgContent.videoMessage.caption,
              seconds: msgContent.videoMessage.seconds,
              fileLength: msgContent.videoMessage.fileLength,
            };
          } else if (msgContent.audioMessage) {
            mediaType = 'audio';
            mediaInfo = {
              mimetype: msgContent.audioMessage.mimetype,
              seconds: msgContent.audioMessage.seconds,
              ptt: msgContent.audioMessage.ptt, // true = voice message
              fileLength: msgContent.audioMessage.fileLength,
            };
          } else if (msgContent.documentMessage) {
            mediaType = 'document';
            mediaInfo = {
              mimetype: msgContent.documentMessage.mimetype,
              fileName: msgContent.documentMessage.fileName,
              fileLength: msgContent.documentMessage.fileLength,
            };
          }
          
          const hasMedia = !!mediaType;
          
          const newMessage = {
            id: msg.key.id,
            from: msg.key.remoteJid,
            fromMe: msg.key.fromMe,
            text: text || (hasMedia ? '' : ''),
            type: Object.keys(msgContent)[0],
            timestamp: Date.now(),
            pushName: msg.pushName || 'Desconhecido',
            hasMedia,
            mediaType,
            mediaInfo,
          };
          
          messages.unshift(newMessage);
          if (messages.length > MAX_MESSAGES) messages.pop();
          
          metrics.messagesReceived++;
          metrics.lastActivity = Date.now();
          
          log(LogLevel.DEBUG, `Mensagem ${newMessage.fromMe ? 'enviada' : 'recebida'}`, { 
            from: newMessage.from?.substring(0, 15), 
            type: newMessage.type,
            hasMedia,
            mediaType
          });
        } catch (err) {
          log(LogLevel.ERROR, 'Erro ao processar mensagem', err.message);
        }
      }
    });

  } catch (err) {
    log(LogLevel.ERROR, 'Erro na conexão', err.message);
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

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Timeout por rota
app.use((req, res, next) => {
  // Aumenta timeout para rotas de mídia
  if (req.path.includes('send-image') || req.path.includes('send-video')) {
    req.setTimeout(180000);
  } else if (req.path.includes('send-audio') || req.path.includes('send-document')) {
    req.setTimeout(120000);
  } else {
    req.setTimeout(60000);
  }
  next();
});

// ============================================
// ROTAS - STATUS
// ============================================

// Rota raiz - redireciona para /connect
app.get('/', (req, res) => {
  res.redirect('/connect');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: SERVER_VERSION, 
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - metrics.startTime) / 1000),
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
    version: SERVER_VERSION,
    uptime: Math.floor((Date.now() - metrics.startTime) / 1000)
  });
});

app.get('/whatsapp-status', (req, res) => {
  res.json({
    // Estados principais
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
    
    // Metadados
    version: SERVER_VERSION,
    canSend: canSend(),
    
    // Métricas resumidas
    metrics: {
      uptime: Math.floor((Date.now() - metrics.startTime) / 1000),
      messagesReceived: metrics.messagesReceived,
      messagesSent: metrics.messagesSent,
      mediaErrors: metrics.mediaErrors,
      connectionDrops: metrics.connectionDrops
    }
  });
});

// ============================================
// DIAGNÓSTICO ENTERPRISE
// ============================================
app.get('/diagnostics', (req, res) => {
  res.json({
    version: SERVER_VERSION,
    state,
    metrics: {
      ...metrics,
      uptime: Math.floor((Date.now() - metrics.startTime) / 1000),
      avgLatency: metrics.sendLatencies.length > 0 
        ? Math.round(metrics.sendLatencies.reduce((a,b) => a+b, 0) / metrics.sendLatencies.length)
        : null
    },
    socket: {
      exists: !!sock,
      user: sock?.user || null,
      wsState: sock?.ws?.readyState
    },
    session: {
      folder: AUTH_FOLDER,
      hasFiles: checkSession()
    },
    recentLogs: recentLogs.slice(0, 50),
    recentMessages: messages.slice(0, 10).map(m => ({
      id: m.id,
      from: m.from?.substring(0, 15) + '...',
      fromMe: m.fromMe,
      type: m.type,
      timestamp: m.timestamp
    }))
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
  res.set('Cache-Control', 'no-cache');
  res.send(buffer);
});

// ============================================
// PÁGINA DE CONEXÃO
// ============================================
app.get('/connect', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp - VoxyAI CRM v${SERVER_VERSION}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; color: white; }
    .card { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 24px; padding: 40px; text-align: center; max-width: 480px; width: 90%; border: 1px solid rgba(255,255,255,0.2); }
    h1 { color: #25d366; margin-bottom: 8px; font-size: 28px; }
    .version { color: rgba(255,255,255,0.6); font-size: 12px; margin-bottom: 24px; }
    #qr { margin: 24px 0; min-height: 280px; display: flex; align-items: center; justify-content: center; flex-direction: column; }
    #qr img { border-radius: 16px; max-width: 256px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
    .status { padding: 14px 28px; border-radius: 50px; font-weight: 600; font-size: 14px; display: inline-block; margin-top: 16px; }
    .ready { background: linear-gradient(135deg, #22c55e, #16a34a); }
    .connected { background: linear-gradient(135deg, #3b82f6, #2563eb); }
    .waiting { background: linear-gradient(135deg, #f59e0b, #d97706); }
    .error { background: linear-gradient(135deg, #ef4444, #dc2626); }
    .spinner { width: 48px; height: 48px; border: 4px solid rgba(255,255,255,0.2); border-top: 4px solid #25d366; border-radius: 50%; animation: spin 1s linear infinite; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .btn { background: rgba(255,255,255,0.2); color: white; border: 1px solid rgba(255,255,255,0.3); padding: 12px 28px; border-radius: 50px; cursor: pointer; font-size: 14px; margin: 8px 4px; transition: all 0.2s; }
    .btn:hover { background: rgba(255,255,255,0.3); transform: translateY(-1px); }
    .btn-danger { background: rgba(239,68,68,0.3); border-color: rgba(239,68,68,0.5); }
    .btn-danger:hover { background: rgba(239,68,68,0.5); }
    .metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 24px; text-align: left; }
    .metric { background: rgba(255,255,255,0.05); padding: 12px; border-radius: 12px; }
    .metric-label { font-size: 11px; color: rgba(255,255,255,0.5); text-transform: uppercase; }
    .metric-value { font-size: 18px; font-weight: 600; color: #25d366; }
    .success-icon { font-size: 80px; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
  </style>
</head>
<body>
  <div class="card">
    <h1>📱 WhatsApp</h1>
    <p class="version">VoxyAI CRM Enterprise v${SERVER_VERSION}</p>
    <div id="qr"><div class="spinner"></div></div>
    <div id="status" class="status waiting">Inicializando...</div>
    <div id="actions"></div>
    <div id="metrics" class="metrics" style="display:none"></div>
  </div>
  <script>
    async function check() {
      try {
        const r = await fetch('/whatsapp-status');
        const d = await r.json();
        const qrEl = document.getElementById('qr');
        const statusEl = document.getElementById('status');
        const actionsEl = document.getElementById('actions');
        const metricsEl = document.getElementById('metrics');
        
        if (d.isReady) {
          qrEl.innerHTML = '<div class="success-icon">✅</div><p style="margin-top:12px;color:rgba(255,255,255,0.7)">Sessão: ' + (d.sessionInfo?.name || 'Conectado') + '</p>';
          statusEl.className = 'status ready';
          statusEl.textContent = 'PRONTO - Enviando e recebendo';
          actionsEl.innerHTML = '<button class="btn btn-danger" onclick="reset()">Desconectar</button>';
          
          metricsEl.style.display = 'grid';
          metricsEl.innerHTML = 
            '<div class="metric"><div class="metric-label">Mensagens Recebidas</div><div class="metric-value">' + (d.metrics?.messagesReceived || 0) + '</div></div>' +
            '<div class="metric"><div class="metric-label">Mensagens Enviadas</div><div class="metric-value">' + (d.metrics?.messagesSent || 0) + '</div></div>' +
            '<div class="metric"><div class="metric-label">Uptime</div><div class="metric-value">' + formatUptime(d.metrics?.uptime) + '</div></div>' +
            '<div class="metric"><div class="metric-label">Drops</div><div class="metric-value">' + (d.metrics?.connectionDrops || 0) + '</div></div>';
        } else if (d.isConnected) {
          qrEl.innerHTML = '<div style="font-size:64px">🔌</div>';
          statusEl.className = 'status connected';
          statusEl.textContent = 'Conectado - Sincronizando...';
          actionsEl.innerHTML = '';
          metricsEl.style.display = 'none';
        } else if (d.qrCode) {
          qrEl.innerHTML = '<img src="' + d.qrCode + '" alt="QR Code"><p style="margin-top:12px;font-size:13px;color:rgba(255,255,255,0.6)">Escaneie com seu WhatsApp</p>';
          statusEl.className = 'status waiting';
          statusEl.textContent = 'Aguardando scan do QR Code';
          actionsEl.innerHTML = '<button class="btn" onclick="reset()">Gerar novo QR</button>';
          metricsEl.style.display = 'none';
        } else if (d.lastError) {
          qrEl.innerHTML = '<div style="font-size:64px">⚠️</div><p style="margin-top:12px;color:rgba(255,255,255,0.6)">' + d.lastError + '</p>';
          statusEl.className = 'status error';
          statusEl.textContent = 'Erro na conexão';
          actionsEl.innerHTML = '<button class="btn" onclick="reset()">Tentar novamente</button>';
          metricsEl.style.display = 'none';
        } else {
          qrEl.innerHTML = '<div class="spinner"></div>';
          statusEl.className = 'status waiting';
          statusEl.textContent = 'Gerando QR Code...';
          actionsEl.innerHTML = '<button class="btn" onclick="reset()">Forçar geração</button>';
          metricsEl.style.display = 'none';
        }
      } catch(e) {
        document.getElementById('status').className = 'status error';
        document.getElementById('status').textContent = 'Servidor offline';
      }
    }
    
    function formatUptime(seconds) {
      if (!seconds) return '0s';
      if (seconds < 60) return seconds + 's';
      if (seconds < 3600) return Math.floor(seconds/60) + 'min';
      return Math.floor(seconds/3600) + 'h ' + Math.floor((seconds%3600)/60) + 'min';
    }
    
    async function reset() {
      await fetch('/force-reset', {method:'POST'});
      setTimeout(check, 2000);
    }
    
    check();
    setInterval(check, 2000);
  </script>
</body>
</html>`);
});

// ============================================
// ROTAS - ENVIAR MENSAGENS (COM ISOLAMENTO)
// ============================================

// Wrapper de envio com isolamento de erro
async function sendWithIsolation(operation, timeout) {
  const start = Date.now();
  
  try {
    const result = await Promise.race([
      operation(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout de envio')), timeout)
      )
    ]);
    
    // Registra latência
    const latency = Date.now() - start;
    metrics.sendLatencies.push(latency);
    if (metrics.sendLatencies.length > 20) metrics.sendLatencies.shift();
    
    metrics.messagesSent++;
    metrics.lastActivity = Date.now();
    
    return { success: true, result, latency };
  } catch (err) {
    log(LogLevel.ERROR, 'Erro no envio (ISOLADO)', { error: err.message });
    
    // IMPORTANTE: Erro de mídia NÃO invalida sessão
    // Apenas incrementa contador de erros
    metrics.mediaErrors++;
    
    return { success: false, error: err.message };
  }
}

app.post('/send', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const text = req.body.message || req.body.text;
  
  if (!phone || !text) {
    return res.status(400).json({ ok: false, success: false, error: 'phone e message são obrigatórios' });
  }
  
  if (!canSend()) {
    return res.status(503).json({ 
      ok: false, success: false, 
      error: 'WhatsApp não está pronto para envio',
      status: state.status,
      isReady: state.isReady
    });
  }
  
  if (!checkRateLimit(phone)) {
    return res.status(429).json({ ok: false, success: false, error: 'Rate limit excedido' });
  }
  
  const jid = formatPhone(phone) + '@s.whatsapp.net';
  
  const { success, result, error, latency } = await sendWithIsolation(
    () => sock.sendMessage(jid, { text }),
    TIMEOUTS.TEXT
  );
  
  if (success) {
    log(LogLevel.INFO, 'Texto enviado', { phone: phone.substring(0, 8), latency });
    res.json({ ok: true, success: true, messageId: result?.key?.id, latency });
  } else {
    res.status(500).json({ ok: false, success: false, error });
  }
});

app.post('/send-image', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const imageData = req.body.url || req.body.image;
  const caption = req.body.caption || '';
  
  if (!phone || !imageData) {
    return res.status(400).json({ ok: false, success: false, error: 'phone e image são obrigatórios' });
  }
  
  if (!canSend()) {
    return res.status(503).json({ ok: false, success: false, error: 'WhatsApp não está pronto' });
  }
  
  const jid = formatPhone(phone) + '@s.whatsapp.net';
  const imagePayload = imageData.startsWith('http') 
    ? { url: imageData } 
    : Buffer.from(imageData, 'base64');
  
  const { success, result, error, latency } = await sendWithIsolation(
    () => sock.sendMessage(jid, { image: imagePayload, caption }),
    TIMEOUTS.IMAGE
  );
  
  if (success) {
    log(LogLevel.INFO, 'Imagem enviada', { phone: phone.substring(0, 8), latency });
    res.json({ ok: true, success: true, messageId: result?.key?.id, latency });
  } else {
    res.status(500).json({ ok: false, success: false, error, mediaError: true });
  }
});

app.post('/send-audio', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const audioData = req.body.url || req.body.audio;
  const ptt = req.body.ptt !== false;
  
  if (!phone || !audioData) {
    return res.status(400).json({ ok: false, success: false, error: 'phone e audio são obrigatórios' });
  }
  
  if (!canSend()) {
    return res.status(503).json({ ok: false, success: false, error: 'WhatsApp não está pronto' });
  }
  
  const jid = formatPhone(phone) + '@s.whatsapp.net';
  
  // Log do mimetype recebido para debug
  const receivedMimetype = req.body.mimetype || 'não especificado';
  log(LogLevel.DEBUG, 'Processando áudio', { mimetype: receivedMimetype, ptt, size: audioData?.length?.toString().slice(0, 5) + '...' });
  
  // Prepara payload de áudio
  let audioPayload;
  if (typeof audioData === 'string' && audioData.startsWith('http')) {
    audioPayload = { url: audioData };
  } else {
    // Assumimos base64
    audioPayload = Buffer.from(audioData, 'base64');
  }
  
  // =========================================
  // NORMALIZAÇÃO DE MIMETYPE PARA WHATSAPP
  // =========================================
  // WhatsApp aceita melhor: audio/ogg; codecs=opus
  // Se veio webm, Baileys vai tentar converter internamente
  // Se falhar, logamos para diagnóstico
  // =========================================
  let finalMimetype = req.body.mimetype || 'audio/ogg; codecs=opus';
  
  // Se o browser enviou webm, mantemos (Baileys aceita)
  // Mas se quiser forçar OGG, descomentar abaixo:
  // if (finalMimetype.includes('webm')) {
  //   finalMimetype = 'audio/ogg; codecs=opus';
  // }
  
  const { success, result, error, latency } = await sendWithIsolation(
    () => sock.sendMessage(jid, { 
      audio: audioPayload, 
      mimetype: finalMimetype, 
      ptt 
    }),
    TIMEOUTS.AUDIO
  );
  
  if (success) {
    log(LogLevel.INFO, 'Áudio enviado', { phone: phone.substring(0, 8), mimetype: finalMimetype, latency });
    res.json({ ok: true, success: true, messageId: result?.key?.id, latency, mimetype: finalMimetype });
  } else {
    log(LogLevel.ERROR, 'Falha ao enviar áudio', { phone: phone.substring(0, 8), error, mimetype: finalMimetype });
    res.status(500).json({ ok: false, success: false, error, mediaError: true, mimetype: finalMimetype });
  }
});

app.post('/send-video', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const videoData = req.body.url || req.body.video;
  const caption = req.body.caption || '';
  
  if (!phone || !videoData) {
    return res.status(400).json({ ok: false, success: false, error: 'phone e video são obrigatórios' });
  }
  
  if (!canSend()) {
    return res.status(503).json({ ok: false, success: false, error: 'WhatsApp não está pronto' });
  }
  
  const jid = formatPhone(phone) + '@s.whatsapp.net';
  const videoPayload = videoData.startsWith('http') 
    ? { url: videoData } 
    : Buffer.from(videoData, 'base64');
  
  const { success, result, error, latency } = await sendWithIsolation(
    () => sock.sendMessage(jid, { video: videoPayload, caption }),
    TIMEOUTS.VIDEO
  );
  
  if (success) {
    log(LogLevel.INFO, 'Vídeo enviado', { phone: phone.substring(0, 8), latency });
    res.json({ ok: true, success: true, messageId: result?.key?.id, latency });
  } else {
    res.status(500).json({ ok: false, success: false, error, mediaError: true });
  }
});

app.post('/send-document', async (req, res) => {
  const phone = req.body.to || req.body.phone;
  const docData = req.body.url || req.body.document;
  const filename = req.body.filename || 'documento';
  
  if (!phone || !docData) {
    return res.status(400).json({ ok: false, success: false, error: 'phone e document são obrigatórios' });
  }
  
  if (!canSend()) {
    return res.status(503).json({ ok: false, success: false, error: 'WhatsApp não está pronto' });
  }
  
  const jid = formatPhone(phone) + '@s.whatsapp.net';
  const docPayload = docData.startsWith('http') 
    ? { url: docData } 
    : Buffer.from(docData, 'base64');
  
  const { success, result, error, latency } = await sendWithIsolation(
    () => sock.sendMessage(jid, { 
      document: docPayload, 
      fileName: filename,
      mimetype: req.body.mimetype || 'application/octet-stream'
    }),
    TIMEOUTS.DOCUMENT
  );
  
  if (success) {
    log(LogLevel.INFO, 'Documento enviado', { phone: phone.substring(0, 8), latency });
    res.json({ ok: true, success: true, messageId: result?.key?.id, latency });
  } else {
    res.status(500).json({ ok: false, success: false, error, mediaError: true });
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
    isReady: state.isReady,
    canSend: canSend()
  });
});

app.post('/logout', async (req, res) => {
  log(LogLevel.INFO, 'Logout solicitado');
  cancelPendingReconnect();
  
  try {
    if (sock) {
      await sock.logout();
      sock.ev.removeAllListeners();
      sock = null;
    }
  } catch (err) {
    log(LogLevel.WARN, 'Erro no logout', err.message);
  }
  
  fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  qrCodeData = null;
  qrAttempts = 0;
  connectionMutex = null;
  
  updateState({
    isConnected: false,
    isReady: false,
    isAuthenticated: false,
    hasSession: false,
    qrAvailable: false,
    status: 'disconnected',
    isConnecting: false,
    sessionInfo: null,
    lastError: null,
    reconnectAttempts: 0
  });
  
  setTimeout(() => connectWhatsApp({ source: 'logout' }), 1500);
  res.json({ ok: true, success: true, status: 'logged out' });
});

app.post('/force-reset', async (req, res) => {
  log(LogLevel.INFO, 'Force reset solicitado');
  cancelPendingReconnect();
  
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
  connectionMutex = null;
  
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
  
  setTimeout(() => connectWhatsApp({ force: true, source: 'force-reset' }), 1000);
  res.json({ ok: true, success: true, status: 'session reset' });
});

// Debug legado (mantido para compatibilidade)
app.get('/debug', (req, res) => {
  res.redirect('/diagnostics');
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
  log(LogLevel.INFO, `Servidor WhatsApp v${SERVER_VERSION} rodando`, { port: PORT, dataFolder: DATA_FOLDER });
  
  startKeepAlive();
  connectWhatsApp({ source: 'startup' });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log(LogLevel.INFO, 'SIGTERM - Encerrando');
  if (sock) { try { sock.end(); } catch {} }
  process.exit(0);
});

process.on('SIGINT', () => {
  log(LogLevel.INFO, 'SIGINT - Encerrando');
  if (sock) { try { sock.end(); } catch {} }
  process.exit(0);
});

// CRÍTICO: Evita que o processo morra com erros do Baileys
process.on('uncaughtException', (err) => {
  log(LogLevel.ERROR, 'Uncaught Exception (processo continua)', err.message);
});

process.on('unhandledRejection', (reason) => {
  log(LogLevel.ERROR, 'Unhandled Rejection (processo continua)', String(reason));
});
