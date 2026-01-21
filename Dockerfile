FROM node:20-slim

# Instala git e ffmpeg
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Configura git para usar HTTPS (SEM aspas no final!)
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/
RUN git config --global url."https://github.com/".insteadOf git@github.com:

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p ./data/auth_info ./data/media

EXPOSE 3000

CMD ["node", "servidor.js"]
