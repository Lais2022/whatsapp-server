FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache git

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /var/data

EXPOSE 10000

CMD ["node", "servidor.js"]
