```javascript
// ==============================================
// SERVIDOR WHATSAPP - VOXYAI
// Versão 4.1 - Render Free Edition
// 100% Gratuito - Sem Disco Persistente
// ==============================================

const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  downloadMediaMessage,
  makeInMemoryStore,
  delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ========== CONFIGURAÇÃO ==========
const AUTH_PATH = './data/auth_info';
const MEDIA_PATH = './data/media';

// Criar pastas
[AUTH_PATH, MEDIA_PATH].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ========== ESTADO GLOBAL ==========
let sock = null;
let currentQR = null;
let isConnected = false;
let connectionAttempts = 0;
let lastConnected = null;
let messages = [];
const MAX_MESSAGES = 100;

// Store em memória
const store = makeInMemoryStore({ 
  logger: pino().child({ level: 'silent', stream: 'store' }) 
});

// ========== FORMATAÇÃO DE NÚMERO ==========
function formatPhone(phone) {
  if (!phone) return null;
  let cleaned = phone.toString().replace(/\D/g, '');
  if (cleaned.startsWith('55') && cleaned.length === 13) {
    const ddd = cleaned.substring(2, 4);
    const number = cleaned.substring(4);
    if (number.startsWith('9') && number.length === 9) {
      cleaned = '55' + ddd + number;
    }
  }
  if (!cleaned.includes('@')) {
    cleaned = cleaned + '@s.whatsapp.net';
  }
  return cleaned;
}

// ========== CONEXÃO WHATSAPP ==========
async function connectToWhatsApp() {
  try {
    console.log('🔄 Iniciando conexão com WhatsApp...');
    
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }),
      browser: ['VoxyAI', 'Chrome', '120.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      emitOwnEvents: true,
      markOnlineOnConnect: true
    });

    store.bind(sock.ev);

    // Eventos de conexão
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        currentQR = qr;
        console.log('📱 QR Code gerado! Acesse /connect para escanear');
      }
      
      if (connection === 'close') {
        isConnected = false;
        currentQR = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`❌ Desconectado. Código: ${statusCode}`);
        
        if (shouldReconnect && connectionAttempts < 5) {
          connectionAttempts++;
          console.log(`🔄 Reconectando... Tentativa ${connectionAttempts}/5`);
          await delay(5000);
          connectToWhatsApp();
        } else if (statusCode === DisconnectReason.loggedOut) {
          console.log('🚪 Logout detectado. Limpando sessão...');
          if (fs.existsSync(AUTH_PATH)) {
            fs.rmSync(AUTH_PATH, { recursive: true, force: true });
            fs.mkdirSync(AUTH_PATH, { recursive: true });
          }
          connectionAttempts = 0;
          await delay(3000);
          connectToWhatsApp();
        }
      } else if (connection === 'open') {
        isConnected = true;
        currentQR = null;
        connectionAttempts = 0;
        lastConnected = new Date().toISOString();
        console.log('✅ WhatsApp conectado com sucesso!');
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Receber mensagens
    sock.ev.on('messages.upsert', async ({ messages: newMessages, type }) => {
      if (type !== 'notify') return;
      
      for (const msg of newMessages) {
        if (!msg.message) continue;
        
        const from = msg.key.remoteJid;
        const isGroup = from?.endsWith('@g.us');
        const sender = msg.key.participant || from;
        const pushName = msg.pushName || 'Desconhecido';
        
        let content = '';
        let mediaType = null;
        let mediaData = null;
        
        const messageContent = msg.message;
        
        if (messageContent.conversation) {
          content = messageContent.conversation;
        } else if (messageContent.extendedTextMessage) {
          content = messageContent.extendedTextMessage.text;
        } else if (messageContent.imageMessage) {
          content = messageContent.imageMessage.caption || '[Imagem]';
          mediaType = 'image';
        } else if (messageContent.videoMessage) {
          content = messageContent.videoMessage.caption || '[Vídeo]';
          mediaType = 'video';
        } else if (messageContent.audioMessage) {
          content = '[Áudio]';
          mediaType = 'audio';
        } else if (messageContent.documentMessage) {
          content = messageContent.documentMessage.fileName || '[Documento]';
          mediaType = 'document';
        } else if (messageContent.stickerMessage) {
          content = '[Sticker]';
          mediaType = 'sticker';
        }

        const messageData = {
          id: msg.key.id,
          from: from?.replace('@s.whatsapp.net', '').replace('@g.us', ''),
          sender: sender?.replace('@s.whatsapp.net', ''),
          pushName,
          content,
          mediaType,
          isGroup,
          timestamp: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000).toISOString() : new Date().toISOString(),
          fromMe: msg.key.fromMe || false
        };

        messages.unshift(messageData);
        if (messages.length > MAX_MESSAGES) {
          messages = messages.slice(0, MAX_MESSAGES);
        }

        console.log(`📨 ${isGroup ? '[Grupo]' : ''} ${pushName}: ${content.substring(0, 50)}...`);
      }
    });

  } catch (error) {
    console.error('❌ Erro na conexão:', error);
    if (connectionAttempts < 5) {
      connectionAttempts++;
      await delay(5000);
      connectToWhatsApp();
    }
  }
}

// ========== ROTAS ==========

// Página inicial com status
app.get('/', (req, res) => {
  res.json({
    server: 'VoxyAI WhatsApp Server v4.1',
    mode: 'FREE (sem disco persistente)',
    status: isConnected ? 'connected' : 'disconnected',
    connected: isConnected,
    lastConnected,
    hasQR: !!currentQR,
    messagesStored: messages.length,
    uptime: process.uptime(),
    note: '⚠️ Sessão temporária - escaneie QR novamente após reinício do servidor'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    ok: true, 
    connected: isConnected,
    uptime: process.uptime()
  });
});

// Status detalhado
app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    hasQR: !!currentQR,
    lastConnected,
    messagesStored: messages.length,
    connectionAttempts,
    uptime: process.uptime()
  });
});

// QR Code como JSON
app.get('/qr', async (req, res) => {
  if (isConnected) {
    return res.json({ 
      success: true, 
      connected: true, 
      message: 'WhatsApp já está conectado!' 
    });
  }
  
  if (!currentQR) {
    return res.json({ 
      success: false, 
      connected: false, 
      message: 'QR Code ainda não disponível. Aguarde alguns segundos...',
      hint: 'Acesse /connect para ver a página de conexão'
    });
  }
  
  res.json({ 
    success: true, 
    qr: currentQR,
    qrImageUrl: '/qr.png',
    connectPage: '/connect'
  });
});

// QR Code como imagem PNG
app.get('/qr.png', async (req, res) => {
  if (!currentQR) {
    res.status(404).send('QR não disponível');
    return;
  }
  
  try {
    const qrBuffer = await QRCode.toBuffer(currentQR, {
      type: 'png',
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(qrBuffer);
  } catch (error) {
    res.status(500).send('Erro ao gerar QR');
  }
});

// Página de conexão HTML
app.get('/connect', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VoxyAI - Conectar WhatsApp</title>
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
    .container {
      background: white;
      border-radius: 20px;
      padding: 40px;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-width: 400px;
      width: 100%;
    }
    h1 { color: #333; margin-bottom: 10px; }
    .subtitle { color: #666; margin-bottom: 30px; }
    .status {
      padding: 15px;
      border-radius: 10px;
      margin-bottom: 20px;
      font-weight: bold;
    }
    .status.connected { background: #d4edda; color: #155724; }
    .status.disconnected { background: #fff3cd; color: #856404; }
    .qr-container {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 15px;
      margin-bottom: 20px;
    }
    .qr-container img {
      max-width: 100%;
      border-radius: 10px;
    }
    .instructions {
      text-align: left;
      background: #e3f2fd;
      padding: 20px;
      border-radius: 10px;
      margin-top: 20px;
    }
    .instructions h3 { margin-bottom: 10px; color: #1565c0; }
    .instructions ol { padding-left: 20px; }
    .instructions li { margin-bottom: 8px; color: #333; }
    .refresh-btn {
      background: #667eea;
      color: white;
      border: none;
      padding: 12px 30px;
      border-radius: 25px;
      font-size: 16px;
      cursor: pointer;
      margin-top: 20px;
    }
    .refresh-btn:hover { background: #5a6fd6; }
    .warning {
      background: #fff3cd;
      border: 1px solid #ffc107;
      padding: 15px;
      border-radius: 10px;
      margin-top: 20px;
      font-size: 14px;
      color: #856404;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📱 VoxyAI</h1>
    <p class="subtitle">Conectar WhatsApp</p>
    
    <div class="status ${isConnected ? 'connected' : 'disconnected'}">
      ${isConnected ? '✅ WhatsApp Conectado!' : '⏳ Aguardando conexão...'}
    </div>
    
    ${isConnected ? `
      <p style="color: #28a745; font-size: 18px;">🎉 Tudo pronto!</p>
      <p style="margin-top: 10px;">Seu WhatsApp está conectado e funcionando.</p>
    ` : currentQR ? `
      <div class="qr-container">
        <img src="/qr.png?t=${Date.now()}" alt="QR Code" />
      </div>
      <div class="instructions">
        <h3>📋 Como conectar:</h3>
        <ol>
          <li>Abra o <strong>WhatsApp</strong> no celular</li>
          <li>Toque em <strong>⋮ Menu</strong> (3 pontinhos)</li>
          <li>Selecione <strong>Aparelhos conectados</strong></li>
          <li>Toque em <strong>Conectar um aparelho</strong></li>
          <li>Escaneie o QR Code acima</li>
        </ol>
      </div>
    ` : `
      <p>🔄 Gerando QR Code...</p>
      <p style="margin-top: 10px; color: #666;">Aguarde alguns segundos</p>
    `}
    
    <button class="refresh-btn" onclick="location.reload()">🔄 Atualizar</button>
    
    <div class="warning">
      ⚠️ <strong>Modo Gratuito:</strong> A sessão é temporária. Se o servidor reiniciar, você precisará escanear o QR novamente.
    </div>
  </div>
  
  <script>
    // Auto-refresh a cada 5 segundos se não estiver conectado
    ${!isConnected ? 'setTimeout(() => location.reload(), 5000);' : ''}
  </script>
</body>
</html>
  `;
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Buscar mensagens
app.get('/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    success: true,
    messages: messages.slice(0, limit),
    total: messages.length
  });
});

