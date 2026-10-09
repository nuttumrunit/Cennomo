import http from 'node:http';
import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, extname, normalize, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createBurnCheckedInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getMint
} from '@solana/spl-token';

const root = resolve('.');
const dataDir = resolve(root, 'data');
mkdirSync(dataDir, { recursive: true });

function loadEnvFile() {
  const file = resolve(root, '.env');
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

const config = {
  port: Number(process.env.PORT || 4185),
  host: process.env.HOST || '0.0.0.0',
  origin: process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${process.env.PORT || 4185}`,
  cluster: process.env.SOLANA_CLUSTER || 'mainnet-beta',
  rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  tokenMint: process.env.CENNOMO_TOKEN_MINT || '',
  burnAmount: Number(process.env.CENNOMO_BURN_AMOUNT || 10000),
  pumpfunUrl: process.env.PUMPFUN_URL || 'https://pump.fun/',
  workerToken: process.env.CENNOMO_WORKER_TOKEN || '',
  adminToken: process.env.CENNOMO_ADMIN_TOKEN || '',
  encryptionKey: process.env.CENNOMO_ENCRYPTION_KEY || '',
  treasuryAddress: process.env.CENNOMO_TREASURY_ADDRESS || '',
  defaultCallFeeLamports: Math.max(0, Number(process.env.CENNOMO_DEFAULT_CALL_FEE_LAMPORTS || 0)),
  gatewayApiKeys: new Set(String(process.env.CENNOMO_GATEWAY_API_KEYS || '').split(',').map(value => value.trim()).filter(Boolean)),
  webOrigins: new Set(String(process.env.CENNOMO_WEB_ORIGINS || '').split(',').map(value => value.trim().replace(/\/$/, '')).filter(Boolean)),
  workerIntervalMs: Math.max(15_000, Number(process.env.CENNOMO_WORKER_INTERVAL_MS || 60_000))
};

const db = new DatabaseSync(resolve(dataDir, 'cennomo.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS operators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    territory TEXT NOT NULL,
    owner TEXT,
    target_url TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'offline',
    current_route TEXT,
    http_status INTEGER,
    page_title TEXT,
    content_type TEXT,
    latency_ms INTEGER,
    last_seen TEXT,
    last_success TEXT,
    stream_path TEXT,
    created_tx TEXT UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    state TEXT NOT NULL,
    success_rate REAL,
    last_verified TEXT,
    fee_lamports INTEGER,
    proof TEXT,
    UNIQUE(operator_id, name)
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    proof TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS burns (
    signature TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    mint TEXT NOT NULL,
    amount TEXT NOT NULL,
    operator_id INTEGER REFERENCES operators(id),
    confirmed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS burn_intents (
    id TEXT PRIMARY KEY,
    wallet TEXT NOT NULL,
    alias TEXT NOT NULL,
    territory TEXT NOT NULL,
    target_url TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS skill_calls (
    id TEXT PRIMARY KEY,
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    skill_name TEXT NOT NULL,
    status TEXT NOT NULL,
    input_json TEXT NOT NULL,
    output_json TEXT,
    proof TEXT,
    latency_ms INTEGER,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    encrypted_secret TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(operator_id, provider)
  );
  CREATE TABLE IF NOT EXISTS worker_nodes (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    started_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    not_before TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS settlement_ledger (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL UNIQUE REFERENCES skill_calls(id) ON DELETE CASCADE,
    gross_lamports INTEGER NOT NULL,
    owner_lamports INTEGER NOT NULL,
    execution_lamports INTEGER NOT NULL,
    treasury_lamports INTEGER NOT NULL,
    owner_wallet TEXT,
    payment_signature TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    settled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS payment_intents (
    id TEXT PRIMARY KEY,
    skill_name TEXT NOT NULL,
    wallet TEXT NOT NULL,
    amount_lamports INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    signature TEXT UNIQUE,
    used_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    capability TEXT NOT NULL,
    wallet TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    challenge TEXT NOT NULL,
    signature TEXT,
    status TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    confirmed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_operators_state ON operators(state);
  CREATE INDEX IF NOT EXISTS idx_skill_calls_created ON skill_calls(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_available ON jobs(state,not_before);
  CREATE INDEX IF NOT EXISTS idx_workers_seen ON worker_nodes(last_seen DESC);
`);

const now = () => new Date().toISOString();
const vaultKey = config.encryptionKey ? createHash('sha256').update(config.encryptionKey).digest() : null;
function encryptSecret(secret) {
  if (!vaultKey) throw Object.assign(new Error('credential vault is not configured'), { status: 503 });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', vaultKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ciphertext.toString('base64')}`;
}
function decryptSecret(payload) {
  if (!vaultKey) throw Object.assign(new Error('credential vault is not configured'), { status: 503 });
  const [iv, tag, ciphertext] = String(payload).split('.').map(value => Buffer.from(value, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', vaultKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
function sameSecret(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
const sources = JSON.parse(readFileSync(resolve(root, 'operator-sources.json'), 'utf8'));
const sourceByName = new Map(sources.map(source => [source.name, source]));
const sourceByTerritory = new Map(sources.map(source => [source.territory, source]));
const sourceFor = (name, territory) => sourceByName.get(name) || sourceByTerritory.get(territory);
function vaultCredential(operatorId, provider) {
  if (!provider) return null;
  return db.prepare("SELECT id,status,scopes_json,updated_at FROM credentials WHERE operator_id=? AND provider=? AND status='active'").get(operatorId, provider) || null;
}
const seedOperator = db.prepare(`
  INSERT INTO operators(name, territory, target_url, state, created_at)
  VALUES(?, ?, ?, 'offline', ?)
  ON CONFLICT(name) DO UPDATE SET territory=excluded.territory, target_url=excluded.target_url
`);
for (const source of sources) seedOperator.run(source.name, source.territory, source.targetUrl, now());

const clients = new Set();
function publish(type, payload) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const response of clients) response.write(message);
}

function sendJson(response, status, body) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store'
  });
  response.end(data);
}

