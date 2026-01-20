/**
 * VoxyAI WhatsApp Server v4.1 - VERSÃO 100% GRATUITA
 * 
 * Funciona no Render.com SEM disco persistente (plano gratuito)
 * NOTA: A sessão é temporária - precisará escanear QR após reinício
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { 
    default: makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

// ========================================
// CONFIGURAÇÃO DE ARMAZENAMENTO (GRATUITO)
// ========================================

// Usa pasta local temporária (gratuito no Render)
// NOTA: Sessão será perdida ao reiniciar - precisará escanear QR novamente
const DATA_FOLDER = process.env.DATA_FOLDER || './data';
const AUTH_FOLDER = path.join(DATA_FOLDER, 'auth');
const MEDIA_FOLDER = path.join(DATA_FOLDER, 'media');

console.log(`📁 Usando pasta de dados: ${DATA_FOLDER}`);
console.log(`⚠️ MODO GRATUITO: Sessão temporária - QR necessário após reinício`);

// Criar pastas
[DATA_FOLDER, AUTH_FOLDER, MEDIA_FOLDER].forEach(folder => {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
        console.log(`📁 Pasta criada: ${folder}`);
    }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Timeout de 60 segundos
app.use((req, res, next) => {
    req.setTimeout(60000);
    res.setTimeout(60000);
    next();
});

// ========================================
// KEEP-ALIVE (Evita hibernação)
// ========================================

const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;

if (SELF_URL) {
    console.log(`🔄 Keep-alive ativado: ${SELF_URL}`);
    
    setInterval(async () => {
        try {
            const response = await fetch(`${SELF_URL}/health`);
            console.log(`💓 Keep-alive: ${response.status}`);
        } catch (error) {
            console.log(`⚠️ Keep-alive falhou: ${error.message}`);
        }
    }, 4 * 60 * 1000); // 4 minutos
} else {
    console.log(`⚠️ SELF_URL não configurada - servidor pode hibernar`);
}

// ========================================
// ESTADO GLOBAL
// ========================================

let sock = null;
let qrCode = null;
let connectionStatus = 'disconnected';
let lastConnected = null;
let messageHistory = [];
const MAX_MESSAGES = 500;

// ========================================
// FUNÇÕES AUXILIARES
// ========================================

function formatPhone(phone) {
    let cleaned = String(phone).replace(/\D/g, '');
    if (!cleaned.endsWith('@s.whatsapp.net')) {
        cleaned = `${cleaned}@s.whatsapp.net`;
    }
    return cleaned;
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function getExtension(mimetype) {
    const map = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
        'video/mp4': 'mp4', 'video/3gpp': '3gp',
        'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
        'application/pdf': 'pdf', 'application/msword': 'doc'
    };
    return map[mimetype] || 'bin';
}

function buildMediaUrl(req, filename) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${protocol}://${host}/media/${filename}`;
}

// Download e salva mídia
async function downloadAndSaveMedia(message, req) {
    try {
        const buffer = await downloadMediaMessage(message, 'buffer', {});
        const mimetype = message.message?.imageMessage?.mimetype ||
                        message.message?.videoMessage?.mimetype ||
                        message.message?.audioMessage?.mimetype ||
                        message.message?.stickerMessage?.mimetype ||
                        message.message?.documentMessage?.mimetype || 'application/octet-stream';
        
        const ext = getExtension(mimetype);
        const filename = `${generateId()}.${ext}`;
        const filepath = path.join(MEDIA_FOLDER, filename);
        
        fs.writeFileSync(filepath, buffer);
        console.log(`💾 Mídia salva: ${filename}`);
        
        return {
            filename,
            mimetype,
            url: buildMediaUrl(req, filename),
            size: buffer.length
        };
    } catch (error) {
        console.error('Erro ao baixar mídia:', error.message);
        return null;
    }
}

// ========================================
// CONEXÃO WHATSAPP
// ========================================

async function connectWhatsApp() {
    try {
        console.log('🔌 Iniciando conexão WhatsApp...');
        
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            browser: ['VoxyAI CRM', 'Chrome', '120.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 500,
            maxMsgRetryCount: 5,
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                qrCode = qr;
                connectionStatus = 'waiting_qr';
                console.log('📱 QR Code gerado - escaneie com WhatsApp');
            }
            
            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log(`❌ Desconectado. Razão: ${reason}`);
                
                connectionStatus = 'disconnected';
                qrCode = null;
                
                if (reason !== DisconnectReason.loggedOut) {
                    console.log('🔄 Reconectando em 5 segundos...');
                    setTimeout(connectWhatsApp, 5000);
                } else {
                    console.log('🚪 Logout - limpando sessão...');
                    try {
                        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
                    } catch (e) {}
                    setTimeout(connectWhatsApp, 3000);
                }
            }
            
            if (connection === 'open') {
                connectionStatus = 'connected';
                lastConnected = new Date().toISOString();
                qrCode = null;
                console.log('✅ WhatsApp conectado!');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            
            for (const msg of messages) {
                if (msg.key.fromMe) continue;
                
                const from = msg.key.remoteJid;
                const pushName = msg.pushName || 'Desconhecido';
                
                let content = '';
                let mediaInfo = null;
                let messageType = 'text';
                
                if (msg.message?.conversation) {
                    content = msg.message.conversation;
                } else if (msg.message?.extendedTextMessage) {
                    content = msg.message.extendedTextMessage.text;
                } else if (msg.message?.imageMessage) {
                    messageType = 'image';
                    content = msg.message.imageMessage.caption || '[Imagem]';
                } else if (msg.message?.videoMessage) {
                    messageType = 'video';
                    content = msg.message.videoMessage.caption || '[Vídeo]';
                } else if (msg.message?.audioMessage) {
                    messageType = 'audio';
                    content = '[Áudio]';
                } else if (msg.message?.stickerMessage) {
                    messageType = 'sticker';
                    content = '[Figurinha]';
                } else if (msg.message?.documentMessage) {
                    messageType = 'document';
                    content = msg.message.documentMessage.fileName || '[Documento]';
                }
                
                const messageData = {
                    id: msg.key.id,
                    from: from.replace('@s.whatsapp.net', ''),
                    fromFormatted: from,
                    name: pushName,
                    content,
                    type: messageType,
                    timestamp: new Date().toISOString(),
                    raw: msg
                };
                
                // Adiciona ao histórico
                messageHistory.unshift(messageData);
                if (messageHistory.length > MAX_MESSAGES) {
                    messageHistory = messageHistory.slice(0, MAX_MESSAGES);
                }
                
                console.log(`📨 ${pushName} (${from}): ${content}`);
            }
        });

        console.log('✅ Eventos configurados');
        
    } catch (error) {
        console.error('❌ Erro na conexão:', error);
        setTimeout(connectWhatsApp, 10000);
    }
}

// ========================================
// ENDPOINTS
// ========================================

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        mode: 'free',
        note: 'Sessão temporária - QR necessário após reinício'
    });
});

// Status
app.get('/', (req, res) => {
    res.json({
        server: 'VoxyAI WhatsApp Server v4.1',
        mode: 'FREE (sem disco persistente)',
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        lastConnected,
        hasQR: !!qrCode,
        messagesStored: messageHistory.length,
        note: '⚠️ Sessão temporária - escaneie QR novamente após reinício do servidor'
    });
});

app.get('/status', (req, res) => {
    res.json({
        ok: true,
        success: true,
        status: connectionStatus,
        connected: connectionStatus === 'connected',
        lastConnected,
        hasQR: !!qrCode,
        messagesCount: messageHistory.length,
        mode: 'free'
    });
});

// QR Code
app.get('/qr', (req, res) => {
    if (connectionStatus === 'connected') {
        return res.json({ 
            ok: true, 
            success: true, 
            connected: true, 
            message: 'Já conectado!' 
        });
    }
    
    if (!qrCode) {
        return res.json({ 
            ok: false, 
            success: false, 
            message: 'QR ainda não disponível. Aguarde...',
            status: connectionStatus
        });
    }
    
    res.json({ 
        ok: true, 
        success: true, 
        qr: qrCode,
        status: connectionStatus,
        instructions: 'Copie o valor "qr" e cole em: https://www.qr-code-generator.com/solutions/text-to-qr-code/'
    });
});

// Mensagens
app.get('/messages', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json({
        ok: true,
        success: true,
        messages: messageHistory.slice(0, limit),
        total: messageHistory.length
    });
});

// Servir mídia
app.get('/media/:filename', (req, res) => {
    const filepath = path.join(MEDIA_FOLDER, req.params.filename);
    
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'Arquivo não encontrado' });
    }
    
    res.sendFile(path.resolve(filepath));
});

// Enviar texto
app.post('/send', async (req, res) => {
    try {
        const phone = req.body.to || req.body.phone || req.body.number;
        const message = req.body.message || req.body.text || req.body.content;
        
        if (!phone || !message) {
            return res.status(400).json({ 
                ok: false, 
                success: false, 
                error: 'Campos "to" e "message" são obrigatórios' 
            });
        }
        
        if (connectionStatus !== 'connected' || !sock) {
            return res.status(503).json({ 
                ok: false, 
                success: false, 
                error: 'WhatsApp não conectado' 
            });
        }
        
        const jid = formatPhone(phone);
        await sock.sendMessage(jid, { text: message });
        
        console.log(`📤 Mensagem enviada para ${phone}`);
        res.json({ ok: true, success: true, message: 'Mensagem enviada!' });
        
    } catch (error) {
        console.error('Erro ao enviar:', error);
        res.status(500).json({ ok: false, success: false, error: error.message });
    }
});

// Enviar imagem
app.post('/send-image', async (req, res) => {
    try {
        const phone = req.body.to || req.body.phone || req.body.number;
        const image = req.body.image || req.body.media || req.body.base64;
        const caption = req.body.caption || req.body.message || '';
        
        if (!phone || !image) {
            return res.status(400).json({ 
                ok: false, 
                success: false, 
                error: 'Campos "to" e "image" são obrigatórios' 
            });
        }
        
        if (connectionStatus !== 'connected' || !sock) {
            return res.status(503).json({ 
                ok: false, 
                success: false, 
                error: 'WhatsApp não conectado' 
            });
        }
        
        const jid = formatPhone(phone);
        const buffer = Buffer.from(image, 'base64');
        
        await sock.sendMessage(jid, { 
            image: buffer, 
            caption 
        });
        
        console.log(`📤 Imagem enviada para ${phone}`);
        res.json({ ok: true, success: true, message: 'Imagem enviada!' });
        
    } catch (error) {
        console.error('Erro ao enviar imagem:', error);
        res.status(500).json({ ok: false, success: false, error: error.message });
    }
});

// Enviar áudio
app.post('/send-audio', async (req, res) => {
    try {
        const phone = req.body.to || req.body.phone || req.body.number;
        const audio = req.body.audio || req.body.media || req.body.base64;
        
        if (!phone || !audio) {
            return res.status(400).json({ 
                ok: false, 
                success: false, 
                error: 'Campos "to" e "audio" são obrigatórios' 
            });
        }
        
        if (connectionStatus !== 'connected' || !sock) {
            return res.status(503).json({ 
                ok: false, 
                success: false, 
                error: 'WhatsApp não conectado' 
            });
        }
        
        const jid = formatPhone(phone);
        let buffer = Buffer.from(audio, 'base64');
        
        // Tenta converter para OGG se FFmpeg disponível
        try {
            const tempInput = path.join(DATA_FOLDER, `temp_${Date.now()}.webm`);
            const tempOutput = path.join(DATA_FOLDER, `temp_${Date.now()}.ogg`);
            
            fs.writeFileSync(tempInput, buffer);
            execSync(`ffmpeg -i ${tempInput} -c:a libopus -b:a 64k ${tempOutput} -y`, { stdio: 'ignore' });
            buffer = fs.readFileSync(tempOutput);
            
            // Limpar arquivos temporários
            fs.unlinkSync(tempInput);
            fs.unlinkSync(tempOutput);
            
            console.log('🔊 Áudio convertido para OGG');
        } catch (e) {
            console.log('⚠️ FFmpeg não disponível, enviando áudio original');
        }
        
        await sock.sendMessage(jid, { 
            audio: buffer,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true
        });
        
        console.log(`📤 Áudio enviado para ${phone}`);
        res.json({ ok: true, success: true, message: 'Áudio enviado!' });
        
    } catch (error) {
        console.error('Erro ao enviar áudio:', error);
        res.status(500).json({ ok: false, success: false, error: error.message });
    }
});

// Enviar vídeo
app.post('/send-video', async (req, res) => {
    try {
        const phone = req.body.to || req.body.phone || req.body.number;
        const video = req.body.video || req.body.media || req.body.base64;
        const caption = req.body.caption || req.body.message || '';
        
        if (!phone || !video) {
            return res.status(400).json({ 
                ok: false, 
                success: false, 
                error: 'Campos "to" e "video" são obrigatórios' 
            });
        }
        
        if (connectionStatus !== 'connected' || !sock) {
            return res.status(503).json({ 
                ok: false, 
                success: false, 
                error: 'WhatsApp não conectado' 
            });
        }
        
        const jid = formatPhone(phone);
        const buffer = Buffer.from(video, 'base64');
        
        await sock.sendMessage(jid, { 
            video: buffer, 
            caption 
        });
        
        console.log(`📤 Vídeo enviado para ${phone}`);
        res.json({ ok: true, success: true, message: 'Vídeo enviado!' });
        
    } catch (error) {
        console.error('Erro ao enviar vídeo:', error);
        res.status(500).json({ ok: false, success: false, error: error.message });
    }
});

// Enviar documento
app.post('/send-document', async (req, res) => {
    try {
        const phone = req.body.to || req.body.phone || req.body.number;
        const document = req.body.document || req.body.media || req.body.base64;
        const filename = req.body.filename || 'documento.pdf';
        const mimetype = req.body.mimetype || 'application/pdf';
        
        if (!phone || !document) {
            return res.status(400).json({ 
                ok: false, 
                success: false, 
                error: 'Campos "to" e "document" são obrigatórios' 
            });
        }
        
        if (connectionStatus !== 'connected' || !sock) {
            return res.status(503).json({ 
                ok: false, 
                success: false, 
                error: 'WhatsApp não conectado' 
            });
        }
        
        const jid = formatPhone(phone);
        const buffer = Buffer.from(document, 'base64');
        
        await sock.sendMessage(jid, { 
            document: buffer,
            fileName: filename,
            mimetype
        });
        
        console.log(`📤 Documento enviado para ${phone}`);
        res.json({ ok: true, success: true, message: 'Documento enviado!' });
        
    } catch (error) {
        console.error('Erro ao enviar documento:', error);
        res.status(500).json({ ok: false, success: false, error: error.message });
    }
});

// Logout
app.post('/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        
        // Limpar sessão
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        
        connectionStatus = 'disconnected';
        qrCode = null;
        
        console.log('🚪 Logout realizado');
        res.json({ ok: true, success: true, message: 'Logout realizado!' });
        
    } catch (error) {
        console.error('Erro no logout:', error);
        res.status(500).json({ ok: false, success: false, error: error.message });
    }
});

// ========================================
// INICIAR SERVIDOR
// ========================================

app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║     VoxyAI WhatsApp Server v4.1 - VERSÃO GRATUITA        ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  🌐 Servidor: http://localhost:${PORT}                        ║`);
    console.log('║  ⚠️  Modo: GRATUITO (sem disco persistente)               ║');
    console.log('║  📱 Escaneie o QR após cada reinício do servidor         ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    
    // Iniciar conexão
    connectWhatsApp();
});
