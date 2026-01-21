FROM node:20-slim

# Instala git e ffmpeg
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# IMPORTANTE: Configura git para usar HTTPS antes de qualquer npm install
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" && \
    git config --global url."https://github.com/".insteadOf "git@github.com:"

WORKDIR /app

COPY package*.json ./

# Agora o npm install vai funcionar
RUN npm install --omit=dev

COPY . .

RUN mkdir -p ./data/auth_info ./data/media

EXPOSE 3000

CMD ["node", "servidor.js"]