async function readJson(request, limit = 32_768) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('request too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

function operatorRows() {
  const rows = db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM skills s WHERE s.operator_id=o.id AND s.state='verified') AS verified_skills
    FROM operators o
    ORDER BY CASE o.name
      WHEN 'jupiter-hand-04' THEN 0
      WHEN 'wormhole-hand-01' THEN 1
      WHEN 'aave-palm-12' THEN 2
      ELSE 3
    END, o.id
  `).all();
  return rows.map(operator => {
    const source = sourceFor(operator.name, operator.territory);
    const officialSource = sourceByName.get(operator.name);
    return {
      ...operator,
      mission: source?.mission || null,
      capabilities: source?.capabilities || [],
      official: Boolean(officialSource && officialSource.official !== false),
      cohort: officialSource?.cohort || 'community',
      credential_required: source?.credentialEnv || null,
      credential_configured: source?.credentialEnv ? Boolean(process.env[source.credentialEnv] || vaultCredential(operator.id, source.credentialEnv)) : true,
      credential_source: source?.credentialEnv
        ? process.env[source.credentialEnv] ? 'environment' : vaultCredential(operator.id, source.credentialEnv) ? 'encrypted_vault' : null
        : null
    };
  });
}

function snapshot() {
  const operators = operatorRows();
  const skills = db.prepare(`
    SELECT s.*, o.name AS operator_name, o.territory
    FROM skills s JOIN operators o ON o.id=s.operator_id
    ORDER BY s.last_verified DESC, s.id DESC
  `).all();
  const events = db.prepare(`
    SELECT e.*, o.name AS operator_name
    FROM events e LEFT JOIN operators o ON o.id=e.operator_id
    ORDER BY e.id DESC LIMIT 100
  `).all();
  const territories = db.prepare(`
    SELECT territory, COUNT(*) AS operator_count,
      SUM(CASE WHEN state NOT IN ('offline','dead') THEN 1 ELSE 0 END) AS active_count,
      MAX(state) AS state
    FROM operators GROUP BY territory ORDER BY active_count DESC, territory
  `).all();
  const burns = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(CAST(amount AS REAL)),0) AS total FROM burns').get();
  const calls = db.prepare("SELECT COUNT(*) AS count, SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded FROM skill_calls").get();
  const workers = db.prepare("SELECT COUNT(*) AS count FROM worker_nodes WHERE status='online' AND last_seen > ?").get(new Date(Date.now() - 120_000).toISOString());
  const settlements = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(gross_lamports),0) AS gross FROM settlement_ledger WHERE status IN ('recorded','settled')").get();
  const active = operators.filter(item => !['offline', 'dead'].includes(item.state)).length;
  return {
    generatedAt: now(),
    config: {
      cluster: config.cluster,
      tokenMint: config.tokenMint || null,
      burnAmount: config.burnAmount,
      pumpfunUrl: config.pumpfunUrl,
      deployEnabled: Boolean(config.tokenMint),
      gatewayAuthEnabled: config.gatewayApiKeys.size > 0,
      vaultEnabled: Boolean(vaultKey),
      treasuryAddress: config.treasuryAddress || null,
      settlementEnabled: Boolean(config.tokenMint && config.treasuryAddress && config.defaultCallFeeLamports > 0)
    },
    metrics: {
      operators: operators.length,
      officialOperators: operators.filter(item => item.official).length,
      activeOperators: active,
      verifiedSkills: skills.filter(item => item.state === 'verified').length,
      skills: skills.length,
      territories: territories.length,
      burns: Number(burns.count),
      tokensBurned: Number(burns.total),
      skillCalls: Number(calls.count),
      successfulSkillCalls: Number(calls.succeeded || 0)
      ,onlineWorkers: Number(workers.count),
      settlements: Number(settlements.count),
      grossCallLamports: Number(settlements.gross)
    },
    operators,
    skills,
    territories,
    events,
    treasury: {
      creatorRewardsSol: 0,
      incentivePoolSol: 0,
      address: config.treasuryAddress || null,
      source: config.tokenMint ? 'Pump.fun creator rewards' : null
    },
    readiness: {
      database: true,
      workerNetwork: Number(workers.count) > 0,
      credentialVault: Boolean(vaultKey),
      gatewayAuthentication: config.gatewayApiKeys.size > 0,
      tokenMint: Boolean(config.tokenMint),
      treasury: Boolean(config.treasuryAddress),
      paidSettlement: Boolean(config.tokenMint && config.treasuryAddress && config.defaultCallFeeLamports > 0),
      httpsOrigin: config.origin.startsWith('https://')
    }
  };
}

function isLocal(request) {
  const address = request.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address.endsWith('::ffff:127.0.0.1');
}

function workerAuthorized(request) {
  if (config.workerToken) return request.headers.authorization === `Bearer ${config.workerToken}`;
  return isLocal(request);
}

function adminAuthorized(request) {
  if (config.adminToken) return sameSecret(request.headers.authorization, `Bearer ${config.adminToken}`);
  return isLocal(request);
}

function gatewayAuthorized(request) {
  if (!config.gatewayApiKeys.size) return true;
  const bearer = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const key = String(request.headers['x-api-key'] || bearer);
  return [...config.gatewayApiKeys].some(candidate => sameSecret(key, candidate));
}

function registerWorker(body) {
  if (typeof body.workerId !== 'string' || !/^[a-zA-Z0-9._-]{3,80}$/.test(body.workerId)) throw Object.assign(new Error('valid workerId required'), { status: 400 });
  const timestamp = now();
  db.prepare(`
    INSERT INTO worker_nodes(id,status,capabilities_json,last_seen,started_at)
    VALUES(?,'online',?,?,?)
    ON CONFLICT(id) DO UPDATE SET status='online',capabilities_json=excluded.capabilities_json,last_seen=excluded.last_seen
  `).run(body.workerId, JSON.stringify(Array.isArray(body.capabilities) ? body.capabilities.slice(0, 20) : []), timestamp, body.startedAt || timestamp);
  return { ok: true, serverTime: timestamp, intervalMs: config.workerIntervalMs };
}

function scheduleMissingJobs(delayMs = 0) {
  const notBefore = new Date(Date.now() + delayMs).toISOString();
  const operators = db.prepare("SELECT id FROM operators WHERE state!='dead'").all();
  const active = db.prepare("SELECT 1 FROM jobs WHERE operator_id=? AND state IN ('queued','running') LIMIT 1");
  const insert = db.prepare("INSERT INTO jobs(id,operator_id,kind,state,not_before,created_at) VALUES(?,?,'observe','queued',?,?)");
  for (const operator of operators) if (!active.get(operator.id)) insert.run(randomUUID(), operator.id, notBefore, now());
}

function leaseJob(workerId) {
  const timestamp = now();
  db.prepare("UPDATE jobs SET state='queued',lease_owner=NULL,lease_expires=NULL WHERE state='running' AND lease_expires < ?").run(timestamp);
  const job = db.prepare("SELECT * FROM jobs WHERE state='queued' AND not_before<=? ORDER BY not_before,created_at LIMIT 1").get(timestamp);
  if (!job) return null;
  const leaseExpires = new Date(Date.now() + 90_000).toISOString();
  const changed = db.prepare("UPDATE jobs SET state='running',lease_owner=?,lease_expires=?,attempts=attempts+1 WHERE id=? AND state='queued'").run(workerId, leaseExpires, job.id);
  if (!changed.changes) return null;
  const operator = operatorRows().find(item => item.id === job.operator_id);
  return { ...job, state: 'running', lease_owner: workerId, lease_expires: leaseExpires, operator };
}

function finishJob(workerId, jobId, body) {
  const job = db.prepare("SELECT * FROM jobs WHERE id=? AND state='running' AND lease_owner=?").get(jobId, workerId);
  if (!job) throw Object.assign(new Error('leased job not found'), { status: 409 });
  const succeeded = body.status === 'succeeded';
  db.prepare("UPDATE jobs SET state=?,last_error=?,completed_at=?,lease_expires=NULL WHERE id=?")
    .run(succeeded ? 'completed' : 'failed', succeeded ? null : String(body.error || 'worker failed').slice(0, 500), now(), job.id);
  if (succeeded || job.attempts >= 3) {
    db.prepare("INSERT INTO jobs(id,operator_id,kind,state,not_before,created_at) VALUES(?,?,'observe','queued',?,?)")
      .run(randomUUID(), job.operator_id, new Date(Date.now() + config.workerIntervalMs).toISOString(), now());
  } else {
    db.prepare("INSERT INTO jobs(id,operator_id,kind,state,attempts,not_before,created_at) VALUES(?,?,'observe','queued',?,?,?)")
      .run(randomUUID(), job.operator_id, job.attempts, new Date(Date.now() + Math.min(60_000, 5_000 * 2 ** job.attempts)).toISOString(), now());
  }
  return { ok: true };
}

function validateAlias(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{2,23}$/.test(value);
}

function resolveTarget(territory) {
  return sources.find(item => item.territory === territory)?.targetUrl || '';
}

function inputSchema(name) {
  if (name === 'quote.fetch') return {
    type: 'object', additionalProperties: false,
    properties: {
      inputMint: { type: 'string', description: 'Solana input token mint' },
      outputMint: { type: 'string', description: 'Solana output token mint' },
      amount: { type: 'string', description: 'Raw token amount in base units' },
      slippageBps: { type: 'integer', minimum: 0, maximum: 1000 }
    }
  };
  if (name === 'repository.read') return {
    type: 'object', additionalProperties: false,
    properties: {
      owner: { type: 'string', description: 'GitHub repository owner' },
      repo: { type: 'string', description: 'GitHub repository name' }
    }
  };
  return { type: 'object', additionalProperties: false, properties: {} };
}

function gatewaySkills() {
  return db.prepare(`
    SELECT s.*, o.name AS operator_name, o.territory, o.state AS operator_state, o.latency_ms AS operator_latency_ms, o.owner AS operator_owner
    FROM skills s JOIN operators o ON o.id=s.operator_id
    WHERE s.state='verified' AND o.state NOT IN ('offline','dead','degrading')
    ORDER BY o.id, s.name
  `).all().map(skill => {
    const source = sourceFor(skill.operator_name, skill.territory);
    const advanced = (source?.capabilities || []).filter(name => name !== skill.name);
    return {
      name: skill.name,
      description: source?.mission || `Verified ${skill.territory} route`,
      inputSchema: inputSchema(skill.name),
      operator: skill.operator_name,
      territory: skill.territory,
      state: skill.state,
      operatorState: skill.operator_state,
      lastVerified: skill.last_verified,
      verificationProof: skill.proof,
      feeLamports: skill.fee_lamports ?? (config.defaultCallFeeLamports || null),
      billingState: config.tokenMint && config.treasuryAddress && (skill.fee_lamports ?? config.defaultCallFeeLamports) > 0 ? 'payment_required' : 'free_prelaunch',
      latencyMs: skill.operator_latency_ms,
      owner: skill.operator_owner,
      advancedCapabilities: advanced,
      credentialGate: source?.credentialEnv ? {
        environment: source.credentialEnv,
        configured: Boolean(process.env[source.credentialEnv] || vaultCredential(skill.operator_id, source.credentialEnv)),
        note: 'Required only for account-scoped or mutating capabilities.'
      } : null
    };
  });
}

function selectGatewaySkill(name) {
  const providers = gatewaySkills().filter(item => item.name === name);
  providers.sort((a, b) => {
    const stateScore = value => value.operatorState === 'verified' ? 3 : value.operatorState === 'learning' ? 2 : 1;
    return stateScore(b) - stateScore(a)
      || Number(b.lastVerified ? new Date(b.lastVerified) : 0) - Number(a.lastVerified ? new Date(a.lastVerified) : 0)
      || Number(a.latencyMs || 1e9) - Number(b.latencyMs || 1e9);
  });
  return providers[0] || null;
}

function gatewayCatalog() {
  return [...new Set(gatewaySkills().map(item => item.name))].map(name => {
    const selected = selectGatewaySkill(name);
    return { ...selected, providerCount: gatewaySkills().filter(item => item.name === name).length };
  });
}

function safeRepoPart(value, fallback) {
  const part = value == null || value === '' ? fallback : String(value);
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(part)) throw Object.assign(new Error('invalid GitHub owner or repository'), { status: 400 });
  return part;
}

function createApproval(body) {
  const operator = db.prepare('SELECT * FROM operators WHERE name=?').get(body.operator);
  if (!operator) throw Object.assign(new Error('operator not found'), { status: 404 });
  const source = sourceFor(operator.name, operator.territory);
  if (!source?.capabilities?.includes(body.capability)) throw Object.assign(new Error('capability is not declared by this Operator'), { status: 400 });
  let wallet;
  try { wallet = new PublicKey(body.wallet).toBase58(); }
  catch { throw Object.assign(new Error('invalid wallet address'), { status: 400 }); }
  const inputHash = createHash('sha256').update(JSON.stringify(body.input || {})).digest('hex');
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const challenge = `Cennomo authorization\nApproval: ${id}\nOperator: ${operator.name}\nCapability: ${body.capability}\nInput SHA-256: ${inputHash}\nExpires: ${expiresAt}`;
  db.prepare('INSERT INTO approvals(id,operator_id,capability,wallet,input_hash,challenge,status,expires_at,created_at) VALUES(?,?,?,?,?,?,\'pending\',?,?)')
    .run(id, operator.id, body.capability, wallet, inputHash, challenge, expiresAt, now());
  return { approvalId: id, operator: operator.name, capability: body.capability, wallet, inputHash, challenge, expiresAt };
}

function confirmApproval(id, body) {
  const approval = db.prepare("SELECT * FROM approvals WHERE id=? AND status='pending'").get(id);
  if (!approval || new Date(approval.expires_at).getTime() < Date.now()) throw Object.assign(new Error('approval is invalid or expired'), { status: 409 });
  let signature;
  try { signature = Buffer.from(body.signature, 'base64'); }
  catch { throw Object.assign(new Error('signature must be base64'), { status: 400 }); }
  if (signature.length !== 64) throw Object.assign(new Error('invalid Ed25519 signature length'), { status: 400 });
  const rawKey = Buffer.from(new PublicKey(approval.wallet).toBytes());
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]);
  const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  if (!verifySignature(null, Buffer.from(approval.challenge, 'utf8'), publicKey, signature)) throw Object.assign(new Error('wallet signature verification failed'), { status: 409 });
  db.prepare("UPDATE approvals SET signature=?,status='approved',confirmed_at=? WHERE id=? AND status='pending'").run(body.signature, now(), id);
  return { approvalId: id, status: 'approved', operatorId: approval.operator_id, capability: approval.capability, wallet: approval.wallet, inputHash: approval.input_hash, expiresAt: approval.expires_at };
}

function executionRequest(skill, input) {
  const source = sourceFor(skill.operator, skill.territory);
  const probe = source?.probe;
  if (!probe || probe.name !== skill.name) throw Object.assign(new Error('verified execution manifest is unavailable'), { status: 503 });
  let url = probe.url;
  if (skill.name === 'quote.fetch') {
    const defaults = new URL(probe.url).searchParams;
    const mint = value => {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw Object.assign(new Error('invalid Solana token mint'), { status: 400 });
      return value;
    };
    const amount = String(input.amount || defaults.get('amount'));
    const slippage = Number(input.slippageBps ?? defaults.get('slippageBps'));
    if (!/^\d{1,30}$/.test(amount) || BigInt(amount) <= 0n) throw Object.assign(new Error('amount must be positive base units'), { status: 400 });
    if (!Number.isInteger(slippage) || slippage < 0 || slippage > 1000) throw Object.assign(new Error('slippageBps must be 0-1000'), { status: 400 });
    const params = new URLSearchParams({
      inputMint: mint(input.inputMint || defaults.get('inputMint')),
      outputMint: mint(input.outputMint || defaults.get('outputMint')),
      amount,
      slippageBps: String(slippage)
    });
    url = `https://lite-api.jup.ag/swap/v1/quote?${params}`;
  }
  if (skill.name === 'repository.read') {
    const owner = safeRepoPart(input.owner, 'octocat');
    const repo = safeRepoPart(input.repo, 'Hello-World');
    url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }
  return { ...probe, url };
}

