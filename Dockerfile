# ============================================================
# DOCKERFILE - SERVIDOR WHATSAPP VOXYAI
# ============================================================
# 
# Inclui ffmpeg para conversão de áudio (WebM → OGG)
# Necessário para enviar áudios que funcionem no WhatsApp
#
# Build: docker build -t voxyai-whatsapp .
# Run: docker run -d -p 3000:3000 -v whatsapp-data:/var/data voxyai-whatsapp
# ============================================================

FROM node:20-slim

# Instala ffmpeg, git e openssh
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg git openssh-client && \
    rm -rf /var/lib/apt/lists/*

# Configura git para usar HTTPS em vez de SSH
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/
RUN git config --global url."https://github.com/".insteadOf git@github.com:

WORKDIR /app

# Copia e instala dependências
COPY package*.json ./
RUN npm install --omit=dev

# Copia o código
COPY . .

# Cria pastas de dados
RUN mkdir -p /var/data/auth_info /var/data/media

# Define variáveis de ambiente padrão
ENV PORT=3000
ENV DATA_FOLDER=/var/data
ENV NODE_ENV=production

# Expõe porta
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Inicia o servidor
CMD ["node", "servidor.js"]
