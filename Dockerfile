# ============================================
# DOCKERFILE - WhatsApp Server para Render Free
# VERSÃO OTIMIZADA PARA TIER GRATUITO
# ============================================

FROM node:20-slim

# Instalar dependências do sistema (mínimo necessário)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar package.json primeiro (cache de dependências)
COPY package*.json ./

# Forçar HTTPS para git (evita erros de SSH no Render)
RUN git config --global url."https://github.com/".insteadOf "git@github.com:" && \
    git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

# Instalar dependências (apenas produção)
RUN npm install --omit=dev

# Copiar código
COPY . .

# Criar pastas de dados
RUN mkdir -p ./data/auth_info

# Porta padrão do Render
EXPOSE 10000

# Healthcheck para Render (mantém o serviço vivo)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:${PORT:-10000}/health || exit 1

# Iniciar servidor
CMD ["node", "servidor.js"]