async function executeGatewaySkill(skill, input = {}, payment = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('input must be a JSON object'), { status: 400 });
  const manifest = executionRequest(skill, input);
  const started = performance.now();
  const callId = randomUUID();
  const createdAt = now();
  const row = db.prepare('SELECT id,operator_id FROM skills WHERE name=? AND operator_id=(SELECT id FROM operators WHERE name=?) AND state=\'verified\'').get(skill.name, skill.operator);
  if (!row) throw Object.assign(new Error('skill is no longer verified'), { status: 409 });
  db.prepare('INSERT INTO skill_calls(id,skill_id,operator_id,skill_name,status,input_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(callId, row.id, row.operator_id, skill.name, 'running', JSON.stringify(input), createdAt);
  try {
    const response = await fetch(manifest.url, {
      method: manifest.method || 'GET', redirect: 'follow', signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: manifest.responseType === 'html' ? 'text/html,application/xhtml+xml' : 'application/json',
        'User-Agent': 'CennomoGateway/1.0 (+https://cennomo.network)',
        ...(manifest.body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(manifest.body ? { body: JSON.stringify(manifest.body) } : {})
    });
    const raw = await response.text();
    if (!response.ok) throw Object.assign(new Error(`upstream returned HTTP ${response.status}`), { status: 502 });
    let result;
    if (manifest.responseType === 'html') {
      const lower = raw.toLowerCase();
      const missing = (manifest.requiredPatterns || []).filter(pattern => !lower.includes(String(pattern).toLowerCase()));
      if (missing.length) throw Object.assign(new Error(`upstream verification failed: missing ${missing.join(', ')}`), { status: 502 });
      const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) || '';
      result = { url: response.url, httpStatus: response.status, title, contentType: response.headers.get('content-type') || '', bytes: Buffer.byteLength(raw) };
    } else {
      try { result = JSON.parse(raw); }
      catch { throw Object.assign(new Error('upstream did not return JSON'), { status: 502 }); }
      const missing = (manifest.requiredKeys || []).filter(key => result?.[key] == null);
      if (missing.length) throw Object.assign(new Error(`upstream verification failed: missing ${missing.join(', ')}`), { status: 502 });
    }
    const proof = createHash('sha256').update(raw).digest('hex');
    const completedAt = now();
    const latencyMs = Math.round(performance.now() - started);
    recordSettlement(callId, skill, payment);
    const envelope = { callId, status: 'succeeded', skill: skill.name, operator: skill.operator, result, proof, observedAt: completedAt, latencyMs, billing: payment ? { status: 'recorded', grossLamports: payment.intent.amount_lamports, signature: payment.signature } : { status: 'free_prelaunch', grossLamports: 0 } };
    db.prepare('UPDATE skill_calls SET status=?,output_json=?,proof=?,latency_ms=?,completed_at=? WHERE id=?')
      .run('succeeded', JSON.stringify(result), proof, latencyMs, completedAt, callId);
    db.prepare('INSERT INTO events(operator_id,type,message,proof,created_at) VALUES(?,?,?,?,?)')
      .run(row.operator_id, 'skill.called', `${skill.name} executed through Gateway`, proof, completedAt);
    publish('snapshot', { reason: 'skill.called', callId, skill: skill.name });
    return envelope;
  } catch (error) {
    db.prepare('UPDATE skill_calls SET status=?,output_json=?,latency_ms=?,completed_at=? WHERE id=?')
      .run('failed', JSON.stringify({ error: error.message }), Math.round(performance.now() - started), now(), callId);
    error.callId = callId;
    throw error;
  }
}

