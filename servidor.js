/**
 * =============================================================
 * SERVIDOR WHATSAPP VOXYAI - RENDER FREE EDITION
 * =============================================================
 * 
 * VERSÃO OTIMIZADA PARA RENDER GRÁTIS:
 * ✅ QR Code como IMAGEM PNG (escaneia direto no browser!)
 * ✅ Página HTML bonita para conectar
 * ✅ Sem necessidade de disco persistente
 * ✅ Keep-alive automático (não hiberna)
 * ✅ 100% GRÁTIS
 * 
 * DEPLOY:
 * 1. Crie repo no GitHub com: servidor.js, package.json, Dockerfile
 * 2. No Render: New Web Service → Docker → Deploy
 * 3. Variável: SELF_URL = https://seu-app.onrender.com
 * 4. Acesse: https://seu-app.onrender.com/connect
 * =============================================================
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const QRCode = require('qrcode');
const pino = require('pino');

const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

// =============================================================
// CONFIGURAÇÃO
// =============================================================

const app = express();
const PORT = process.env.PORT || 3000;
const SELF_URL = process.env.SELF_URL || '';
const KEEPALIVE_INTERVAL = 4 * 60 * 1000; // 4 minutos

// Usa pasta local (temporária no Render Free)
const DATA_FOLDER = './data';
const AUTH_FOLDER = path.join(DATA_FOLDER, 'auth_info');
const MEDIA_FOLDER = path.join(DATA_FOLDER, 'media');

// Cria pastas
[DATA_FOLDER, AUTH_FOLDER, MEDIA_FOLDER].forEach(folder => {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
    }
});

// Logger silencioso
const logger = pino({ level: 'silent' });

// Estado global
let sock = null;
let qrCode = null;
let qrDataUrl = null;
let qrPngBuffer = null;
let connectionStatus = 'disconnected';
let lastConnectionTime = null;
let reconnectAttempts = 0;
let messages = [];
const MAX_MESSAGES = 100;

// =============================================================
// MIDDLEWARES
// =============================================================

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Timeout de 60s
app.use((req, res, next) => {
    req.setTimeout(60000);
    res.setTimeout(60000);
    next();
});

// Serve mídia
app.use('/media', express.static(MEDIA_FOLDER));

// =============================================================
// FUNÇÕES AUXILIARES
// =============================================================

function log(message, data = null) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`, data || '');
}

function formatPhone(phone) {
    if (!phone) return '';
    let cleaned = phone.replace(/\D/g, '');
    if (!cleaned.includes('@')) {
        cleaned = cleaned + '@s.whatsapp.net';
    }
    return cleaned;
}

// =============================================================
// KEEP-ALIVE AUTOMÁTICO
// =============================================================

function startKeepAlive() {
    if (!SELF_URL) {
        log('⚠️ SELF_URL não configurada - keep-alive desativado');
        return;
    }

    log(`✅ Keep-alive ativado: ping a cada 4 min para ${SELF_URL}`);

    setInterval(() => {
        const url = `${SELF_URL}/health`;
        const client = url.startsWith('https') ? https : http;

        client.get(url, (res) => {
            log(`Keep-alive: ${res.statusCode}`);
        }).on('error', (err) => {
            log('Keep-alive erro:', err.message);
        });
    }, KEEPALIVE_INTERVAL);
}

// =============================================================
// CONEXÃO WHATSAPP
// =============================================================

async function connectWhatsApp() {
    try {
        log('🔄 Iniciando conexão WhatsApp...');
        
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            printQRInTerminal: true,
            logger,
            browser: ['VoxyAI CRM', 'Chrome', '120.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000
        });

        // Eventos de conexão
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // QR Code disponível
            if (qr) {
                qrCode = qr;
                qrDataUrl = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
                qrPngBuffer = await QRCode.toBuffer(qr, { width: 400, margin: 2, type: 'png' });
                connectionStatus = 'waiting_qr';
                log('📱 QR Code gerado! Acesse /connect para escanear');
            }

            // Conectado
            if (connection === 'open') {
                connectionStatus = 'connected';
                lastConnectionTime = new Date();
                reconnectAttempts = 0;
                qrCode = null;
                qrDataUrl = null;
                qrPngBuffer = null;
                log('✅ WhatsApp CONECTADO!');
            }

            // Desconectado
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                log(`❌ Desconectado. Código: ${statusCode}`);
                connectionStatus = 'disconnected';

                if (shouldReconnect) {
                    reconnectAttempts++;
                    const delay = Math.min(5000 * reconnectAttempts, 60000);
                    log(`🔄 Reconectando em ${delay / 1000}s...`);
                    setTimeout(connectWhatsApp, delay);
                } else {
                    log('🔒 Logout - limpando sessão');
                    try {
                        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
                    } catch (e) {}
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Recebe mensagens
        sock.ev.on('messages.upsert', async ({ messages: newMessages, type }) => {
            if (type !== 'notify') return;

            for (const msg of newMessages) {
                if (!msg.message) continue;

                const messageType = Object.keys(msg.message).find(key => 
                    ['conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage', 
                     'audioMessage', 'documentMessage', 'stickerMessage'].includes(key)
                );

                if (!messageType) continue;

                const messageData = {
                    id: msg.key.id,
                    from: msg.key.remoteJid,
                    fromMe: msg.key.fromMe,
                    timestamp: msg.messageTimestamp,
                    type: messageType,
                    text: msg.message.conversation || 
                          msg.message.extendedTextMessage?.text || 
                          msg.message[messageType]?.caption || '',
                    pushName: msg.pushName || ''
                };

                messages.unshift(messageData);
                if (messages.length > MAX_MESSAGES) {
                    messages = messages.slice(0, MAX_MESSAGES);
                }

                log(`📩 ${messageData.from}: ${messageData.text || '[mídia]'}`);
            }
        });

    } catch (error) {
        log('❌ Erro na conexão:', error.message);
        connectionStatus = 'error';
        
        reconnectAttempts++;
        const delay = Math.min(5000 * reconnectAttempts, 60000);
        setTimeout(connectWhatsApp, delay);
    }
}

// =============================================================
// PÁGINAS HTML
// =============================================================

// Página inicial bonita
app.get('/', (req, res) => {
    const hasDisk = fs.existsSync('/var/data');
    
    res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VoxyAI WhatsApp Server</title>
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
            max-width: 500px;
            width: 100%;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        .logo { font-size: 48px; margin-bottom: 10px; }
        h1 { color: #333; margin-bottom: 5px; }
        .version { color: #888; font-size: 14px; margin-bottom: 30px; }
        .status {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 10px 20px;
            border-radius: 50px;
            font-weight: 600;
            margin-bottom: 30px;
        }
        .status.connected { background: #d4edda; color: #155724; }
        .status.disconnected { background: #f8d7da; color: #721c24; }
        .status.waiting { background: #fff3cd; color: #856404; }
        .dot { width: 10px; height: 10px; border-radius: 50%; }
        .dot.green { background: #28a745; }
        .dot.red { background: #dc3545; }
        .dot.yellow { background: #ffc107; animation: pulse 1s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .btn {
            display: inline-block;
            padding: 15px 30px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-decoration: none;
            border-radius: 10px;
            font-weight: 600;
            font-size: 16px;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 5px 20px rgba(102,126,234,0.4); }
        .info { margin-top: 30px; padding: 20px; background: #f8f9fa; border-radius: 10px; text-align: left; }
        .info-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
        .info-item:last-child { border-bottom: none; }
        .label { color: #666; }
        .value { font-weight: 600; color: #333; }
        .note { margin-top: 20px; padding: 15px; background: #fff3cd; border-radius: 10px; font-size: 14px; color: #856404; }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">🚀</div>
        <h1>VoxyAI WhatsApp</h1>
        <p class="version">Server v4.1 - Render Free Edition</p>
        
        <div class="status ${connectionStatus === 'connected' ? 'connected' : connectionStatus === 'waiting_qr' ? 'waiting' : 'disconnected'}">
            <span class="dot ${connectionStatus === 'connected' ? 'green' : connectionStatus === 'waiting_qr' ? 'yellow' : 'red'}"></span>
            ${connectionStatus === 'connected' ? '✅ Conectado' : connectionStatus === 'waiting_qr' ? '📱 Aguardando QR' : '❌ Desconectado'}
        </div>
        
        <a href="/connect" class="btn">
            ${connectionStatus === 'connected' ? '📊 Ver Status' : '📱 Conectar WhatsApp'}
        </a>
        
        <div class="info">
            <div class="info-item">
                <span class="label">Status</span>
                <span class="value">${connectionStatus}</span>
            </div>
            <div class="info-item">
                <span class="label">Modo</span>
                <span class="value">${hasDisk ? '💾 Persistente' : '⚡ Temporário'}</span>
            </div>
            <div class="info-item">
                <span class="label">Mensagens</span>
                <span class="value">${messages.length}</span>
            </div>
            <div class="info-item">
                <span class="label">Uptime</span>
                <span class="value">${Math.floor(process.uptime() / 60)} min</span>
            </div>
        </div>
        
        ${!hasDisk ? '<div class="note">⚠️ <strong>Modo Temporário:</strong> Sessão será perdida ao reiniciar servidor. Escaneie o QR novamente quando necessário.</div>' : ''}
    </div>
</body>
</html>
    `);
});

// Página de conexão com QR
app.get('/connect', (req, res) => {
    let content = '';
    
    if (connectionStatus === 'connected') {
        content = `
            <div class="success">
                <div class="icon">✅</div>
                <h2>WhatsApp Conectado!</h2>
                <p>Seu WhatsApp está funcionando perfeitamente.</p>
                <div class="info">
                    <p><strong>Última conexão:</strong> ${lastConnectionTime ? lastConnectionTime.toLocaleString('pt-BR') : 'N/A'}</p>
                    <p><strong>Mensagens:</strong> ${messages.length}</p>
                </div>
                <a href="/" class="btn secondary">← Voltar</a>
            </div>
        `;
    } else if (qrPngBuffer) {
        content = `
            <div class="qr-container">
                <h2>📱 Escaneie o QR Code</h2>
                <p>Abra o WhatsApp no celular → Configurações → Aparelhos conectados → Conectar</p>
                <img src="/qr.png" alt="QR Code" class="qr-image">
                <p class="timer">QR expira em alguns segundos. Recarregue se necessário.</p>
                <a href="/connect" class="btn">🔄 Atualizar</a>
            </div>
        `;
    } else {
        content = `
            <div class="waiting">
                <div class="loader"></div>
                <h2>Gerando QR Code...</h2>
                <p>Aguarde enquanto preparamos a conexão.</p>
                <a href="/connect" class="btn">🔄 Atualizar</a>
            </div>
        `;
    }
    
    res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Conectar WhatsApp - VoxyAI</title>
    <meta http-equiv="refresh" content="30">
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
            max-width: 450px;
            width: 100%;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        h2 { color: #333; margin-bottom: 10px; }
        p { color: #666; margin-bottom: 20px; line-height: 1.6; }
        .qr-image {
            width: 280px;
            height: 280px;
            border-radius: 15px;
            margin: 20px 0;
            box-shadow: 0 5px 20px rgba(0,0,0,0.1);
        }
        .timer { font-size: 14px; color: #888; }
        .btn {
            display: inline-block;
            padding: 12px 25px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-decoration: none;
            border-radius: 10px;
            font-weight: 600;
            margin-top: 15px;
        }
        .btn.secondary { background: #6c757d; }
        .success .icon { font-size: 64px; margin-bottom: 20px; }
        .info { background: #f8f9fa; padding: 15px; border-radius: 10px; margin: 20px 0; text-align: left; }
        .info p { margin: 5px 0; color: #333; }
        .loader {
            width: 50px;
            height: 50px;
            border: 4px solid #f3f3f3;
            border-top: 4px solid #667eea;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="container">
        ${content}
    </div>
</body>
</html>
    `);
});

// QR Code como imagem PNG (ESCANEIA DIRETO!)
app.get('/qr.png', (req, res) => {
    if (!qrPngBuffer) {
        // Gera imagem de "não disponível"
        res.redirect('/connect');
        return;
    }
    
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(qrPngBuffer);
});

// =============================================================
// API ENDPOINTS
// =============================================================

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

app.get('/status', (req, res) => {
    const hasDisk = fs.existsSync('/var/data');
    
    res.json({
        server: 'VoxyAI WhatsApp Server v4.1',
        mode: hasDisk ? 'PERSISTENT (com disco)' : 'FREE (sem disco persistente)',
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        lastConnected: lastConnectionTime,
        hasQR: !!qrPngBuffer,
        messagesStored: messages.length,
        note: hasDisk ? '✅ Sessão persistente' : '⚠️ Sessão temporária - escaneie QR novamente após reinício do servidor'
    });
});

// QR em JSON (para apps)
app.get('/qr', (req, res) => {
    if (connectionStatus === 'connected') {
        return res.json({ 
            success: true, 
            connected: true,
            message: 'Já conectado!' 
        });
    }

    if (!qrDataUrl) {
        return res.json({ 
            success: false, 
            message: 'QR ainda não disponível. Aguarde...',
            tip: 'Acesse /connect para ver a página de conexão'
        });
    }

    res.json({ 
        success: true, 
        qr: qrDataUrl,
        qrImageUrl: `${SELF_URL || ''}/qr.png`,
        connectPage: `${SELF_URL || ''}/connect`
    });
});

app.get('/messages', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json({
        success: true,
        ok: true,
        messages: messages.slice(0, limit),
        total: messages.length
    });
});

// Enviar texto
app.post('/send', async (req, res) => {
    try {
        const phone = req.body.phone || req.body.to;
        const message = req.body.message || req.body.text;

        if (!phone || !message) {
            return res.status(400).json({ 
                success: false, ok: false,
                error: 'phone e message são obrigatórios' 
            });
        }

        if (connectionStatus !== 'connected' || !sock) {
            return res.status(503).json({ 
                success: false, ok: false,
                error: 'WhatsApp não conectado',
                tip: 'Acesse /connect para conectar'
            });
        }

        const jid = formatPhone(phone);
        await sock.sendMessage(jid, { text: message });

        log(`📤 Enviado para ${jid}: ${message.substring(0, 50)}...`);
        res.json({ success: true, ok: true, message: 'Mensagem enviada', to: jid });
    } catch (error) {
        log('Erro ao enviar:', error.message);
        res.status(500).json({ success: false, ok: false, error: error.message });
    }
});

// Enviar imagem
app.post('/send-image', async (req, res) => {
    try {
        const phone = req.body.phone || req.body.to;
        const imageBase64 = req.body.imageBase64 || req.body.image;
        const imageUrl = req.body.imageUrl;
        const caption = req.body.caption || '';

        if (!phone || (!imageUrl && !imageBase64)) {
            return res.status(400).json({ 
                success: false, ok: false,
                error: 'phone e (imageUrl ou imageBase64) são obrigatórios' 
            });
        }

        if (connectionStatus !== 'connected' || !sock) {
            return res.status(503).json({ success: false, ok: false, error: 'WhatsApp não conectado' });
        }

        const jid = formatPhone(phone);
        let imageBuffer;

        if (imageBase64) {
            imageBuffer = Buffer.from(imageBase64, 'base64');
        } else {
            const response = await fetch(imageUrl);
            imageBuffer = Buffer.from(await response.arrayBuffer());
        }

        await sock.sendMessage(jid, { image: imageBuffer, caption });
        log(`📤 Imagem enviada para ${jid}`);
        res.json({ success: true, ok: true, message: 'Imagem enviada' });
    } catch (error) {
        res.status(500).json({ success: false, ok: false, error: error.message });
    }
});

// Enviar áudio
app.post('/send-audio', async (req, res) => {
    try {
        const phone = req.body.phone || req.body.to;
        const audioBase64 = req.body.audioBase64 || req.body.audio;
        const audioUrl = req.body.audioUrl;

        if (!phone || (!audioUrl && !audioBase64)) {
            return res.status(400).json({ 
                success: false, ok: false,
                error: 'phone e (audioUrl ou audioBase64) são obrigatórios' 
            });
        }

        if (connectionStatus !== 'connected' || !sock) {
            return res.status(503).json({ success: false, ok: false, error: 'WhatsApp não conectado' });
        }

        const jid = formatPhone(phone);
        let audioBuffer;

        if (audioBase64) {
            audioBuffer = Buffer.from(audioBase64, 'base64');
        } else {
            const response = await fetch(audioUrl);
            audioBuffer = Buffer.from(await response.arrayBuffer());
        }

        await sock.sendMessage(jid, { 
            audio: audioBuffer, 
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true
        });

        log(`📤 Áudio enviado para ${jid}`);
        res.json({ success: true, ok: true, message: 'Áudio enviado' });
    } catch (error) {
        res.status(500).json({ success: false, ok: false, error: error.message });
    }
});

// Logout
app.post('/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        
        connectionStatus = 'disconnected';
        qrCode = null;
        qrDataUrl = null;
        qrPngBuffer = null;

        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });

        log('🔒 Logout realizado');
        res.json({ success: true, ok: true, message: 'Desconectado' });
    } catch (error) {
        res.status(500).json({ success: false, ok: false, error: error.message });
    }
});

// =============================================================
// INICIALIZAÇÃO
// =============================================================

app.listen(PORT, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════╗');
    console.log('║     🚀 VOXYAI WHATSAPP SERVER v4.1               ║');
    console.log('║        Render Free Edition                        ║');
    console.log('╠═══════════════════════════════════════════════════╣');
    console.log(`║  Porta: ${PORT}                                       ║`);
    console.log(`║  URL: ${SELF_URL || 'não configurada'}`.padEnd(54) + '║');
    console.log('╠═══════════════════════════════════════════════════╣');
    console.log('║  📱 Acesse /connect para conectar WhatsApp        ║');
    console.log('║  📊 Acesse /status para ver informações           ║');
    console.log('╚═══════════════════════════════════════════════════╝');
    console.log('');

    // Inicia WhatsApp
    connectWhatsApp();

    // Inicia keep-alive
    startKeepAlive();
});

// Graceful shutdown
process.on('SIGTERM', () => {
    log('Encerrando...');
    if (sock) sock.end();
    process.exit(0);
});