// Enviar mensagem de texto
app.post('/send', async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(503).json({ success: false, error: 'WhatsApp não conectado' });
    }
    
    const { phone, to, message, text } = req.body;
    const phoneNumber = phone || to;
    const messageText = message || text;
    
    if (!phoneNumber || !messageText) {
      return res.status(400).json({ success: false, error: 'phone e message são obrigatórios' });
    }
    
    const jid = formatPhone(phoneNumber);
    await sock.sendMessage(jid, { text: messageText });
    
    res.json({ success: true, message: 'Mensagem enviada!', to: jid });
  } catch (error) {
    console.error('Erro ao enviar:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Enviar imagem
app.post('/send-image', async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(503).json({ success: false, error: 'WhatsApp não conectado' });
    }
    
    const { phone, to, image, imageUrl, url, caption } = req.body;
    const phoneNumber = phone || to;
    const imageSource = image || imageUrl || url;
    
    if (!phoneNumber || !imageSource) {
      return res.status(400).json({ success: false, error: 'phone e image são obrigatórios' });
    }
    
    const jid = formatPhone(phoneNumber);
    
    let imageBuffer;
    if (imageSource.startsWith('data:')) {
      const base64Data = imageSource.split(',')[1];
      imageBuffer = Buffer.from(base64Data, 'base64');
    } else if (imageSource.startsWith('http')) {
      const response = await fetch(imageSource);
      imageBuffer = Buffer.from(await response.arrayBuffer());
    } else {
      imageBuffer = Buffer.from(imageSource, 'base64');
    }
    
    await sock.sendMessage(jid, { 
      image: imageBuffer,
      caption: caption || ''
    });
    
    res.json({ success: true, message: 'Imagem enviada!' });
  } catch (error) {
    console.error('Erro ao enviar imagem:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Enviar áudio
app.post('/send-audio', async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(503).json({ success: false, error: 'WhatsApp não conectado' });
    }
    
    const { phone, to, audio, audioData, ptt } = req.body;
    const phoneNumber = phone || to;
    const audioSource = audio || audioData;
    
    if (!phoneNumber || !audioSource) {
      return res.status(400).json({ success: false, error: 'phone e audio são obrigatórios' });
    }
    
    const jid = formatPhone(phoneNumber);
    
    let audioBuffer;
    if (audioSource.startsWith('data:')) {
      const base64Data = audioSource.split(',')[1];
      audioBuffer = Buffer.from(base64Data, 'base64');
    } else {
      audioBuffer = Buffer.from(audioSource, 'base64');
    }
    
    await sock.sendMessage(jid, { 
      audio: audioBuffer,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: ptt !== false
    });
    
    res.json({ success: true, message: 'Áudio enviado!' });
  } catch (error) {
    console.error('Erro ao enviar áudio:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Enviar documento
app.post('/send-document', async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(503).json({ success: false, error: 'WhatsApp não conectado' });
    }
    
    const { phone, to, document, documentData, filename, mimetype } = req.body;
    const phoneNumber = phone || to;
    const docSource = document || documentData;
    
    if (!phoneNumber || !docSource) {
      return res.status(400).json({ success: false, error: 'phone e document são obrigatórios' });
    }
    
    const jid = formatPhone(phoneNumber);
    
    let docBuffer;
    if (docSource.startsWith('data:')) {
      const base64Data = docSource.split(',')[1];
      docBuffer = Buffer.from(base64Data, 'base64');
    } else {
      docBuffer = Buffer.from(docSource, 'base64');
    }
    
    await sock.sendMessage(jid, { 
      document: docBuffer,
      fileName: filename || 'documento',
      mimetype: mimetype || 'application/octet-stream'
    });
    
    res.json({ success: true, message: 'Documento enviado!' });
  } catch (error) {
    console.error('Erro ao enviar documento:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Enviar vídeo
app.post('/send-video', async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(503).json({ success: false, error: 'WhatsApp não conectado' });
    }
    
    const { phone, to, video, videoUrl, url, caption } = req.body;
    const phoneNumber = phone || to;
    const videoSource = video || videoUrl || url;
    
    if (!phoneNumber || !videoSource) {
      return res.status(400).json({ success: false, error: 'phone e video são obrigatórios' });
    }
    
    const jid = formatPhone(phoneNumber);
    
    let videoBuffer;
    if (videoSource.startsWith('data:')) {
      const base64Data = videoSource.split(',')[1];
      videoBuffer = Buffer.from(base64Data, 'base64');
    } else if (videoSource.startsWith('http')) {
      const response = await fetch(videoSource);
      videoBuffer = Buffer.from(await response.arrayBuffer());
    } else {
      videoBuffer = Buffer.from(videoSource, 'base64');
    }
    
    await sock.sendMessage(jid, { 
      video: videoBuffer,
      caption: caption || ''
    });
    
    res.json({ success: true, message: 'Vídeo enviado!' });
  } catch (error) {
    console.error('Erro ao enviar vídeo:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Logout
app.post('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    isConnected = false;
    currentQR = null;
    
    if (fs.existsSync(AUTH_PATH)) {
      fs.rmSync(AUTH_PATH, { recursive: true, force: true });
      fs.mkdirSync(AUTH_PATH, { recursive: true });
    }
    
    res.json({ success: true, message: 'Desconectado com sucesso' });
    
    setTimeout(() => connectToWhatsApp(), 2000);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reconectar
app.post('/reconnect', async (req, res) => {
  try {
    connectionAttempts = 0;
    if (sock) {
      sock.end();
    }
    setTimeout(() => connectToWhatsApp(), 1000);
    res.json({ success: true, message: 'Reconectando...' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== KEEP-ALIVE (Anti-Hibernação) ==========
const SELF_URL = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL;

function keepAlive() {
  if (!SELF_URL) {
    console.log('⚠️ SELF_URL não configurada - keep-alive desativado');
    return;
  }
  
  setInterval(() => {
    http.get(`${SELF_URL}/health`, (res) => {
      console.log(`💓 Keep-alive: ${res.statusCode}`);
    }).on('error', (err) => {
      console.log('⚠️ Keep-alive falhou:', err.message);
    });
  }, 4 * 60 * 1000); // A cada 4 minutos
  
  console.log(`🔄 Keep-alive ativado para ${SELF_URL}`);
}

// ========== INICIAR SERVIDOR ==========
app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════╗');
  console.log('║     🚀 VoxyAI WhatsApp Server v4.1        ║');
  console.log('║         Render Free Edition               ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║  🌐 Porta: ${PORT}                            ║`);
  console.log('║  📱 Acesse /connect para escanear QR      ║');
  console.log('║  ⚠️  Modo: Sessão Temporária               ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log('');
  
  connectToWhatsApp();
  keepAlive();
});
```
