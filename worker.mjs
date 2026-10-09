import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
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

const apiBase = process.env.CENNOMO_API_URL || `http://127.0.0.1:${process.env.PORT || 4185}`;
const workerToken = process.env.CENNOMO_WORKER_TOKEN || '';
const intervalMs = Math.max(15_000, Number(process.env.CENNOMO_WORKER_INTERVAL_MS || 60_000));
const workerId = process.env.CENNOMO_WORKER_ID || `${process.env.COMPUTERNAME || 'worker'}-${process.pid}`;
const workerStartedAt = new Date().toISOString();
const chrome = process.env.CHROME_PATH || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'google-chrome');
const streamRoot = resolve(root, 'streams');
mkdirSync(streamRoot, { recursive: true });
const manifests = JSON.parse(readFileSync(resolve(root, 'operator-sources.json'), 'utf8'));
const manifestByName = new Map(manifests.map(manifest => [manifest.name, manifest]));
const manifestByTerritory = new Map(manifests.map(manifest => [manifest.territory, manifest]));

const headers = workerToken ? { Authorization: `Bearer ${workerToken}` } : {};

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function pageMetadata(html, response) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) || '';
  return {
    title,
    contentType: response.headers.get('content-type') || '',
    httpStatus: response.status
  };
}

async function inspectUrl(url) {
  const started = performance.now();
  let response;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch(url, {
        redirect: 'follow', signal: AbortSignal.timeout(20_000),
        headers: { 'User-Agent': 'CennomoOperator/1.0 (+https://cennomo.network)' }
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise(resolveWait => setTimeout(resolveWait, 500));
    }
  }
  if (!response) throw lastError;
  const html = await response.text();
  return {
    ...pageMetadata(html.slice(0, 1_000_000), response),
    latencyMs: Math.round(performance.now() - started),
    observationProof: createHash('sha256').update(html).digest('hex')
  };
}

