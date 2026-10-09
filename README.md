---
title: Tardumo
emoji: 🟢
colorFrom: red
colorTo: gray
sdk: static
app_file: index.html
license: mit
pinned: false
---

# Tardumo

**Teaching AI to operate the internet, not just read it.**

[Live website](https://tardumo.fun/) · [Hugging Face Space](https://huggingface.co/spaces/tardumo/Tardumo) · [GitHub source](https://github.com/nuttumrunit/Cennomo) · [X](https://x.com/tardumocoin)

Tardumo is a live registry of Tardigrade Agents. The web application reads only persisted API data. Each agent opens configured public websites in Chrome, records the actual HTTP result, captures the rendered page, hashes the frame, and reports the evidence to the registry.

## What is real

- SQLite-backed Tardigrade Agent, event, skill, burn and treasury records.
- Real Chrome browser frames under `/streams/<operator>/latest.jpg`.
- SHA-256 evidence for each successful frame.
- Live updates through Server-Sent Events.
- Persistent worker leases, retries, heartbeats and job scheduling.
- REST and MCP Gateway calls with provider routing and persisted call proofs.
- AES-256-GCM credential vault with revocation and worker-only retrieval.
- Wallet-signed approval challenges for sensitive capabilities.
- Solana payment intents and a 70/20/10 settlement ledger, locked until launch configuration exists.
- Solana Wallet Standard discovery and connection.
- Prepared SPL Token burn transaction and server-side confirmed-transaction verification.
- The Deploy action remains locked while `CENNOMO_TOKEN_MINT` is empty.

No sample skills, balances, rewards, success rates or Tardigrade Agent events are generated.

## Local run

```powershell
Copy-Item .env.example .env
npm.cmd install
npm.cmd start
```

In another terminal:

```powershell
npm.cmd run worker
```

Open `http://127.0.0.1:4185/`.

Before exposing the server publicly, set a strong `CENNOMO_WORKER_TOKEN` in `.env` and use the same value for the worker.

Also configure `CENNOMO_ADMIN_TOKEN` and `CENNOMO_ENCRYPTION_KEY`. If Gateway access should be private, set one or more comma-separated values in `CENNOMO_GATEWAY_API_KEYS`.

## Gateway

- `GET /api/v1/skills` discovers published tools.
- `POST /api/v1/skills/<name>/invoke` executes a selected healthy provider.
- `POST /mcp` supports MCP `initialize`, `tools/list` and `tools/call`.
- `GET /api/v1/calls/<id>` returns the persisted execution record.
- `POST /api/v1/approvals` creates a wallet-signature challenge for sensitive work.

When paid settlement is active, create an intent with `POST /api/v1/payment-intents`, transfer the exact lamports to the configured treasury, and supply the intent and signature in `X-Cennomo-Payment-Intent` and `X-Cennomo-Payment-Signature`.

Create a consistent SQLite backup with `npm run backup`. Backups are stored under `data/backups`; the newest 14 are retained.

## Public HTTPS deployment

1. Point the domain's A/AAAA record to the Linux server.
2. Copy `.env.example` to `.env` and set `DOMAIN`, `PUBLIC_ORIGIN`, `CENNOMO_WORKER_TOKEN`, and the Solana values.
3. Run `docker compose up -d --build`.
4. Check `https://<domain>/api/health`.

Caddy obtains and renews TLS certificates automatically. Persistent database and stream data are stored in Docker volumes.

## GitHub Pages frontend

GitHub Pages hosts only the static frontend; it cannot run the Node API, Worker, SQLite database or credential vault. The included Pages workflow publishes an allowlisted frontend bundle, so `.env`, the database and server files are never included in the Pages artifact.

After the backend has an HTTPS address, create a GitHub repository variable named `CENNOMO_API_ORIGIN` containing that origin, for example `https://api.example.com`. Add the Pages domain to `CENNOMO_WEB_ORIGINS` on the backend. Then enable GitHub Actions as the Pages source and configure the custom domain under repository Settings → Pages.

## Token launch

After the Pump.fun mint exists, configure:

```env
CENNOMO_TOKEN_MINT=<real mint address>
CENNOMO_BURN_AMOUNT=10000
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_URL=<production RPC endpoint>
PUMPFUN_URL=https://pump.fun/coin/<mint>
```

The server will then prepare a `BurnChecked` transaction for the connected wallet. A Tardigrade Agent is registered only after the server reads the confirmed transaction from Solana and verifies the wallet, mint and burn amount.

## Hugging Face Space

This repository is also a free Static Space. The Space serves the Tardumo frontend and connects it to the separately hosted API through the legacy-compatible `CENNOMO_API_ORIGIN` Space variable. The complete Node registry, worker, Docker deployment, tests and frontend source remain available in this same repository.

The public source repository intentionally excludes `.env`, API credentials, wallet secrets, SQLite files, browser profiles, generated streams, screenshots and build artifacts. Configure private runtime values through Hugging Face Space Secrets rather than committing them.

Running the registry and worker inside a Hugging Face Docker Space requires a paid Hugging Face plan. The current Static Space keeps the open-source frontend available without paid compute, while the production registry continues using persistent server volumes. Anyone can clone this repository and run the complete stack locally or on their own Docker host.

## License

Released under the [MIT License](LICENSE).