const gatewayWindows = new Map();
function gatewayRateLimit(request) {
  const key = String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const time = Date.now();
  const window = gatewayWindows.get(key);
  if (!window || time - window.started > 60_000) return gatewayWindows.set(key, { started: time, count: 1 });
  window.count += 1;
  if (window.count > 60) throw Object.assign(new Error('Gateway rate limit exceeded'), { status: 429 });
}

async function mcp(request, response) {
  if (!gatewayAuthorized(request)) throw Object.assign(new Error('Gateway API key required'), { status: 401 });
  gatewayRateLimit(request);
  const message = await readJson(request, 128_000);
  const id = message.id ?? null;
  const reply = result => sendJson(response, 200, { jsonrpc: '2.0', id, result });
  if (message.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'cennomo-gateway', version: '1.0.0' } });
  if (message.method === 'notifications/initialized') return response.writeHead(202).end();
  if (message.method === 'ping') return reply({});
  if (message.method === 'tools/list') return reply({ tools: gatewayCatalog().map(skill => ({ name: skill.name, description: skill.description, inputSchema: skill.inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } })) });
  if (message.method === 'tools/call') {
    const skill = selectGatewaySkill(message.params?.name);
    if (!skill) return sendJson(response, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: 'verified tool not found' } });
    try {
      const args = { ...(message.params?.arguments || {}) };
      const paymentData = args._payment;
      delete args._payment;
      const payment = skill.billingState === 'payment_required' ? await verifyPayment(paymentData?.intentId, paymentData?.signature, skill.name) : null;
      const result = await executeGatewaySkill(skill, args, payment);
      return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
    } catch (error) {
      return reply({ content: [{ type: 'text', text: JSON.stringify({ error: error.message, callId: error.callId || null }) }], isError: true });
    }
  }
  return sendJson(response, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
}

