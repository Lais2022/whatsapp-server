FROM node:20-slim

# Instala git e ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# IMPORTANTE: Configura git para HTTPS ANTES de instalar
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" && \
    git config --global url."https://github.com/".insteadOf "git@github.com:"

WORKDIR /app

# Copia package.json
COPY package*.json ./

# Instala dependências
RUN npm install --omit=dev

# Copia código
COPY . .

# Cria pasta de dados
RUN mkdir -p ./data/auth_info ./data/media

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "servidor.js"]