async function runProbe(probe) {
  let response;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(probe.url, {
        method: probe.method || 'GET',
        redirect: 'follow', signal: AbortSignal.timeout(20_000),
        headers: {
          Accept: probe.responseType === 'html' ? 'text/html,application/xhtml+xml' : 'application/json',
          'User-Agent': 'CennomoOperator/1.0 (+https://cennomo.network)',
          ...(probe.body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(probe.body ? { body: JSON.stringify(probe.body) } : {})
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolveWait => setTimeout(resolveWait, 500 * (attempt + 1)));
    }
  }
  if (!response) throw lastError;
  const raw = await response.text();
  if (!response.ok) throw new Error(`${probe.name} returned HTTP ${response.status}`);
  if (probe.responseType === 'html') {
    const lower = raw.toLowerCase();
    const missing = (probe.requiredPatterns || []).filter(pattern => !lower.includes(String(pattern).toLowerCase()));
    if (missing.length) throw new Error(`${probe.name} missing ${missing.join(', ')}`);
    return { name: probe.name, proof: createHash('sha256').update(raw).digest('hex') };
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error(`${probe.name} did not return JSON`); }
  const missing = (probe.requiredKeys || []).filter(key => value?.[key] == null);
  if (missing.length) throw new Error(`${probe.name} missing ${missing.join(', ')}`);
  return { name: probe.name, proof: createHash('sha256').update(raw).digest('hex') };
}

async function workerCredential(name) {
  return json(`${apiBase}/api/worker/operators/${encodeURIComponent(name)}/credential`);
}

function commandVersion(executable) {
  return new Promise((resolveVersion, rejectVersion) => {
    if (!existsSync(executable)) return rejectVersion(new Error('Blender executable does not exist'));
    const child = spawn(executable, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    const errors = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    const timer = setTimeout(() => child.kill(), 15_000);
    child.once('error', rejectVersion);
    child.once('close', code => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString('utf8');
      if (code !== 0 || !/Blender/i.test(output)) return rejectVersion(new Error(Buffer.concat(errors).toString('utf8').slice(0, 180) || 'Blender validation failed'));
      resolveVersion(output.split(/\r?\n/)[0].slice(0, 120));
    });
  });
}

async function validateCredential(manifest, operator) {
  if (!manifest?.credentialEnv) return null;
  const credential = await workerCredential(operator.name);
  const secret = credential.secret;
  if (manifest.territory === 'blender') {
    const version = await commandVersion(secret);
    return { provider: manifest.credentialEnv, proof: createHash('sha256').update(version).digest('hex') };
  }
  let url;
  let method = 'GET';
  let body;
  const requestHeaders = { Accept: 'application/json', 'User-Agent': 'CennomoOperator/1.0 (+https://cennomo.network)' };
  if (manifest.territory === 'notion') {
    url = 'https://api.notion.com/v1/users/me';
    requestHeaders.Authorization = `Bearer ${secret}`;
    requestHeaders['Notion-Version'] = '2025-09-03';
  } else if (manifest.territory === 'stripe') {
    url = 'https://api.stripe.com/v1/account';
    requestHeaders.Authorization = `Bearer ${secret}`;
  } else if (manifest.territory === 'linear') {
    url = 'https://api.linear.app/graphql'; method = 'POST'; body = JSON.stringify({ query: 'query CennomoCredentialCheck { viewer { id } }' });
    requestHeaders.Authorization = secret;
    requestHeaders['Content-Type'] = 'application/json';
  } else if (manifest.territory === 'figma') {
    url = 'https://api.figma.com/v1/me';
    requestHeaders['X-Figma-Token'] = secret;
  } else if (manifest.territory === 'telegram') {
    url = `https://api.telegram.org/bot${encodeURIComponent(secret)}/getMe`;
  } else if (manifest.territory === 'shopify') {
    let parsed;
    try { parsed = JSON.parse(secret); } catch { throw new Error('Shopify credential must be JSON with shop and token'); }
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(parsed.shop || '') || typeof parsed.token !== 'string') throw new Error('Shopify credential requires a valid shop and token');
    url = `https://${parsed.shop}/admin/api/2025-10/shop.json`;
    requestHeaders['X-Shopify-Access-Token'] = parsed.token;
  } else {
    throw new Error(`no credential validator for ${manifest.territory}`);
  }
  const response = await fetch(url, { method, body, headers: requestHeaders, signal: AbortSignal.timeout(20_000) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${manifest.credentialEnv} rejected with HTTP ${response.status}`);
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error(`${manifest.credentialEnv} returned invalid JSON`); }
  if (value?.ok === false || value?.errors) throw new Error(`${manifest.credentialEnv} validation failed`);
  return { provider: manifest.credentialEnv, proof: createHash('sha256').update(raw).digest('hex') };
}

function screenshot(name, targetUrl) {
  return new Promise((resolveCapture, rejectCapture) => {
    const folder = resolve(streamRoot, name);
    mkdirSync(folder, { recursive: true });
    const filename = `frame-${Date.now()}-${process.pid}.png`;
    const target = resolve(folder, filename);
    const args = [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking', '--disable-extensions',
      '--disable-application-cache', '--disk-cache-size=1', '--media-cache-size=1',
      '--window-size=1280,720', '--virtual-time-budget=5000', `--screenshot=${target}`, targetUrl
    ];
    const child = spawn(chrome, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => child.kill(), 25_000);
    child.once('error', error => { clearTimeout(timer); rejectCapture(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (!existsSync(target)) return rejectCapture(new Error(`Chrome exited ${code} without a frame`));
      const bytes = readFileSync(target);
      const oldFrames = readdirSync(folder).filter(file => /^frame-\d+-\d+\.png$/.test(file)).sort().slice(0, -3);
      for (const oldFrame of oldFrames) {
        try { unlinkSync(resolve(folder, oldFrame)); } catch {}
      }
      resolveCapture({
        streamPath: `/streams/${encodeURIComponent(name)}/${filename}`,
        proof: createHash('sha256').update(bytes).digest('hex')
      });
    });
  });
}

async function report(name, body) {
  return json(`${apiBase}/api/operators/${encodeURIComponent(name)}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, observedAt: new Date().toISOString() })
  });
}