async function tokenProgramFor(connection, mint) {
  const account = await connection.getAccountInfo(mint, 'confirmed');
  if (!account) throw new Error('token mint not found');
  if (account.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  if (account.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  throw new Error('unsupported token program');
}

function createPaymentIntent(body) {
  if (!config.tokenMint || !config.treasuryAddress || config.defaultCallFeeLamports <= 0) throw Object.assign(new Error('paid settlement is not active'), { status: 503 });
  const skill = selectGatewaySkill(body.skill);
  if (!skill) throw Object.assign(new Error('verified skill not found'), { status: 404 });
  let wallet;
  try { wallet = new PublicKey(body.wallet).toBase58(); }
  catch { throw Object.assign(new Error('invalid wallet address'), { status: 400 }); }
  const id = randomUUID();
  const amount = Number(skill.feeLamports || config.defaultCallFeeLamports);
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  db.prepare('INSERT INTO payment_intents(id,skill_name,wallet,amount_lamports,expires_at,created_at) VALUES(?,?,?,?,?,?)')
    .run(id, skill.name, wallet, amount, expiresAt, now());
  return { intentId: id, skill: skill.name, wallet, treasury: config.treasuryAddress, amountLamports: amount, expiresAt, chain: `solana:${config.cluster}` };
}

async function verifyPayment(intentId, signature, skillName) {
  if (!intentId || !signature) throw Object.assign(new Error('payment intent and signature are required'), { status: 402 });
  const intent = db.prepare('SELECT * FROM payment_intents WHERE id=?').get(intentId);
  if (!intent || intent.used_at || intent.skill_name !== skillName || new Date(intent.expires_at).getTime() < Date.now()) throw Object.assign(new Error('payment intent is invalid, expired or used'), { status: 409 });
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const transaction = await connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!transaction || transaction.meta?.err) throw Object.assign(new Error('confirmed payment transaction not found'), { status: 409 });
  const instructions = [
    ...transaction.transaction.message.instructions,
    ...(transaction.meta?.innerInstructions || []).flatMap(group => group.instructions)
  ];
  const valid = instructions.some(instruction => {
    const parsed = instruction?.parsed;
    const info = parsed?.info || {};
    return parsed?.type === 'transfer'
      && info.source === intent.wallet
      && info.destination === config.treasuryAddress
      && Number(info.lamports || 0) >= intent.amount_lamports;
  });
  if (!valid) throw Object.assign(new Error('transaction does not contain the required treasury payment'), { status: 409 });
  return { intent, signature };
}

function recordSettlement(callId, skill, payment) {
  if (!payment) return;
  const gross = Number(payment.intent.amount_lamports);
  const owner = Math.floor(gross * 0.7);
  const execution = Math.floor(gross * 0.2);
  const treasury = gross - owner - execution;
  const changed = db.prepare('UPDATE payment_intents SET signature=?,used_at=? WHERE id=? AND used_at IS NULL').run(payment.signature, now(), payment.intent.id);
  if (!changed.changes) throw Object.assign(new Error('payment intent was already consumed'), { status: 409 });
  db.prepare(`
    INSERT INTO settlement_ledger(id,call_id,gross_lamports,owner_lamports,execution_lamports,treasury_lamports,owner_wallet,payment_signature,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(randomUUID(), callId, gross, owner, execution, treasury, skill.owner || null, payment.signature, 'recorded', now());
}

async function prepareBurn(body) {
  if (!config.tokenMint) throw Object.assign(new Error('token mint is not configured'), { status: 503 });
  if (!validateAlias(body.alias)) throw Object.assign(new Error('alias must be 3-24 lowercase letters, numbers or hyphens'), { status: 400 });
  const targetUrl = resolveTarget(body.territory);
  if (!targetUrl) throw Object.assign(new Error('unsupported territory'), { status: 400 });
  let owner;
  try { owner = new PublicKey(body.wallet); }
  catch { throw Object.assign(new Error('invalid wallet address'), { status: 400 }); }
  if (db.prepare('SELECT 1 FROM operators WHERE name=?').get(body.alias)) throw Object.assign(new Error('operator alias already exists'), { status: 409 });

  const connection = new Connection(config.rpcUrl, 'confirmed');
  const mint = new PublicKey(config.tokenMint);
  const programId = await tokenProgramFor(connection, mint);
  const mintInfo = await getMint(connection, mint, 'confirmed', programId);
  const rawAmount = BigInt(Math.round(config.burnAmount * (10 ** mintInfo.decimals)));
  const tokenAccount = await getAssociatedTokenAddress(mint, owner, false, programId);
  const accountInfo = await getAccount(connection, tokenAccount, 'confirmed', programId);
  if (accountInfo.amount < rawAmount) throw Object.assign(new Error('insufficient token balance'), { status: 409 });

  const latest = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({ feePayer: owner, recentBlockhash: latest.blockhash });
  transaction.add(createBurnCheckedInstruction(tokenAccount, mint, owner, rawAmount, mintInfo.decimals, [], programId));
  const intentId = randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  db.prepare('INSERT INTO burn_intents(id,wallet,alias,territory,target_url,expires_at) VALUES(?,?,?,?,?,?)')
    .run(intentId, owner.toBase58(), body.alias, body.territory, targetUrl, expiresAt);
  db.prepare('DELETE FROM burn_intents WHERE used_at IS NULL AND expires_at < ?').run(now());
  return {
    intentId,
    transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    chain: `solana:${config.cluster}`,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    mint: mint.toBase58(),
    amount: config.burnAmount,
    decimals: mintInfo.decimals,
    targetUrl
  };
}

async function verifyBurn(signature, wallet) {
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const transaction = await connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!transaction || transaction.meta?.err) throw Object.assign(new Error('confirmed burn transaction not found'), { status: 409 });
  const instructions = [
    ...transaction.transaction.message.instructions,
    ...(transaction.meta?.innerInstructions || []).flatMap(group => group.instructions)
  ];
  const valid = instructions.some(instruction => {
    const parsed = instruction?.parsed;
    if (!parsed || !['burn', 'burnChecked'].includes(parsed.type)) return false;
    const info = parsed.info || {};
    const uiAmount = Number(info.tokenAmount?.uiAmountString ?? info.tokenAmount?.uiAmount ?? NaN);
    return info.authority === wallet && info.mint === config.tokenMint && uiAmount >= config.burnAmount;
  });
  if (!valid) throw Object.assign(new Error('transaction does not contain the required CENNOMO burn'), { status: 409 });
  return transaction;
}

async function api(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    const stale = new Date(Date.now() - 120_000).toISOString();
    const workers = Number(db.prepare("SELECT COUNT(*) AS count FROM worker_nodes WHERE status='online' AND last_seen>?").get(stale).count);
    return sendJson(response, 200, { ok: true, time: now(), database: true, workers, tokenConfigured: Boolean(config.tokenMint), vaultConfigured: Boolean(vaultKey), settlementConfigured: Boolean(config.tokenMint && config.treasuryAddress && config.defaultCallFeeLamports > 0) });
  }
  if (request.method === 'GET' && url.pathname === '/api/readiness') return sendJson(response, 200, snapshot().readiness);
  if (request.method === 'GET' && url.pathname === '/api/snapshot') return sendJson(response, 200, snapshot());
  const videoMatch = url.pathname.match(/^\/api\/operators\/([^/]+)\/video\.webm$/);
  if (request.method === 'GET' && videoMatch) {
    const name = decodeURIComponent(videoMatch[1]);
    const operator = db.prepare('SELECT id,name,state FROM operators WHERE name=?').get(name);
    if (!operator) throw Object.assign(new Error('operator not found'), { status: 404 });
    const session = randomUUID(), folder = resolve(root, 'streams', name), demandFile = resolve(folder, 'video-demand.json'), videoFile = resolve(folder, `video-${session}.webm`);
    mkdirSync(folder, { recursive: true });
    const touchDemand = () => writeFileSync(demandFile, JSON.stringify({ session, requestedAt: Date.now(), fps: 20 }), 'utf8');
    touchDemand();
    const heartbeat = setInterval(touchDemand, 1_000);
    let closed = false, pumping = false, offset = 0, pumpTimer = null;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (pumpTimer) clearInterval(pumpTimer);
      try { const demand = JSON.parse(readFileSync(demandFile, 'utf8')); if (demand.session === session) unlinkSync(demandFile); } catch {}
    };
    response.once('close', close);
    const started = Date.now();
    while (!closed && (!existsSync(videoFile) || statSync(videoFile).size < 512)) {
      if (Date.now() - started > 15_000) { close(); throw Object.assign(new Error('video encoder did not become ready'), { status: 503 }); }
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    if (closed) return;
    response.writeHead(200, {
      'Content-Type': 'video/webm', 'Cache-Control': 'no-store, no-transform', 'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', 'Accept-Ranges': 'none'
    });
    const pump = async () => {
      if (closed || pumping || !existsSync(videoFile)) return;
      pumping = true;
      try {
        const size = statSync(videoFile).size;
        if (size > offset) {
          const end = size - 1;
          for await (const chunk of createReadStream(videoFile, { start: offset, end })) {
            if (closed) break;
            if (!response.write(chunk)) await once(response, 'drain');
          }
          offset = end + 1;
        }
      } catch (error) { if (!closed) console.warn(`${name}: video tail failed: ${error.message}`); }
      finally { pumping = false; }
    };
    pumpTimer = setInterval(pump, 80);
    await pump();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/skills') {
    return sendJson(response, 200, { object: 'list', data: gatewayCatalog(), mcpEndpoint: `${config.origin}/mcp` });
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/payment-intents') {
    if (!gatewayAuthorized(request)) throw Object.assign(new Error('Gateway API key required'), { status: 401 });
    return sendJson(response, 201, createPaymentIntent(await readJson(request)));
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/settlements') {
    const totals = db.prepare("SELECT COUNT(*) AS calls,COALESCE(SUM(gross_lamports),0) AS gross,COALESCE(SUM(owner_lamports),0) AS owners,COALESCE(SUM(execution_lamports),0) AS execution,COALESCE(SUM(treasury_lamports),0) AS treasury FROM settlement_ledger WHERE status IN ('recorded','settled')").get();
    return sendJson(response, 200, { enabled: Boolean(config.tokenMint && config.treasuryAddress && config.defaultCallFeeLamports > 0), currency: 'lamports', split: { owner: 70, execution: 20, treasury: 10 }, totals });
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/approvals') {
    if (!gatewayAuthorized(request)) throw Object.assign(new Error('Gateway API key required'), { status: 401 });
    gatewayRateLimit(request);
    return sendJson(response, 201, createApproval(await readJson(request, 64_000)));
  }
  const approvalConfirmMatch = url.pathname.match(/^\/api\/v1\/approvals\/([0-9a-f-]+)\/confirm$/i);
  if (request.method === 'POST' && approvalConfirmMatch) {
    if (!gatewayAuthorized(request)) throw Object.assign(new Error('Gateway API key required'), { status: 401 });
    return sendJson(response, 200, confirmApproval(approvalConfirmMatch[1], await readJson(request, 16_384)));
  }
  const approvalMatch = url.pathname.match(/^\/api\/v1\/approvals\/([0-9a-f-]+)$/i);
  if (request.method === 'GET' && approvalMatch) {
    const approval = db.prepare('SELECT id,capability,wallet,input_hash,status,expires_at,created_at,confirmed_at FROM approvals WHERE id=?').get(approvalMatch[1]);
    if (!approval) throw Object.assign(new Error('approval not found'), { status: 404 });
    return sendJson(response, 200, approval);
  }
  const providersMatch = url.pathname.match(/^\/api\/v1\/skills\/([^/]+)\/providers$/);
  if (request.method === 'GET' && providersMatch) {
    const name = decodeURIComponent(providersMatch[1]);
    const providers = gatewaySkills().filter(item => item.name === name);
    if (!providers.length) throw Object.assign(new Error('verified skill not found'), { status: 404 });
    return sendJson(response, 200, { skill: name, selected: selectGatewaySkill(name)?.operator || null, providers });
  }
  const gatewaySkillMatch = url.pathname.match(/^\/api\/v1\/skills\/([^/]+)$/);
  if (request.method === 'GET' && gatewaySkillMatch) {
    const skill = selectGatewaySkill(decodeURIComponent(gatewaySkillMatch[1]));
    if (!skill) throw Object.assign(new Error('verified skill not found'), { status: 404 });
    return sendJson(response, 200, skill);
  }
  const invokeMatch = url.pathname.match(/^\/api\/v1\/skills\/([^/]+)\/invoke$/);
  if (request.method === 'POST' && invokeMatch) {
    if (!gatewayAuthorized(request)) throw Object.assign(new Error('Gateway API key required'), { status: 401 });
    gatewayRateLimit(request);
    const skill = selectGatewaySkill(decodeURIComponent(invokeMatch[1]));
    if (!skill) throw Object.assign(new Error('verified skill not found'), { status: 404 });
    const input = await readJson(request, 128_000);
    const payment = skill.billingState === 'payment_required'
      ? await verifyPayment(request.headers['x-cennomo-payment-intent'], request.headers['x-cennomo-payment-signature'], skill.name)
      : null;
    return sendJson(response, 200, await executeGatewaySkill(skill, input, payment));
  }
  const callMatch = url.pathname.match(/^\/api\/v1\/calls\/([0-9a-f-]+)$/i);
  if (request.method === 'GET' && callMatch) {
    const call = db.prepare('SELECT id,skill_name,status,input_json,output_json,proof,latency_ms,created_at,completed_at FROM skill_calls WHERE id=?').get(callMatch[1]);
    if (!call) throw Object.assign(new Error('call not found'), { status: 404 });
    return sendJson(response, 200, { ...call, input: JSON.parse(call.input_json), output: call.output_json ? JSON.parse(call.output_json) : null, input_json: undefined, output_json: undefined });
  }
  if (request.method === 'POST' && url.pathname === '/api/worker/heartbeat') {
    if (!workerAuthorized(request)) throw Object.assign(new Error('worker authorization required'), { status: 401 });
    return sendJson(response, 200, registerWorker(await readJson(request)));
  }
  if (request.method === 'POST' && url.pathname === '/api/worker/jobs/lease') {
    if (!workerAuthorized(request)) throw Object.assign(new Error('worker authorization required'), { status: 401 });
    const body = await readJson(request);
    registerWorker(body);
    scheduleMissingJobs();
    return sendJson(response, 200, { job: leaseJob(body.workerId) });
  }
  const completeJobMatch = url.pathname.match(/^\/api\/worker\/jobs\/([0-9a-f-]+)\/complete$/i);
  if (request.method === 'POST' && completeJobMatch) {
    if (!workerAuthorized(request)) throw Object.assign(new Error('worker authorization required'), { status: 401 });
    const body = await readJson(request);
    return sendJson(response, 200, finishJob(body.workerId, completeJobMatch[1], body));
  }
  const workerCredentialMatch = url.pathname.match(/^\/api\/worker\/operators\/([^/]+)\/credential$/);
  if (request.method === 'GET' && workerCredentialMatch) {
    if (!workerAuthorized(request)) throw Object.assign(new Error('worker authorization required'), { status: 401 });
    const operator = db.prepare('SELECT * FROM operators WHERE name=?').get(decodeURIComponent(workerCredentialMatch[1]));
    if (!operator) throw Object.assign(new Error('operator not found'), { status: 404 });
    const source = sourceFor(operator.name, operator.territory);
    if (!source?.credentialEnv) throw Object.assign(new Error('operator has no credential gate'), { status: 404 });
    if (process.env[source.credentialEnv]) return sendJson(response, 200, { provider: source.credentialEnv, source: 'environment', secret: process.env[source.credentialEnv] });
    const record = db.prepare("SELECT * FROM credentials WHERE operator_id=? AND provider=? AND status='active'").get(operator.id, source.credentialEnv);
    if (!record) throw Object.assign(new Error('credential not configured'), { status: 404 });
    return sendJson(response, 200, { provider: record.provider, source: 'encrypted_vault', secret: decryptSecret(record.encrypted_secret), scopes: JSON.parse(record.scopes_json) });
  }
  const adminCredentialMatch = url.pathname.match(/^\/api\/admin\/operators\/([^/]+)\/credential$/);
  if (adminCredentialMatch && ['POST','DELETE'].includes(request.method)) {
    if (!adminAuthorized(request)) throw Object.assign(new Error('administrator authorization required'), { status: 401 });
    const operator = db.prepare('SELECT * FROM operators WHERE name=?').get(decodeURIComponent(adminCredentialMatch[1]));
    if (!operator) throw Object.assign(new Error('operator not found'), { status: 404 });
    const source = sourceFor(operator.name, operator.territory);
    if (!source?.credentialEnv) throw Object.assign(new Error('operator has no credential gate'), { status: 400 });
    if (request.method === 'DELETE') {
      db.prepare("UPDATE credentials SET status='revoked',updated_at=? WHERE operator_id=? AND provider=?").run(now(), operator.id, source.credentialEnv);
      db.prepare("UPDATE operators SET state='learning' WHERE id=?").run(operator.id);
      publish('snapshot', { reason: 'credential.revoked', operator: operator.name });
      return sendJson(response, 200, { ok: true, status: 'revoked' });
    }
    const body = await readJson(request, 16_384);
    if (typeof body.secret !== 'string' || body.secret.length < 8 || body.secret.length > 8192) throw Object.assign(new Error('credential must be 8-8192 characters'), { status: 400 });
    const timestamp = now();
    db.prepare(`
      INSERT INTO credentials(id,operator_id,provider,encrypted_secret,scopes_json,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'active',?,?)
      ON CONFLICT(operator_id,provider) DO UPDATE SET encrypted_secret=excluded.encrypted_secret,scopes_json=excluded.scopes_json,status='active',updated_at=excluded.updated_at
    `).run(randomUUID(), operator.id, source.credentialEnv, encryptSecret(body.secret), JSON.stringify(Array.isArray(body.scopes) ? body.scopes.slice(0, 50) : []), timestamp, timestamp);
    db.prepare('INSERT INTO events(operator_id,type,message,created_at) VALUES(?,?,?,?)').run(operator.id, 'credential.configured', `${source.credentialEnv} stored in encrypted vault`, timestamp);
    publish('snapshot', { reason: 'credential.configured', operator: operator.name });
    return sendJson(response, 201, { ok: true, provider: source.credentialEnv, status: 'active', secret: '[REDACTED]' });
  }
  if (request.method === 'GET' && url.pathname === '/api/events/stream') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ time: now() })}\n\n`);
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/operators/prepare-burn') {
    const result = await prepareBurn(await readJson(request));
    return sendJson(response, 200, result);
  }
  if (request.method === 'POST' && url.pathname === '/api/operators/confirm-burn') {
    const body = await readJson(request);
    if (!config.tokenMint) throw Object.assign(new Error('token mint is not configured'), { status: 503 });
    if (typeof body.signature !== 'string' || typeof body.wallet !== 'string' || typeof body.intentId !== 'string') throw Object.assign(new Error('intent, signature and wallet are required'), { status: 400 });
    const intent = db.prepare('SELECT * FROM burn_intents WHERE id=?').get(body.intentId);
    if (!intent || intent.used_at) throw Object.assign(new Error('burn intent is invalid or already used'), { status: 409 });
    if (intent.wallet !== body.wallet) throw Object.assign(new Error('wallet does not match burn intent'), { status: 409 });
    if (new Date(intent.expires_at).getTime() < Date.now()) throw Object.assign(new Error('burn intent expired'), { status: 409 });
    await verifyBurn(body.signature, intent.wallet);
    db.exec('BEGIN IMMEDIATE');
    let inserted;
    try {
      inserted = db.prepare(`
        INSERT INTO operators(name, territory, owner, target_url, state, created_tx, created_at)
        VALUES(?, ?, ?, ?, 'queued', ?, ?)
      `).run(intent.alias, intent.territory, intent.wallet, intent.target_url, body.signature, now());
      db.prepare('INSERT INTO burns(signature,wallet,mint,amount,operator_id,confirmed_at) VALUES(?,?,?,?,?,?)')
        .run(body.signature, intent.wallet, config.tokenMint, String(config.burnAmount), inserted.lastInsertRowid, now());
      db.prepare('UPDATE burn_intents SET used_at=? WHERE id=? AND used_at IS NULL').run(now(), intent.id);
      db.prepare('INSERT INTO events(operator_id,type,message,proof,created_at) VALUES(?,?,?,?,?)')
        .run(inserted.lastInsertRowid, 'operator.created', 'burn verified; operator queued', body.signature, now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    publish('snapshot', { reason: 'operator.created' });
    return sendJson(response, 201, { ok: true, operatorId: Number(inserted.lastInsertRowid) });
  }

  const frameMatch = url.pathname.match(/^\/api\/worker\/operators\/([^/]+)\/frame$/);
  if (request.method === 'POST' && frameMatch) {
    if (!workerAuthorized(request)) throw Object.assign(new Error('worker authorization required'), { status: 401 });
    const name = decodeURIComponent(frameMatch[1]);
    const operator = db.prepare('SELECT * FROM operators WHERE name=?').get(name);
    if (!operator) throw Object.assign(new Error('operator not found'), { status: 404 });
    const body = await readJson(request, 4096);
    const expectedPrefix = `/streams/${encodeURIComponent(name)}/`;
    if (typeof body.streamPath !== 'string' || !body.streamPath.startsWith(expectedPrefix)) throw Object.assign(new Error('invalid stream path'), { status: 400 });
    if (!/^[a-f0-9]{64}$/i.test(String(body.proof || ''))) throw Object.assign(new Error('invalid frame proof'), { status: 400 });
    const observedAt = body.observedAt || now();
    const sequence = Math.max(1, Number(body.sequence || 1));
    const number = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : 0;
    const telemetry = body.telemetry && typeof body.telemetry === 'object' ? {
      actionableCount: Math.max(0, Math.min(999, Number(body.telemetry.actionableCount || 0))),
      direction: Number(body.telemetry.direction) < 0 ? -1 : 1,
      progress: number(body.telemetry.progress),
      phase: ['reading', 'opening-next-page', 'awaiting-recheck'].includes(body.telemetry.phase) ? body.telemetry.phase : 'reading',
      currentUrl: String(body.telemetry.currentUrl || '').slice(0, 1000),
      pageTitle: String(body.telemetry.pageTitle || '').replace(/[\r\n\t]+/g, ' ').slice(0, 160),
      auditRound: Math.max(1, Math.min(9999, Number(body.telemetry.auditRound || 1))),
      targets: (Array.isArray(body.telemetry.targets) ? body.telemetry.targets : []).slice(0, 6).map(target => ({
        tag: String(target?.tag || 'element').replace(/[^a-z0-9-]/gi, '').slice(0, 18),
        label: String(target?.label || 'interactive element').replace(/[\r\n\t]+/g, ' ').slice(0, 48),
        x: number(target?.x), y: number(target?.y), width: number(target?.width), height: number(target?.height)
      }))
    } : null;
    db.prepare('UPDATE operators SET stream_path=?,last_seen=?,last_success=? WHERE id=?').run(body.streamPath, observedAt, observedAt, operator.id);
    publish('frame', { operator: name, operatorId: operator.id, streamPath: body.streamPath, proof: body.proof, sequence, observedAt, telemetry });
    return sendJson(response, 200, { ok: true, sequence });
  }

  const reportMatch = url.pathname.match(/^\/api\/operators\/([^/]+)\/report$/);
  if (request.method === 'POST' && reportMatch) {
    if (!workerAuthorized(request)) throw Object.assign(new Error('worker authorization required'), { status: 401 });
    const name = decodeURIComponent(reportMatch[1]);
    const body = await readJson(request, 64_000);
    const operator = db.prepare('SELECT * FROM operators WHERE name=?').get(name);
    if (!operator) throw Object.assign(new Error('operator not found'), { status: 404 });
    const verifiedBefore = Number(db.prepare("SELECT COUNT(*) AS count FROM skills WHERE operator_id=? AND state='verified'").get(operator.id).count);
    const failuresBefore = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM events
      WHERE operator_id=? AND type='skill.probe_failed'
        AND id > COALESCE((SELECT MAX(id) FROM events WHERE operator_id=? AND type='skill.verified'),0)
    `).get(operator.id, operator.id).count);
    const successful = Boolean(((body.streamPath && body.proof) || body.observationProof || (body.skill?.name && body.skill?.proof)) && !body.error);
    const requestedState = ['discovering','learning','verified','degrading','repairing'].includes(body.state) ? body.state : 'discovering';
    const transientProbeFailure = Boolean(body.probeError && verifiedBefore && failuresBefore < 2);
    const state = successful ? (transientProbeFailure ? 'verified' : requestedState) : 'degrading';
    const observedAt = body.observedAt || now();
    db.prepare(`
      UPDATE operators SET state=?, current_route=?, http_status=?, page_title=?, content_type=?, latency_ms=?,
        last_seen=?, last_success=CASE WHEN ? THEN ? ELSE last_success END, stream_path=COALESCE(?,stream_path) WHERE id=?
    `).run(state, body.skill?.name || operator.current_route, body.httpStatus || null, body.title || null, body.contentType || null, body.latencyMs || null,
      observedAt, successful ? 1 : 0, observedAt, body.streamPath || null, operator.id);
    const hasFrame = Boolean(body.streamPath && body.proof);
    const message = successful
      ? `${hasFrame ? 'browser frame captured' : 'public interface observed'}${body.httpStatus ? ` with HTTP ${body.httpStatus}` : ''}`
      : `browser observation failed${body.error ? `: ${String(body.error).slice(0, 180)}` : ''}`;
    const proof = body.proof || body.observationProof || null;
    db.prepare('INSERT INTO events(operator_id,type,message,proof,created_at) VALUES(?,?,?,?,?)')
      .run(operator.id, successful ? (hasFrame ? 'browser.observed' : 'interface.observed') : 'browser.failed', message, proof, observedAt);
    if (successful && body.skill?.name && body.skill?.proof) {
      db.prepare(`
        INSERT INTO skills(operator_id,name,state,success_rate,last_verified,fee_lamports,proof)
        VALUES(?,?,'verified',100,?,NULL,?)
        ON CONFLICT(operator_id,name) DO UPDATE SET state='verified', success_rate=100, last_verified=excluded.last_verified, proof=excluded.proof
      `).run(operator.id, body.skill.name, observedAt, body.skill.proof);
      db.prepare('INSERT INTO events(operator_id,type,message,proof,created_at) VALUES(?,?,?,?,?)')
        .run(operator.id, 'skill.verified', `${body.skill.name} passed a real public API probe`, body.skill.proof, observedAt);
    } else if (body.probeError) {
      db.prepare('INSERT INTO events(operator_id,type,message,proof,created_at) VALUES(?,?,?,?,?)')
        .run(operator.id, 'skill.probe_failed', String(body.probeError).slice(0, 220), null, observedAt);
      if (failuresBefore + 1 >= 3) {
        db.prepare("UPDATE skills SET state='degrading' WHERE operator_id=? AND state='verified'").run(operator.id);
        db.prepare("UPDATE operators SET state='degrading' WHERE id=?").run(operator.id);
      }
    }
    if (body.credentialVerified?.provider && body.credentialVerified?.proof) {
      db.prepare('INSERT INTO events(operator_id,type,message,proof,created_at) VALUES(?,?,?,?,?)')
        .run(operator.id, 'credential.verified', `${String(body.credentialVerified.provider).slice(0, 80)} accepted by provider`, body.credentialVerified.proof, observedAt);
    } else if (body.credentialError) {
      db.prepare('INSERT INTO events(operator_id,type,message,created_at) VALUES(?,?,?,?)')
        .run(operator.id, 'credential.rejected', String(body.credentialError).slice(0, 220), observedAt);
    }
    db.prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 2000)').run();
    publish('snapshot', { reason: successful ? 'browser.observed' : 'browser.failed', operator: name });
    return sendJson(response, 200, { ok: true, state });
  }
  return false;
}

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.ico', 'image/x-icon']
]);

function staticFile(request, response, url) {
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const path = resolve(root, `.${normalize(requested).split(sep).join('/')}`);
  if (!path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile()) {
    sendJson(response, 404, { error: 'not found' });
    return;
  }
  const headers = {
    'Content-Type': mime.get(extname(path).toLowerCase()) || 'application/octet-stream',
    'Content-Length': statSync(path).size,
    'Cache-Control': /\.(?:js|css|html)$/.test(path) ? 'no-cache' : 'public, max-age=60',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://api.mainnet-beta.solana.com https://api.devnet.solana.com; frame-ancestors 'none'; base-uri 'self'"
  };
  response.writeHead(200, headers);
  if (request.method === 'HEAD') return response.end();
  createReadStream(path).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, config.origin);
    const requestOrigin = String(request.headers.origin || '').replace(/\/$/, '');
    if (requestOrigin && config.webOrigins.has(requestOrigin)) {
      response.setHeader('Access-Control-Allow-Origin', requestOrigin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-API-Key,X-Cennomo-Payment-Intent,X-Cennomo-Payment-Signature');
    }
    if (request.method === 'OPTIONS' && (url.pathname.startsWith('/api/') || url.pathname === '/mcp')) return response.writeHead(requestOrigin && config.webOrigins.has(requestOrigin) ? 204 : 403).end();
    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'MCP accepts POST requests' });
      await mcp(request, response);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const handled = await api(request, response, url);
      if (handled === false) sendJson(response, 404, { error: 'API route not found' });
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) return sendJson(response, 405, { error: 'method not allowed' });
    staticFile(request, response, url);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendJson(response, error.status || 500, { error: error.message || 'internal error' });
    else response.end();
  }
});

const heartbeat = setInterval(() => {
  for (const response of clients) response.write(`: keepalive ${Date.now()}\n\n`);
}, 20_000);
scheduleMissingJobs();
const scheduler = setInterval(() => {
  scheduleMissingJobs();
  db.prepare("UPDATE worker_nodes SET status='offline' WHERE last_seen < ?").run(new Date(Date.now() - 120_000).toISOString());
  db.prepare("DELETE FROM jobs WHERE state IN ('completed','failed') AND completed_at < ?").run(new Date(Date.now() - 7 * 86_400_000).toISOString());
}, 15_000);

server.listen(config.port, config.host, () => {
  console.log(`Cennomo API and web server: http://${config.host}:${config.port}`);
  console.log(`Solana cluster: ${config.cluster}; token mint: ${config.tokenMint || 'TBA'}`);
});

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(scheduler);
  for (const response of clients) response.end();
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
