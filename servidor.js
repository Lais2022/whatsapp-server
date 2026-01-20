const express = require('express');
const cors = require('cors');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.SELF_URL || '';
const DATA_FOLDER = process.env.DATA_FOLDER || '/var/data';
const AUTH_FOLDER = path.join(DATA_FOLDER, 'auth_info');
const MEDIA_FOLDER = path.join(DATA_FOLDER, 'media');
const KEEPALIVE_INTERVAL = parseInt(process.env.KEEPALIVE_INTERVAL) || 240000;
const MEDIA_RETENTION_DAYS = parseInt(process.env.MEDIA_RETENTION_DAYS) || 7;

// Garantir que as pastas existam
[DATA_FOLDER, AUTH_FOLDER, MEDIA_FOLDER].forEach(folder => {
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
    console.log(`📁 Pasta criada: ${folder}`);
  }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

let sock = null;
let qrCode = null;
let connectionStatus = 'disconnected';
let lastError = null;
let messageStore = [];
const MAX_MESSAGES = 1000;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// ========== KEEP-ALIVE (SEMPRE LIGADO) ==========
if (SELF_URL) {
  setInterval(async () => {
    try {
      const response = await fetch(`${SELF_URL}/health`);
      console.log(`💓 Keep-alive: ${response.status}`);
    } catch (error) {
      console.log(`💔 Keep-alive falhou: ${error.message}`);
    }
  }, KEEPALIVE_INTERVAL);
  console.log(`⏰ Keep-alive configurado para ${KEEPALIVE_INTERVAL/1000}s`);
}

// ========== LIMPEZA DE MÍDIA ANTIGA ==========
function cleanOldMedia() {
  try {
    const files = fs.readdirSync(MEDIA_FOLDER);
    const now = Date.now();
    const maxAge = MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    
    files.forEach(file => {
      const filePath = path.join(MEDIA_FOLDER, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > maxAge) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Mídia antiga removida: ${file}`);
      }
    });
  } catch (error) {
    console.error('Erro na limpeza:', error.message);
  }
}
setInterval(cleanOldMedia, 60 * 60 * 1000);

// ========== SALVAR MÍDIA ==========
async function saveMedia(message) {
  try {
    const messageType = Object.keys(message.message || {})[0];
    const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'];
    
    if (!mediaTypes.includes(messageType)) return null;

    const buffer = await downloadMediaMessage(message, 'buffer', {});
    
    const extensions = {
      imageMessage: 'jpg',
      videoMessage: 'mp4',
      audioMessage: 'ogg',
      stickerMessage: 'webp',
      documentMessage: message.message.documentMessage?.fileName?.split('.').pop() || 'bin'
    };
    
    const ext = extensions[messageType] || 'bin';
    const filename = `${message.key.id}.${ext}`;
    const filepath = path.join(MEDIA_FOLDER, filename);
    
    fs.writeFileSync(filepath, buffer);
    console.log(`💾 Mídia salva: ${filename}`);
    
    return `/media/${filename}`;
  } catch (error) {
    console.error('Erro ao salvar mídia:', error.message);
    return null;
  }
}

// ========== CONEXÃO WHATSAPP ==========
async function connectToWhatsApp() {
  try {
    console.log('🔄 Iniciando conexão WhatsApp...');
    
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }),
      browser: ['VoxyAI CRM', 'Chrome', '120.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 2000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        qrCode = qr;
        connectionStatus = 'waiting_qr';
        console.log('📱 QR Code gerado! Acesse /qr para ver');
      }
      
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`❌ Conexão fechada. Código: ${statusCode}`);
        connectionStatus = 'disconnected';
        lastError = lastDisconnect?.error?.message || 'Conexão fechada';
        
        if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          const delay = Math.min(5000 * reconnectAttempts, 60000);
          console.log(`🔄 Reconectando em ${delay/1000}s... (tentativa ${reconnectAttempts})`);
          setTimeout(connectToWhatsApp, delay);
        } else if (statusCode === DisconnectReason.loggedOut) {
          console.log('🚪 Logout detectado. Limpando sessão...');
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          fs.mkdirSync(AUTH_FOLDER, { recursive: true });
          setTimeout(connectToWhatsApp, 3000);
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp conectado!');
        connectionStatus = 'connected';
        qrCode = null;
        lastError = null;
        reconnectAttempts = 0;
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        
        const mediaUrl = await saveMedia(msg);
        
        const messageData = {
          id: msg.key.id,
          from: msg.key.remoteJid,
          pushName: msg.pushName || 'Desconhecido',
          timestamp: msg.messageTimestamp,
          type: Object.keys(msg.message || {})[0],
          body: msg.message?.conversation || 
                msg.message?.extendedTextMessage?.text || 
                msg.message?.imageMessage?.caption ||
                msg.message?.videoMessage?.caption ||
                '',
          mediaUrl: mediaUrl,
          raw: msg
        };
        
        messageStore.unshift(messageData);
        if (messageStore.length > MAX_MESSAGES) {
          messageStore = messageStore.slice(0, MAX_MESSAGES);
        }
        
        console.log(`📨 Mensagem de ${messageData.pushName}: ${messageData.body || messageData.type}`);
      }
    });

  } catch (error) {
    console.error('❌ Erro na conexão:', error);
    lastError = error.message;
    connectionStatus = 'error';
    
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      setTimeout(connectToWhatsApp, 5000 * reconnectAttempts);
    }
  }
}

// ========== ROTAS DA API ==========

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Status detalhado
app.get('/status', (req, res) => {
  res.json({
    connected: connectionStatus === 'connected',
    status: connectionStatus,
    hasQR: !!qrCode,
    lastError: lastError,
    messagesCount: messageStore.length,
    uptime: process.uptime(),
    mediaFolder: MEDIA_FOLDER,
    reconnectAttempts: reconnectAttempts
  });
});

// QR Code
app.get('/qr', async (req, res) => {
  if (connectionStatus === 'connected') {
    return res.json({ 
      success: true, 
      connected: true, 
      message: 'Já conectado!' 
    });
  }
  
  if (!qrCode) {
    return res.json({ 
      success: false, 
      qr: null, 
      message: 'QR Code não disponível. Aguarde...' 
    });
  }
  
  res.json({ 
    success: true, 
    qr: qrCode,
    message: 'Escaneie o QR Code com seu WhatsApp'
  });
});

// Servir mídia
app.get('/media/:filename', (req, res) => {
  const filepath = path.join(MEDIA_FOLDER, req.params.filename);
  
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Arquivo não encontrado' });
  }
  
  res.sendFile(filepath);
});

// Listar mensagens
app.get('/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({
    success: true,
    count: messageStore.length,
    messages: messageStore.slice(0, limit)
  });
});

// Enviar mensagem de texto
app.post('/send', async (req, res) => {
  try {
    const phone = req.body.phone || req.body.to || req.body.number;
    const message = req.body.message || req.body.text || req.body.body;
    
    if (!phone || !message) {
      return res.status(400).json({ 
        ok: false, 
        success: false, 
        error: 'phone e message são obrigatórios' 
      });
    }
    
    if (connectionStatus !== 'connected') {
      return res.status(503).json({ 
        ok: false, 
        success: false, 
        error: 'WhatsApp não conectado' 
      });
    }
    
    const jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    
    res.json({ ok: true, success: true, message: 'Mensagem enviada!' });
  } catch (error) {
    res.status(500).json({ ok: false, success: false, error: error.message });
  }
});

// Enviar imagem
app.post('/send-image', async (req, res) => {
  try {
    const phone = req.body.phone || req.body.to || req.body.number;
    const image = req.body.image || req.body.base64 || req.body.media;
    const caption = req.body.caption || req.body.message || '';
    
    if (!phone || !image) {
      return res.status(400).json({ 
        ok: false, 
        success: false, 
        error: 'phone e image são obrigatórios' 
      });
    }
    
    if (connectionStatus !== 'connected') {
      return res.status(503).json({ 
        ok: false, 
        success: false, 
        error: 'WhatsApp não conectado' 
      });
    }
    
    const jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    const imageBuffer = Buffer.from(image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    
    await sock.sendMessage(jid, { image: imageBuffer, caption: caption });
    
    res.json({ ok: true, success: true, message: 'Imagem enviada!' });
  } catch (error) {
    res.status(500).json({ ok: false, success: false, error: error.message });
  }
});

// Enviar áudio
app.post('/send-audio', async (req, res) => {
  try {
    const phone = req.body.phone || req.body.to || req.body.number;
    const audio = req.body.audio || req.body.base64 || req.body.media;
    
    if (!phone || !audio) {
      return res.status(400).json({ 
        ok: false, 
        success: false, 
        error: 'phone e audio são obrigatórios' 
      });
    }
    
    if (connectionStatus !== 'connected') {
      return res.status(503).json({ 
        ok: false, 
        success: false, 
        error: 'WhatsApp não conectado' 
      });
    }
    
    const jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    let audioBuffer = Buffer.from(audio.replace(/^data:audio\/\w+;base64,/, ''), 'base64');
    
    // Converter para OGG se necessário (WhatsApp precisa de OGG/Opus)
    const tempInput = path.join(MEDIA_FOLDER, `temp_${Date.now()}.webm`);
    const tempOutput = path.join(MEDIA_FOLDER, `temp_${Date.now()}.ogg`);
    
    try {
      fs.writeFileSync(tempInput, audioBuffer);
      execSync(`ffmpeg -i ${tempInput} -c:a libopus -b:a 128k ${tempOutput} -y`, { stdio: 'pipe' });
      audioBuffer = fs.readFileSync(tempOutput);
      fs.unlinkSync(tempInput);
      fs.unlinkSync(tempOutput);
      console.log('🎵 Áudio convertido para OGG');
    } catch (convError) {
      console.log('⚠️ FFmpeg não disponível, enviando original');
      if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
      if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
    }
    
    await sock.sendMessage(jid, { 
      audio: audioBuffer, 
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true 
    });
    
    res.json({ ok: true, success: true, message: 'Áudio enviado!' });
  } catch (error) {
    res.status(500).json({ ok: false, success: false, error: error.message });
  }
});

// Enviar vídeo
app.post('/send-video', async (req, res) => {
  try {
    const phone = req.body.phone || req.body.to || req.body.number;
    const video = req.body.video || req.body.base64 || req.body.media;
    const caption = req.body.caption || req.body.message || '';
    
    if (!phone || !video) {
      return res.status(400).json({ 
        ok: false, 
        success: false, 
        error: 'phone e video são obrigatórios' 
      });
    }
    
    if (connectionStatus !== 'connected') {
      return res.status(503).json({ 
        ok: false, 
        success: false, 
        error: 'WhatsApp não conectado' 
      });
    }
    
    const jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    const videoBuffer = Buffer.from(video.replace(/^data:video\/\w+;base64,/, ''), 'base64');
    
    await sock.sendMessage(jid, { video: videoBuffer, caption: caption });
    
    res.json({ ok: true, success: true, message: 'Vídeo enviado!' });
  } catch (error) {
    res.status(500).json({ ok: false, success: false, error: error.message });
  }
});

// Enviar documento
app.post('/send-document', async (req, res) => {
  try {
    const phone = req.body.phone || req.body.to || req.body.number;
    const document = req.body.document || req.body.base64 || req.body.media;
    const filename = req.body.filename || req.body.fileName || 'documento.pdf';
    const mimetype = req.body.mimetype || 'application/pdf';
    
    if (!phone || !document) {
      return res.status(400).json({ 
        ok: false, 
        success: false, 
        error: 'phone e document são obrigatórios' 
      });
    }
    
    if (connectionStatus !== 'connected') {
      return res.status(503).json({ 
        ok: false, 
        success: false, 
        error: 'WhatsApp não conectado' 
      });
    }
    
    const jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    const docBuffer = Buffer.from(document.replace(/^data:.*?;base64,/, ''), 'base64');
    
    await sock.sendMessage(jid, { 
      document: docBuffer, 
      fileName: filename,
      mimetype: mimetype
    });
    
    res.json({ ok: true, success: true, message: 'Documento enviado!' });
  } catch (error) {
    res.status(500).json({ ok: false, success: false, error: error.message });
  }
});

// Logout
app.post('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    connectionStatus = 'disconnected';
    qrCode = null;
    
    setTimeout(connectToWhatsApp, 2000);
    
    res.json({ ok: true, success: true, message: 'Desconectado! Novo QR será gerado.' });
  } catch (error) {
    res.status(500).json({ ok: false, success: false, error: error.message });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📁 Dados em: ${DATA_FOLDER}`);
  connectToWhatsApp();
});
