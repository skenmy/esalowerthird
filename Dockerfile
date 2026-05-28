FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY relay.js ./
COPY source.html control.html index.html ./

ENV NODE_ENV=production
ENV RELAY_PORT=8081

EXPOSE 8081

CMD ["node", "relay.js"]
