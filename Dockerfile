FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4185 \
    CHROME_PATH=/usr/bin/chromium

EXPOSE 4185
CMD ["node", "launcher.mjs"]
