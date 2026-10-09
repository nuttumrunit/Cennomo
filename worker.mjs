import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

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
const liveFrameIntervalMs = Math.max(750, Number(process.env.CENNOMO_LIVE_FRAME_INTERVAL_MS || 1_200));
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
    const stamp = Date.now();
    const filename = `frame-${stamp}-${process.pid}.png`;
    const target = resolve(folder, filename);
    const profile = resolve(folder, `profile-${stamp}-${process.pid}`);
    mkdirSync(profile, { recursive: true });
    const args = [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking', '--disable-extensions',
      '--disable-application-cache', '--disk-cache-size=1', '--media-cache-size=1',
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      `--user-data-dir=${profile}`, '--window-size=1280,720', '--virtual-time-budget=5000', `--screenshot=${target}`, targetUrl
    ];
    const child = spawn(chrome, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => child.kill(), 25_000);
    child.once('error', error => { clearTimeout(timer); try { rmSync(profile, { recursive: true, force: true }); } catch {} rejectCapture(error); });
    child.once('close', code => {
      clearTimeout(timer);
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
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

let liveBrowser = null;
let liveBrowserLaunch = null;
let liveSequence = 0;
const livePages = new Map();
const liveSessions = new Map();
const liveFrameState = new Map();
const liveFailures = new Map();
const liveBrowseState = new Map();
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const screencastOptions = { format: 'jpeg', quality: 64, maxWidth: 1120, maxHeight: 630, everyNthFrame: 1 };

async function ensureLiveBrowser() {
  if (liveBrowser?.connected) return liveBrowser;
  if (liveBrowserLaunch) return liveBrowserLaunch;
  liveBrowserLaunch = (async () => {
    livePages.clear();
    const browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: [
        '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars',
        '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        '--disable-extensions', '--disable-application-cache', '--disk-cache-size=1', '--media-cache-size=1'
      ]
    });
    liveBrowser = browser;
    browser.on('disconnected', () => { if (liveBrowser === browser) liveBrowser = null; livePages.clear(); liveSessions.clear(); liveFrameState.clear(); liveBrowseState.clear(); });
    const initial = (await browser.pages())[0];
    if (initial) await initial.close().catch(() => {});
    return browser;
  })();
  try { return await liveBrowserLaunch; }
  finally { liveBrowserLaunch = null; }
}

async function createLivePage(operator) {
  const browser = await ensureLiveBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1120, height: 630, deviceScaleFactor: 1 });
    page.setDefaultNavigationTimeout(30_000);
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    try { await page.goto(operator.target_url, { waitUntil: 'domcontentloaded', timeout: 15_000 }); }
    catch (error) {
      if (page.url() === 'about:blank') throw error;
      console.warn(`${operator.name}: navigation settled partially: ${error.message}`);
    }
    const session = await page.createCDPSession();
    livePages.set(operator.name, page);
    liveSessions.set(operator.name, session);
    liveFrameState.set(operator.name, { busy: false, suspended: false, lastPublished: 0 });
    liveBrowseState.set(operator.name, { visited: new Set([page.url().split('#')[0]]), bottomSeen: 0, round: 1, recheckAt: 0 });
    session.on('Page.screencastFrame', payload => {
      void session.send('Page.screencastFrameAck', { sessionId: payload.sessionId }).catch(() => {});
      const state = liveFrameState.get(operator.name);
      if (!state || state.busy || state.suspended || Date.now() - state.lastPublished < liveFrameIntervalMs) return;
      state.busy = true;
      state.lastPublished = Date.now();
      void publishLiveFrame(operator, payload.data)
        .catch(error => console.warn(`${operator.name}: screencast publish failed: ${error.message}`))
        .finally(() => { const current = liveFrameState.get(operator.name); if (current) current.busy = false; });
    });
    await session.send('Page.startScreencast', screencastOptions);
    return page;
  } catch (error) {
    await page.close().catch(() => {});
    livePages.delete(operator.name);
    liveSessions.delete(operator.name);
    liveFrameState.delete(operator.name);
    liveBrowseState.delete(operator.name);
    throw error;
  }
}

async function publishLiveFrame(operator, encodedFrame, telemetry = null) {
  const folder = resolve(streamRoot, operator.name);
  mkdirSync(folder, { recursive: true });
  const sequence = ++liveSequence;
  const filename = `live-${Date.now()}-${sequence}.jpg`;
  const target = resolve(folder, filename);
  const bytes = Buffer.from(encodedFrame, 'base64');
  writeFileSync(target, bytes);
  const proof = createHash('sha256').update(bytes).digest('hex');
  const oldFrames = readdirSync(folder).filter(file => /^live-\d+-\d+\.jpg$/.test(file)).sort().slice(0, -4);
  for (const oldFrame of oldFrames) {
    try { unlinkSync(resolve(folder, oldFrame)); } catch {}
  }
  await json(`${apiBase}/api/worker/operators/${encodeURIComponent(operator.name)}/frame`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamPath: `/streams/${encodeURIComponent(operator.name)}/${filename}`, proof, sequence, observedAt: new Date().toISOString(), telemetry })
  });
}

