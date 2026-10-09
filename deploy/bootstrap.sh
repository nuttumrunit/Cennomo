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
    'CENNOMO_TOKEN_MINT=8x4a5m2NvC6gvyexsXbnRFwMX9L3G9vTQfEnnsdgpump' \
    'PUMPFUN_URL=https://pump.fun/coin/8x4a5m2NvC6gvyexsXbnRFwMX9L3G9vTQfEnnsdgpump' \
    'CENNOMO_TREASURY_ADDRESS=BRSHFhFophdKrfoiFRFEGoWoUonJmWtW8JSuAnvsAcCL' \
    'CENNOMO_DEFAULT_CALL_FEE_LAMPORTS=0' > .env.production
fi

# Public launch values are reconciled on every deployment. This keeps the
# website, burn verification and Pump.fun destination on the same mint.
if grep -q '^CENNOMO_TOKEN_MINT=' .env.production; then
  sed -i 's|^CENNOMO_TOKEN_MINT=.*$|CENNOMO_TOKEN_MINT=8x4a5m2NvC6gvyexsXbnRFwMX9L3G9vTQfEnnsdgpump|' .env.production
else
  printf '%s\n' 'CENNOMO_TOKEN_MINT=8x4a5m2NvC6gvyexsXbnRFwMX9L3G9vTQfEnnsdgpump' >> .env.production
fi
if grep -q '^PUMPFUN_URL=' .env.production; then
  sed -i 's|^PUMPFUN_URL=.*$|PUMPFUN_URL=https://pump.fun/coin/8x4a5m2NvC6gvyexsXbnRFwMX9L3G9vTQfEnnsdgpump|' .env.production
else
  printf '%s\n' 'PUMPFUN_URL=https://pump.fun/coin/8x4a5m2NvC6gvyexsXbnRFwMX9L3G9vTQfEnnsdgpump' >> .env.production
fi

# Keep the public browser allowlist current on every deployment. Secrets and
# other production values remain untouched when the environment already exists.
if grep -q '^CENNOMO_WEB_ORIGINS=' .env.production; then
  sed -i "s|^CENNOMO_WEB_ORIGINS=.*$|CENNOMO_WEB_ORIGINS=${CENNOMO_WEB_ORIGIN}|" .env.production
else
  printf '%s\n' "CENNOMO_WEB_ORIGINS=${CENNOMO_WEB_ORIGIN}" >> .env.production
fi

export CENNOMO_HOST
docker compose -f docker-compose.production.yml up -d --build --remove-orphans
docker image prune -f
docker compose -f docker-compose.production.yml ps
sleep 5
docker compose -f docker-compose.production.yml logs --tail=120 cennomo
