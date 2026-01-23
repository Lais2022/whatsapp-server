# ============================================
# DOCKERFILE - WhatsApp Server para Render Free
# ============================================

FROM node:20-slim

# Instalar dependências do sistema
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    git \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar package.json primeiro (cache de dependências)
COPY package*.json ./

# Forçar HTTPS para git (evita erros de SSH no Render)
RUN git config --global url."https://github.com/".insteadOf "git@github.com:" && \
    git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

# Instalar dependências
RUN npm install --omit=dev

# Copiar código
COPY . .

EXPOSE 3000

CMD ["node", "servidor.js"]
