# 🚀 WhatsApp Server - VoxyAI CRM

Servidor WhatsApp otimizado para **Render Free Tier**.

## 📁 Arquivos

| Arquivo | Descrição |
|---------|-----------|
| `servidor.js` | Código principal do servidor |
| `package.json` | Dependências do projeto |
| `Dockerfile` | Configuração Docker para Render |
| `render.yaml` | Deploy automático no Render |
| `.env.example` | Exemplo de variáveis de ambiente |

## 🔧 Deploy no Render (Passo a Passo)

### 1. Subir para GitHub
```bash
git add .
git commit -m "WhatsApp Server v4.2"
git push
```

### 2. Criar Web Service no Render
1. Acesse [render.com](https://render.com)
2. Clique **New > Web Service**
3. Conecte seu repositório GitHub
4. Configure:
   - **Name**: `whatsapp-server`
   - **Root Directory**: `standalone-project/backend`
   - **Runtime**: `Docker`
   - **Plan**: `Free`

### 3. Adicionar Variável de Ambiente
- **Key**: `SELF_URL`
- **Value**: `https://SEU-APP.onrender.com`

### 4. Deploy!
Clique **Create Web Service** e aguarde.

## 🔗 Endpoints

| Endpoint | Método | Descrição |
|----------|--------|-----------|
| `/health` | GET | Health check |
| `/connect` | GET | Página do QR Code |
| `/status` | GET | Status da conexão |
| `/qr` | GET | QR Code em JSON |
| `/qr.png` | GET | QR Code como imagem |
| `/send` | POST | Enviar mensagem de texto |
| `/send-image` | POST | Enviar imagem |
| `/send-audio` | POST | Enviar áudio |
| `/logout` | POST | Desconectar WhatsApp |
| `/force-reset` | POST | Resetar sessão |

## 📱 Conectar WhatsApp

1. Acesse: `https://seu-app.onrender.com/connect`
2. Escaneie o QR Code com WhatsApp
3. Pronto!

## ⚠️ Limitações do Free Tier

- Servidor hiberna após 15min sem uso
- Sessão pode ser perdida no restart
- Keep-alive automático a cada 4 minutos

## 📞 Suporte

Problemas? Acesse `/force-reset` e reconecte.
