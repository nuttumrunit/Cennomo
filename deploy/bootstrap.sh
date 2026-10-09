#!/usr/bin/env bash
set -euo pipefail

: "${CENNOMO_HOST:?CENNOMO_HOST is required}"
: "${CENNOMO_WEB_ORIGIN:?CENNOMO_WEB_ORIGIN is required}"

cd /opt/cennomo
install -d -m 0755 data streams

if [[ ! -f .env.production ]]; then
  umask 077
  worker_token="$(openssl rand -hex 32)"
  admin_token="$(openssl rand -hex 32)"
  encryption_key="$(openssl rand -hex 32)"
  printf '%s\n' \
    'NODE_ENV=production' \
    'HOST=0.0.0.0' \
    'PORT=4185' \
    "PUBLIC_ORIGIN=https://${CENNOMO_HOST}" \
    "CENNOMO_WEB_ORIGINS=${CENNOMO_WEB_ORIGIN}" \
    "CENNOMO_WORKER_TOKEN=${worker_token}" \
    "CENNOMO_ADMIN_TOKEN=${admin_token}" \
    "CENNOMO_ENCRYPTION_KEY=${encryption_key}" \
    'CENNOMO_WORKER_ID=production-worker-01' \
    'CENNOMO_WORKER_INTERVAL_MS=60000' \
    'SOLANA_CLUSTER=mainnet-beta' \
    'SOLANA_RPC_URL=https://api.mainnet-beta.solana.com' \
    'CENNOMO_BURN_AMOUNT=10000' \
    'PUMPFUN_URL=https://pump.fun/' \
    'CENNOMO_TREASURY_ADDRESS=BRSHFhFophdKrfoiFRFEGoWoUonJmWtW8JSuAnvsAcCL' \
    'CENNOMO_DEFAULT_CALL_FEE_LAMPORTS=0' > .env.production
fi

export CENNOMO_HOST
docker compose -f docker-compose.production.yml up -d --build --remove-orphans
docker image prune -f
docker compose -f docker-compose.production.yml ps
