# WhatsApp Server v4.5.0

## Deploy no Render

1. Crie um repositório GitHub com estes 6 arquivos
2. No Render, crie um Web Service → Docker
3. Conecte seu repositório
4. Deixe "Root Directory" VAZIO
5. Após deploy, copie a URL e configure em SELF_URL
6. Acesse /connect para escanear o QR Code

## Endpoints

- GET /health - Status do servidor
- GET /connect - Página para escanear QR
- GET /status - Status completo
- POST /send - Enviar mensagem
- POST /force-reset - Resetar sessão