async function runOperator(operator) {
  const started = performance.now();
  try {
    const manifest = manifestByName.get(operator.name) || manifestByTerritory.get(operator.territory);
    const [metadataResult, frameResult, probeResult, credentialResult] = await Promise.allSettled([
      inspectUrl(operator.target_url),
      screenshot(operator.name, operator.target_url),
      manifest?.probe ? runProbe(manifest.probe) : Promise.resolve(null),
      manifest?.credentialEnv && operator.credential_configured ? validateCredential(manifest, operator) : Promise.resolve(null)
    ]);
    const metadata = metadataResult.status === 'fulfilled'
      ? metadataResult.value
      : { httpStatus: null, title: '', contentType: '', latencyMs: Math.round(performance.now() - started), metadataError: metadataResult.reason?.message || 'metadata unavailable' };
    const frame = frameResult.status === 'fulfilled' ? frameResult.value : {};
    if (frameResult.status === 'rejected') console.warn(`${operator.name}: frame unavailable: ${frameResult.reason?.message || 'capture failed'}`);
    const skill = probeResult.status === 'fulfilled' ? probeResult.value : null;
    const probeError = probeResult.status === 'rejected' ? probeResult.reason?.message || 'probe failed' : '';
    if (!frame.proof && !skill?.proof && !metadata.observationProof) throw frameResult.reason || probeResult.reason || new Error('no evidence produced');
    const credentialVerified = credentialResult.status === 'fulfilled' ? credentialResult.value : null;
    const credentialError = credentialResult.status === 'rejected' ? credentialResult.reason?.message || 'credential validation failed' : '';
    const credentialReady = !manifest?.credentialEnv || Boolean(credentialVerified);
    const state = manifest?.credentialEnv && !credentialReady ? 'learning' : skill ? 'verified' : 'discovering';
    await report(operator.name, { ...metadata, ...frame, state, skill, probeError, credentialVerified, credentialError, frameError: frameResult.status === 'rejected' ? frameResult.reason?.message : '' });
    const evidence = skill
      ? `skill ${skill.name} ${skill.proof.slice(0, 12)}`
      : frame.proof
        ? `frame ${frame.proof.slice(0, 12)}`
        : `interface ${metadata.observationProof.slice(0, 12)}`;
    console.log(`${operator.name}: HTTP ${metadata.httpStatus || 'n/a'}, ${metadata.latencyMs} ms, ${evidence}`);
    return true;
  } catch (error) {
    await report(operator.name, {
      error: error.message,
      latencyMs: Math.round(performance.now() - started),
      httpStatus: null
    }).catch(reportError => console.error(`${operator.name}: report failed`, reportError.message));
    console.error(`${operator.name}: ${error.message}`);
    return false;
  }
}

async function cycle() {
  await json(`${apiBase}/api/worker/heartbeat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId, startedAt: workerStartedAt, capabilities: ['browser.capture','http.probe','skill.verify'] })
  });
  for (let handled = 0; handled < 100; handled += 1) {
    const leased = await json(`${apiBase}/api/worker/jobs/lease`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId, startedAt: workerStartedAt, capabilities: ['browser.capture','http.probe','skill.verify'] })
    });
    if (!leased.job) break;
    const succeeded = await runOperator(leased.job.operator);
    await json(`${apiBase}/api/worker/jobs/${leased.job.id}/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId, status: succeeded ? 'succeeded' : 'failed', error: succeeded ? null : 'operator cycle failed' })
    });
  }
}

console.log(`Cennomo worker connected to ${apiBase}`);
console.log(`Chrome: ${chrome}`);
console.log(`Worker ID: ${workerId}`);
for (;;) {
  const started = Date.now();
  try { await cycle(); }
  catch (error) { console.error(`worker cycle failed: ${error.message}`); }
  const remaining = Math.max(1_000, intervalMs - (Date.now() - started));
  await new Promise(resolveWait => setTimeout(resolveWait, remaining));
}
