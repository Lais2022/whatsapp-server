# VoxyAI WhatsApp Server - Versão Gratuita
# Funciona no Render.com SEM disco persistente

FROM node:20-slim

# Instalar FFmpeg para conversão de áudio
RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    && rm -rf /var/lib/apt/lists/*

# Pasta de trabalho
WORKDIR /app

# Copiar arquivos
COPY package*.json ./
RUN npm install --production

COPY . .

# Porta
EXPOSE 3000

# Iniciar
CMD ["node", "servidor.js"]
