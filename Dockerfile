FROM node:20-slim

# Instala git e openssh-client (npm precisa do ssh instalado mesmo que redirecionemos)
RUN apt-get update && \
    apt-get install -y --no-install-recommends git openssh-client ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# FORÇA git a usar HTTPS em vez de SSH (ANTES do npm install)
RUN git config --global url."https://github.com/".insteadOf "git@github.com:" && \
    git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

WORKDIR /app

COPY package*.json ./

# Limpa cache npm e instala
RUN npm cache clean --force && npm install --omit=dev

COPY . .

RUN mkdir -p ./data/auth_info ./data/media

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "servidor.js"]
