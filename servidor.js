/**
 * =============================================================
 * SERVIDOR WHATSAPP VOXYAI - VERSÃO 4.0 ALWAYS-ON
 * =============================================================
 * 
 * Recursos:
 * - Always-On: Self-ping a cada 4 minutos para evitar hibernação
 * - Mídia Persistente: Download e armazenamento local de mídia
 * - Sessão Persistente: Mantém sessão entre restarts
 * - Timeouts de 60s: Suporta conexões lentas
 * - Auto-Reconexão: Reconecta automaticamente se desconectar
 * - QR Local: Gera QR code localmente (sem API externa)
 * 
 * Deploy: Render.com, Railway, Heroku, VPS, Docker
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
const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}`;
const KEEPALIVE_INTERVAL = parseInt(process.env.KEEPALIVE_INTERVAL || '4') * 60 * 1000;
const MEDIA_RETENTION_DAYS = parseInt(process.env.MEDIA_RETENTION_DAYS || '7');

// Detecta se está em ambiente de produção (Docker/Render)
const DATA_FOLDER = process.env.DATA_FOLDER || (fs.existsSync('/var/data') ? '/var/data' : './data');
const AUTH_FOLDER = path.join(DATA_FOLDER, 'auth_info');
const MEDIA_FOLDER = path.join(DATA_FOLDER, 'media');

// Garante que as pastas existem
[DATA_FOLDER, AUTH_FOLDER, MEDIA_FOLDER].forEach(folder => {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
    }
});

// Logger silencioso para Baileys
const logger = pino({ level: 'silent' });

// Estado global
let sock = null;
let qrCode = null;
let qrDataUrl = null;
let connectionStatus = 'disconnected';
let lastConnectionTime = null;
let reconnectAttempts = 0;
let messages = [];
const MAX_MESSAGES = 100;

// =============================================================
// MIDDLEWARES
// =============================================================

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Timeout de 60 segundos para todas as requisições
app.use((req, res, next) => {
    req.setTimeout(60000);
    res.setTimeout(60000);
    next();
});

// Serve arquivos de mídia
app.use('/media', express.static(MEDIA_FOLDER, {
    maxAge: '7d',
    etag: true
}));

// =============================================================
// FUNÇÕES AUXILIARES
// =============================================================

function log(message, data = null) {
    const timestamp = new Date().toISOString();
    if (data) {
        console.log(`[${timestamp}] ${message}`, data);
    } else {
        console.log(`[${timestamp}] ${message}`);
    }
}

function formatPhone(phone) {
    let cleaned = phone.replace(/\D/g, '');
    if (!cleaned.includes('@')) {
        cleaned = cleaned + '@s.whatsapp.net';
    }
    return cleaned;
}

async function downloadAndSaveMedia(message, messageType) {
    try {
        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
        const buffer = await downloadMediaMessage(message, 'buffer', {});
        
        if (!buffer || buffer.length === 0) {
            return null;
        }

        const extensions = {
            imageMessage: 'jpg',
            videoMessage: 'mp4',
            audioMessage: 'ogg',
            stickerMessage: 'webp',
            documentMessage: message.message?.documentMessage?.fileName?.split('.').pop() || 'bin'
        };

        const ext = extensions[messageType] || 'bin';
        const filename = `${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
        const filepath = path.join(MEDIA_FOLDER, filename);

        fs.writeFileSync(filepath, buffer);
        log(`Mídia salva: ${filename}`);

        return {
            filename,
            localUrl: `/media/${filename}`,
            fullUrl: `${SELF_URL}/media/${filename}`,
            size: buffer.length,
            mimeType: message.message?.[messageType]?.mimetype || 'application/octet-stream'
        };
    } catch (error) {
        log('Erro ao baixar mídia:', error.message);
        return null;
    }
}

function cleanOldMedia() {
    try {
        const files = fs.readdirSync(MEDIA_FOLDER);
        const now = Date.now();
        const maxAge = MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        let cleaned = 0;

        files.forEach(file => {
            const filepath = path.join(MEDIA_FOLDER, file);
            const stats = fs.statSync(filepath);
            if (now - stats.mtimeMs > maxAge) {
                fs.unlinkSync(filepath);
                cleaned++;
            }
        });

        if (cleaned > 0) {
            log(`Limpeza de mídia: ${cleaned} arquivos removidos`);
        }
    } catch (error) {
        log('Erro na limpeza de mídia:', error.message);
    }
}

// Limpeza diária de mídia antiga
setInterval(cleanOldMedia, 24 * 60 * 60 * 1000);

// =============================================================
// KEEP-ALIVE (ANTI-HIBERNAÇÃO)
// =============================================================

function startKeepAlive() {
    if (!SELF_URL || SELF_URL.includes('localhost')) {
        log('Keep-alive desativado (ambiente local)');
        return;
    }

    log(`Keep-alive ativado: ping a cada ${KEEPALIVE_INTERVAL / 60000} minutos para ${SELF_URL}`);

    setInterval(() => {
        const url = `${SELF_URL}/health`;
        const client = url.startsWith('https') ? https : http;

        client.get(url, (res) => {
            log(`Keep-alive: status ${res.statusCode}`);
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
        log('Iniciando conexão WhatsApp...');
        
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
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 500
        });

        // Evento de atualização de conexão
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCode = qr;
                qrDataUrl = await QRCode.toDataURL(qr);
                connectionStatus = 'waiting_qr';
                log('Novo QR Code gerado');
            }

            if (connection === 'open') {
                connectionStatus = 'connected';
                lastConnectionTime = new Date();
                reconnectAttempts = 0;
                qrCode = null;
                qrDataUrl = null;
                log('WhatsApp conectado com sucesso!');
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                log(`Conexão fechada. Código: ${statusCode}. Reconectar: ${shouldReconnect}`);
                connectionStatus = 'disconnected';

                if (shouldReconnect) {
                    reconnectAttempts++;
                    const delay = Math.min(5000 * reconnectAttempts, 60000);
                    log(`Tentando reconectar em ${delay / 1000}s (tentativa ${reconnectAttempts})`);
                    setTimeout(connectWhatsApp, delay);
                } else {
                    log('Logout manual - limpando credenciais');
                    try {
                        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
                    } catch (e) {
                        log('Erro ao limpar credenciais:', e.message);
                    }
                }
            }
        });

        // Salva credenciais
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

                const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 
                                 'documentMessage', 'stickerMessage'].includes(messageType);

                let mediaInfo = null;
                if (isMedia) {
                    mediaInfo = await downloadAndSaveMedia(msg, messageType);
                }

                const messageData = {
                    id: msg.key.id,
                    from: msg.key.remoteJid,
                    fromMe: msg.key.fromMe,
                    timestamp: msg.messageTimestamp,
                    type: messageType,
                    text: msg.message.conversation || 
                          msg.message.extendedTextMessage?.text || 
                          msg.message[messageType]?.caption || '',
                    media: mediaInfo,
                    pushName: msg.pushName || '',
                    raw: msg
                };

                messages.unshift(messageData);
                if (messages.length > MAX_MESSAGES) {
                    messages = messages.slice(0, MAX_MESSAGES);
                }

                log(`Nova mensagem de ${messageData.from}: ${messageData.text || '[mídia]'}`);
            }
        });

    } catch (error) {
        log('Erro na conexão:', error.message);
        connectionStatus = 'error';
        
        reconnectAttempts++;
        const delay = Math.min(5000 * reconnectAttempts, 60000);
        log(`Tentando novamente em ${delay / 1000}s`);
        setTimeout(connectWhatsApp, delay);
    }
}

// =============================================================
// ENDPOINTS DA API
// =============================================================

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Status detalhado
app.get('/status', (req, res) => {
    const mediaFiles = fs.existsSync(MEDIA_FOLDER) ? fs.readdirSync(MEDIA_FOLDER).length : 0;
    
    res.json({
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        hasQR: !!qrCode,
        lastConnection: lastConnectionTime,
        reconnectAttempts,
        messagesCount: messages.length,
        mediaCount: mediaFiles,
        storagePath: DATA_FOLDER,
        version: '4.0.0',
        uptime: process.uptime()
    });
});

// QR Code
app.get('/qr', (req, res) => {
    if (connectionStatus === 'connected') {
        return res.json({ 
            success: false, 
            message: 'Já conectado',
            connected: true 
        });
    }

    if (!qrDataUrl) {
        return res.json({ 
            success: false, 
            message: 'QR Code ainda não disponível. Aguarde...',
            status: connectionStatus
        });
    }

    res.json({ 
        success: true, 
        qr: qrDataUrl,
        status: connectionStatus
    });
});

// Listar mensagens
app.get('/messages', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    res.json({
        success: true,
        messages: messages.slice(offset, offset + limit),
        total: messages.length
    });
});

// Enviar mensagem de texto
app.post('/send', async (req, res) => {
    try {
        // Aceita múltiplos formatos de parâmetros
        const phone = req.body.phone || req.body.to;
        const message = req.body.message || req.body.text;

        if (!phone || !message) {
            return res.status(400).json({ 
                success: false,
                ok: false,
                error: 'phone/to e message/text são obrigatórios' 
            });
        }

        if (connectionStatus !== 'connected' || !sock) {
            return res.status(503).json({ 
                success: false,
                ok: false,
                error: 'WhatsApp não conectado',
                status: connectionStatus
            });
        }

        const jid = formatPhone(phone);
        await sock.sendMessage(jid, { text: message });

        log(`Mensagem enviada para ${jid}: ${message.substring(0, 50)}...`);

        res.json({ 
            success: true,
            ok: true,
            message: 'Mensagem enviada',
            to: jid
        });
    } catch (error) {
        log('Erro ao enviar:', error.message);
        res.status(500).json({ 
            success: false,
            ok: false,
            error: error.message 
        });
    }
});

// Enviar imagem
app.post('/send-image', async (req, res) => {
    try {
        // Aceita múltiplos formatos de parâmetros
        const phone = req.body.phone || req.body.to;
        const imageBase64 = req.body.imageBase64 || req.body.image;
        const imageUrl = req.body.imageUrl;
        const caption = req.body.caption || '';

        if (!phone || (!imageUrl && !imageBase64)) {
            return res.status(400).json({ 
                success: false,
                ok: false,
                error: 'phone/to e (imageUrl ou imageBase64/image) são obrigatórios' 
            });
        }

        if (connectionStatus !== 'connected' || !sock) {
            return res.status(503).json({ 
                success: false,
                ok: false,
                error: 'WhatsApp não conectado' 
            });
        }

        const jid = formatPhone(phone);
        let imageBuffer;

        if (imageBase64) {
            imageBuffer = Buffer.from(imageBase64, 'base64');
        } else {
            const response = await fetch(imageUrl);
            imageBuffer = Buffer.from(await response.arrayBuffer());
        }

        await sock.sendMessage(jid, { 
            image: imageBuffer, 
            caption: caption 
        });

        log(`Imagem enviada para ${jid}`);
        res.json({ success: true, ok: true, message: 'Imagem enviada' });
    } catch (error) {
        log('Erro ao enviar imagem:', error.message);
        res.status(500).json({ success: false, ok: false, error: error.message });
    }
});

// Enviar áudio
app.post('/send-audio', async (req, res) => {
    try {
        // Aceita múltiplos formatos de parâmetros
        const phone = req.body.phone || req.body.to;
        const audioBase64 = req.body.audioBase64 || req.body.audio;
        const audioUrl = req.body.audioUrl;
        const inputMimetype = (req.body.mimetype || 'audio/webm').toLowerCase();
        const ptt = req.body.ptt !== false; // Default: true (áudio de voz)

        if (!phone || (!audioUrl && !audioBase64)) {
            return res.status(400).json({ 
                success: false,
                ok: false,
                error: 'phone/to e (audioUrl ou audioBase64/audio) são obrigatórios' 
            });
        }

        if (connectionStatus !== 'connected' || !sock) {
            return res.status(503).json({ 
                success: false,
                ok: false,
                error: 'WhatsApp não conectado' 
            });
        }

        const jid = formatPhone(phone);
        let audioBuffer;

        if (audioBase64) {
            audioBuffer = Buffer.from(audioBase64, 'base64');
        } else {
            const response = await fetch(audioUrl);
            audioBuffer = Buffer.from(await response.arrayBuffer());
        }

        const sizeKb = Math.round(audioBuffer.length / 1024);
        log(`Áudio recebido: ${sizeKb}KB, mimetype: ${inputMimetype}`);

        let finalMimetype = 'audio/ogg; codecs=opus';
        const needsConversion = inputMimetype.includes('webm');

        // Tenta converter WebM para OGG se FFmpeg disponível
        if (needsConversion) {
            try {
                const { execSync } = require('child_process');
                const os = require('os');
                const tmpDir = os.tmpdir();
                const timestamp = Date.now();
                const inputPath = path.join(tmpDir, `audio_in_${timestamp}.webm`);
                const outputPath = path.join(tmpDir, `audio_out_${timestamp}.ogg`);

                fs.writeFileSync(inputPath, audioBuffer);

                execSync(`ffmpeg -i "${inputPath}" -c:a libopus -b:a 64k -ar 48000 "${outputPath}" -y 2>/dev/null`, {
                    timeout: 60000,
                    stdio: 'pipe',
                });

                if (fs.existsSync(outputPath)) {
                    audioBuffer = fs.readFileSync(outputPath);
                    log(`Áudio convertido para OGG: ${Math.round(audioBuffer.length / 1024)}KB`);
                }

                try { fs.unlinkSync(inputPath); } catch { }
                try { fs.unlinkSync(outputPath); } catch { }
            } catch (conversionError) {
                log(`FFmpeg não disponível ou erro: ${conversionError.message}`);
                // Continua com WebM se não conseguir converter
            }
        }

        await sock.sendMessage(jid, { 
            audio: audioBuffer, 
            mimetype: finalMimetype,
            ptt: ptt,
            seconds: Math.ceil(sizeKb / 8)
        });

        log(`Áudio enviado para ${jid}`);
        res.json({ success: true, ok: true, message: 'Áudio enviado' });
    } catch (error) {
        log('Erro ao enviar áudio:', error.message);
        res.status(500).json({ success: false, ok: false, error: error.message });
    }
});

// Enviar vídeo
app.post('/send-video', async (req, res) => {
    try {
        // Aceita múltiplos formatos de parâmetros
        const phone = req.body.phone || req.body.to;
        const videoBase64 = req.body.videoBase64 || req.body.video;
        const videoUrl = req.body.videoUrl;
        const caption = req.body.caption || '';
        const mimetype = req.body.mimetype || 'video/mp4';

        if (!phone || (!videoUrl && !videoBase64)) {
            return res.status(400).json({ 
                success: false,
                ok: false,
                error: 'phone/to e (videoUrl ou videoBase64/video) são obrigatórios' 
            });
        }

        if (connectionStatus !== 'connected' || !sock) {
            return res.status(503).json({ 
                success: false,
                ok: false,
                error: 'WhatsApp não conectado' 
            });
        }

        const jid = formatPhone(phone);
        let videoBuffer;

        if (videoBase64) {
            videoBuffer = Buffer.from(videoBase64, 'base64');
        } else {
            const response = await fetch(videoUrl);
            videoBuffer = Buffer.from(await response.arrayBuffer());
        }

        await sock.sendMessage(jid, { 
            video: videoBuffer, 
            caption: caption,
            mimetype: mimetype
        });

        log(`Vídeo enviado para ${jid}`);
        res.json({ success: true, ok: true, message: 'Vídeo enviado' });
    } catch (error) {
        log('Erro ao enviar vídeo:', error.message);
        res.status(500).json({ success: false, ok: false, error: error.message });
    }
});

// Enviar documento
app.post('/send-document', async (req, res) => {
    try {
        // Aceita múltiplos formatos de parâmetros
        const phone = req.body.phone || req.body.to;
        const documentBase64 = req.body.documentBase64 || req.body.document;
        const documentUrl = req.body.documentUrl;
        const filename = req.body.filename || 'documento';
        const mimetype = req.body.mimetype || 'application/octet-stream';

        if (!phone || (!documentUrl && !documentBase64)) {
            return res.status(400).json({ 
                success: false,
                ok: false,
                error: 'phone/to e (documentUrl ou documentBase64/document) são obrigatórios' 
            });
        }

        if (connectionStatus !== 'connected' || !sock) {
            return res.status(503).json({ 
                success: false,
                ok: false,
                error: 'WhatsApp não conectado' 
            });
        }

        const jid = formatPhone(phone);
        let docBuffer;

        if (documentBase64) {
            docBuffer = Buffer.from(documentBase64, 'base64');
        } else {
            const response = await fetch(documentUrl);
            docBuffer = Buffer.from(await response.arrayBuffer());
        }

        await sock.sendMessage(jid, { 
            document: docBuffer, 
            fileName: filename,
            mimetype: mimetype
        });

        log(`Documento enviado para ${jid}`);
        res.json({ success: true, ok: true, message: 'Documento enviado' });
    } catch (error) {
        log('Erro ao enviar documento:', error.message);
        res.status(500).json({ success: false, ok: false, error: error.message });
    }
});

// Enviar mídia genérico
app.post('/send-media', async (req, res) => {
    try {
        const phone = req.body.phone || req.body.to;
        const media = req.body.media;
        const type = req.body.type;
        const mimetype = req.body.mimetype;
        const filename = req.body.filename || 'arquivo';
        const caption = req.body.caption || '';

        if (!phone || !media) {
            return res.status(400).json({ 
                success: false,
                ok: false,
                error: 'phone/to e media são obrigatórios' 
            });
        }

        if (connectionStatus !== 'connected' || !sock) {
            return res.status(503).json({ 
                success: false,
                ok: false,
                error: 'WhatsApp não conectado' 
            });
        }

        const jid = formatPhone(phone);
        const buffer = Buffer.from(media, 'base64');
        let messageContent = {};

        switch (type) {
            case 'image':
                messageContent = { image: buffer, caption };
                break;
            case 'video':
                messageContent = { video: buffer, caption, mimetype: mimetype || 'video/mp4' };
                break;
            case 'audio':
                messageContent = { audio: buffer, mimetype: mimetype || 'audio/ogg; codecs=opus', ptt: true };
                break;
            case 'document':
                messageContent = { document: buffer, fileName: filename, mimetype: mimetype || 'application/octet-stream' };
                break;
            default:
                return res.status(400).json({ success: false, ok: false, error: 'Tipo inválido' });
        }

        await sock.sendMessage(jid, messageContent);
        log(`Mídia ${type} enviada para ${jid}`);
        res.json({ success: true, ok: true, message: `${type} enviado` });
    } catch (error) {
        log('Erro ao enviar mídia:', error.message);
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

        // Limpa credenciais
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });

        log('Logout realizado com sucesso');
        res.json({ success: true, ok: true, message: 'Desconectado com sucesso' });
    } catch (error) {
        log('Erro no logout:', error.message);
        res.status(500).json({ success: false, ok: false, error: error.message });
    }
});

// =============================================================
// INICIALIZAÇÃO
// =============================================================

app.listen(PORT, () => {
    log(`===========================================`);
    log(`  VOXYAI WHATSAPP SERVER v4.0 ALWAYS-ON`);
    log(`===========================================`);
    log(`Porta: ${PORT}`);
    log(`URL: ${SELF_URL}`);
    log(`Dados: ${DATA_FOLDER}`);
    log(`Auth: ${AUTH_FOLDER}`);
    log(`Mídia: ${MEDIA_FOLDER}`);
    log(`===========================================`);

    // Inicia conexão WhatsApp
    connectWhatsApp();

    // Inicia keep-alive
    startKeepAlive();

    // Limpeza inicial de mídia antiga
    cleanOldMedia();
});

// Graceful shutdown
process.on('SIGTERM', () => {
    log('Recebido SIGTERM, encerrando...');
    if (sock) {
        sock.end();
    }
    process.exit(0);
});

process.on('SIGINT', () => {
    log('Recebido SIGINT, encerrando...');
    if (sock) {
        sock.end();
    }
    process.exit(0);
});
