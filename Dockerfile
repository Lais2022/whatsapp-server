FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /var/data

ENV PORT=10000
ENV DATA_FOLDER=/var/data

EXPOSE 10000

CMD ["npm", "start"]