async function liveLoop() {
  for (;;) {
    try {
      const snapshot = await json(`${apiBase}/api/snapshot`);
      const operators = Array.isArray(snapshot.operators) ? snapshot.operators : [];
      const activeNames = new Set(operators.map(operator => operator.name));
      for (const [name, page] of livePages) {
        if (!activeNames.has(name)) { await page.close().catch(() => {}); livePages.delete(name); liveSessions.delete(name); liveFrameState.delete(name); liveBrowseState.delete(name); }
      }
      const missing = operators.filter(operator => !livePages.has(operator.name));
      await Promise.allSettled(missing.map(async operator => {
        try { await createLivePage(operator); liveFailures.set(operator.name, 0); }
        catch (error) { console.warn(`${operator.name}: live page unavailable: ${error.message}`); }
      }));
      for (const operator of operators) {
        const page = livePages.get(operator.name);
        if (!page || page.isClosed()) continue;
        try {
          await Promise.race([
            (async () => {
              await page.bringToFront();
              const session = liveSessions.get(operator.name);
              const frameState = liveFrameState.get(operator.name);
              if (frameState) frameState.suspended = true;
              if (session) {
                await session.send('Page.stopScreencast').catch(() => {});
                await session.send('Page.startScreencast', screencastOptions);
              }
              await page.evaluate(() => {
                if (window.__cennomoNaturalReader) return;
                const state = window.__cennomoNaturalReader = { last: Date.now(), paused: false, seen: new Set() };
                const tick = () => {
                  const root = document.scrollingElement || document.documentElement;
                  const limit = Math.max(0, root.scrollHeight - innerHeight);
                  const now = Date.now();
                  const elapsed = Math.min(1_500, Math.max(0, now - state.last));
                  state.last = now;
                  if (!state.paused && root.scrollTop < limit - 3) root.scrollTop = Math.min(limit, root.scrollTop + elapsed * .072);
                };
                state.timer = setInterval(tick, 100);
              });
              await wait(720);
              let navigateTo = '';
              const telemetry = await page.evaluate(() => {
                document.getElementById('__cennomo_operator_vision__')?.remove();
                const selectors = 'button,a[href],input,select,textarea,[role="button"],[role="link"],[role="tab"],h1,h2,h3,pre,table,[role="alert"],[role="dialog"],article';
                const labelFor = node => (node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('placeholder') || node.textContent || '').replace(/\s+/g, ' ').trim();
                const nodes = [...document.querySelectorAll(selectors)].filter(node => {
                  if (node.closest('#__cennomo_operator_vision__')) return false;
                  const rect = node.getBoundingClientRect();
                  const style = getComputedStyle(node);
                  const semantic = /^(H1|H2|H3|PRE|TABLE|ARTICLE)$/.test(node.tagName) || ['alert','dialog'].includes(node.getAttribute('role'));
                  if (labelFor(node).length < 2 || rect.width < 18 || rect.height < 12 || rect.width > innerWidth * (semantic ? .9 : .58) || rect.height > innerHeight * (semantic ? .55 : .36) || rect.bottom <= 8 || rect.top >= innerHeight - 8 || rect.right <= 8 || rect.left >= innerWidth - 8 || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || 1) <= 0) return false;
                  const x = Math.max(1, Math.min(innerWidth - 2, rect.left + rect.width / 2));
                  const y = Math.max(1, Math.min(innerHeight - 2, rect.top + rect.height / 2));
                  const hit = document.elementFromPoint(x, y);
                  return Boolean(hit && (node === hit || node.contains(hit) || hit.contains(node)));
                });
                const scrollRoot = document.scrollingElement || document.documentElement;
                const limit = Math.max(0, scrollRoot.scrollHeight - innerHeight);
                const progress = limit ? scrollRoot.scrollTop / limit : 1;
                const links = [...document.querySelectorAll('a[href]')].map(link => {
                  try {
                    const url = new URL(link.href, location.href);
                    if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return null;
                    url.hash = '';
                    if (url.href === location.href.split('#')[0] || /\.(?:pdf|zip|png|jpe?g|gif|svg|webp|mp4|mp3)$/i.test(url.pathname) || /\b(?:logout|signout|login|signin|auth)\b/i.test(url.pathname)) return null;
                    const label = labelFor(link);
                    return label.length >= 2 ? { url: url.href, label: label.slice(0, 80) } : null;
                  } catch { return null; }
                }).filter(Boolean);
                const reader = window.__cennomoNaturalReader;
                const unseen = nodes.filter(target => {
                  const key = `${target.tagName}:${labelFor(target).toLowerCase()}`;
                  return Boolean(reader && !reader.seen.has(key));
                });
                const selectedTargets = unseen.slice(0, 6);
                selectedTargets.forEach(target => reader.seen.add(`${target.tagName}:${labelFor(target).toLowerCase()}`));
                const targets = selectedTargets.map(target => {
                  const rect = target.getBoundingClientRect();
                  const label = labelFor(target).slice(0, 34);
                  return { tag: target.tagName.toLowerCase(), label, x: Math.max(0, rect.left) / innerWidth, y: Math.max(0, rect.top) / innerHeight, width: Math.min(innerWidth - Math.max(0, rect.left), rect.width) / innerWidth, height: Math.min(innerHeight - Math.max(0, rect.top), rect.height) / innerHeight };
                });
                return { actionableCount: nodes.length, direction: 1, progress, targets, atBottom: progress >= .995, links, currentUrl: location.href, pageTitle: document.title };
              });
              const browse = liveBrowseState.get(operator.name) || { visited: new Set(), bottomSeen: 0, round: 1, recheckAt: 0 };
              browse.visited.add(telemetry.currentUrl.split('#')[0]);
              telemetry.auditRound = browse.round;
              telemetry.phase = 'reading';
              if (telemetry.atBottom) browse.bottomSeen += 1; else browse.bottomSeen = 0;
              if (browse.bottomSeen >= 2) {
                const next = telemetry.links.find(link => !browse.visited.has(link.url));
                if (next) {
                  telemetry.phase = 'opening-next-page';
                  browse.visited.add(next.url);
                  browse.bottomSeen = 0;
                  navigateTo = next.url;
                } else {
                  telemetry.phase = 'awaiting-recheck';
                  await page.evaluate(() => { if (window.__cennomoNaturalReader) window.__cennomoNaturalReader.paused = true; });
                  if (!browse.recheckAt) browse.recheckAt = Date.now() + 5 * 60_000;
                }
              }
              if (browse.recheckAt && Date.now() >= browse.recheckAt) {
                browse.round += 1;
                browse.visited.clear();
                browse.bottomSeen = 0;
                browse.recheckAt = 0;
                navigateTo = operator.target_url;
                telemetry.phase = 'opening-next-page';
                telemetry.auditRound = browse.round;
              }
              liveBrowseState.set(operator.name, browse);
              delete telemetry.links;
              delete telemetry.atBottom;
              await wait(250);
              if (session && frameState) {
                const fallback = await Promise.race([
                  session.send('Page.captureScreenshot', { format: 'jpeg', quality: 64, fromSurface: true, captureBeyondViewport: false }),
                  wait(1_500).then(() => null)
                ]);
                if (fallback?.data) {
                  frameState.busy = true;
                  frameState.lastPublished = Date.now();
                  try { await publishLiveFrame(operator, fallback.data, telemetry); }
                  finally { frameState.busy = false; }
                }
              }
              if (navigateTo) await page.goto(navigateTo, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(error => console.warn(`${operator.name}: route navigation settled partially: ${error.message}`));
              if (frameState) frameState.suspended = false;
            })(),
            wait(25_000).then(() => { throw new Error('live page interaction timed out'); })
          ]);
          liveFailures.set(operator.name, 0);
        }
        catch (error) {
          const frameState = liveFrameState.get(operator.name);
          if (frameState) frameState.suspended = false;
          console.warn(`${operator.name}: live frame failed: ${error.message}`);
          const failures = (liveFailures.get(operator.name) || 0) + 1;
          liveFailures.set(operator.name, failures);
          if (failures >= 3) {
            await Promise.race([page.close().catch(() => {}), wait(2_000)]);
            livePages.delete(operator.name);
            liveSessions.delete(operator.name);
            liveFrameState.delete(operator.name);
            liveBrowseState.delete(operator.name);
            liveFailures.delete(operator.name);
          }
        }
        await wait(50);
      }
    } catch (error) {
      console.error(`live browser loop failed: ${error.message}`);
      if (liveBrowser) await liveBrowser.close().catch(() => {});
      liveBrowser = null;
      livePages.clear();
      liveBrowseState.clear();
    }
    await wait(liveFrameIntervalMs);
  }
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
      Promise.resolve(null),
      manifest?.probe ? runProbe(manifest.probe) : Promise.resolve(null),
      manifest?.credentialEnv && operator.credential_configured ? validateCredential(manifest, operator) : Promise.resolve(null)
    ]);
    const metadata = metadataResult.status === 'fulfilled'
      ? metadataResult.value
      : { httpStatus: null, title: '', contentType: '', latencyMs: Math.round(performance.now() - started), metadataError: metadataResult.reason?.message || 'metadata unavailable' };
    const frame = frameResult.status === 'fulfilled' ? (frameResult.value || {}) : {};
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
  for (let handled = 0; handled < 12; handled += 1) {
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
void liveLoop();
for (;;) {
  const started = Date.now();
  try { await cycle(); }
  catch (error) { console.error(`worker cycle failed: ${error.message}`); }
  const remaining = Math.max(1_000, intervalMs - (Date.now() - started));
  await new Promise(resolveWait => setTimeout(resolveWait, remaining));
}
