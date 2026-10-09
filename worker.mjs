import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
const liveFrameIntervalMs = Math.max(600, Number(process.env.CENNOMO_LIVE_FRAME_INTERVAL_MS || 850));
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
let liveScrollPump = null;
let liveScrollPumping = false;
let liveCaptureCursor = 0;
let liveSequence = 0;
const livePages = new Map();
const liveSessions = new Map();
const liveFrameState = new Map();
const liveFailures = new Map();
const liveBrowseState = new Map();
const liveVideoRecorders = new Map();
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const screencastOptions = { format: 'jpeg', quality: 64, maxWidth: 1120, maxHeight: 630, everyNthFrame: 1 };

async function stopDemandVideo(name) {
  const active = liveVideoRecorders.get(name);
  if (!active) return;
  liveVideoRecorders.delete(name);
  await active.recorder.stop().catch(error => console.warn(`${name}: video recorder stop failed: ${error.message}`));
  const state = liveFrameState.get(name), session = liveSessions.get(name);
  if (state) { state.video = false; state.suspended = false; }
  if (session) await session.send('Page.startScreencast', screencastOptions).catch(() => {});
  setTimeout(() => { try { unlinkSync(active.file); } catch {} }, 5_000).unref?.();
}

async function startDemandVideo(name, page, demand) {
  const current = liveVideoRecorders.get(name);
  if (current?.session === demand.session) return;
  if (current) await stopDemandVideo(name);
  const state = liveFrameState.get(name), session = liveSessions.get(name);
  if (!state || !session || page.isClosed()) return;
  state.video = true;
  state.suspended = true;
  await session.send('Page.stopScreencast').catch(() => {});
  const folder = resolve(streamRoot, name), file = resolve(folder, `video-${demand.session}.webm`);
  mkdirSync(folder, { recursive: true });
  try { unlinkSync(file); } catch {}
  try {
    const recorder = await page.screencast({ path: file, fps: Math.max(12, Math.min(24, Number(demand.fps || 20))), format: 'webm', quality: 36, overwrite: true });
    liveVideoRecorders.set(name, { session: demand.session, recorder, file });
    console.log(`${name}: live WebM video started`);
  } catch (error) {
    state.video = false;
    state.suspended = false;
    await session.send('Page.startScreencast', screencastOptions).catch(() => {});
    console.warn(`${name}: live WebM unavailable: ${error.message}`);
  }
}

let videoDemandBusy = false;
async function monitorVideoDemand() {
  if (videoDemandBusy) return;
  videoDemandBusy = true;
  try {
    for (const [name, page] of livePages) {
      const demandFile = resolve(streamRoot, name, 'video-demand.json');
      let demand = null;
      try { demand = JSON.parse(readFileSync(demandFile, 'utf8')); } catch {}
      const fresh = demand?.session && Date.now() - Number(demand.requestedAt || 0) < 4_000;
      if (fresh) await startDemandVideo(name, page, demand);
      else if (liveVideoRecorders.has(name)) await stopDemandVideo(name);
    }
  } finally { videoDemandBusy = false; }
}

async function installOperatorVision(page) {
  await page.evaluate(() => {
    if (window.__cennomoVisionUpdate && document.getElementById('__cennomo_operator_vision__')) return;
    document.getElementById('__cennomo_operator_vision__')?.remove();
    const root = document.createElement('div');
    root.id = '__cennomo_operator_vision__';
    root.innerHTML = '<div class="cv-box"><span></span></div><div class="cv-box"><span></span></div><div class="cv-pointer"><i></i><i></i><i></i><i></i><b></b><span>inspect</span></div>';
    const style = document.createElement('style');
    style.textContent = `#__cennomo_operator_vision__{position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.cv-box{position:fixed;display:none;border:1px solid rgba(0,255,71,.78);background:rgba(0,255,71,.025);box-shadow:0 0 14px rgba(0,255,71,.18),inset 0 0 8px rgba(0,255,71,.04);transition:transform .24s linear,width .24s linear,height .24s linear}.cv-box:before,.cv-box:after{content:"";position:absolute;width:9px;height:9px}.cv-box:before{left:-2px;top:-2px;border-left:2px solid #00ff47;border-top:2px solid #00ff47}.cv-box:after{right:-2px;bottom:-2px;border-right:2px solid #00ff47;border-bottom:2px solid #00ff47}.cv-box>span{position:absolute;left:-1px;bottom:calc(100% + 2px);max-width:230px;padding:3px 5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#00ff47;color:#001506;font:8px/1 ui-monospace,SFMono-Regular,Consolas,monospace}.cv-pointer{position:fixed;left:0;top:0;transform:translate(var(--px,50vw),var(--py,50vh));transition:transform .72s cubic-bezier(.2,.72,.16,1)}.cv-pointer b{display:block;width:15px;height:20px;background:#00ff47;clip-path:polygon(0 0,0 100%,28% 70%,48% 100%,64% 90%,45% 61%,82% 60%);filter:drop-shadow(0 0 5px rgba(0,255,71,.9))}.cv-pointer i{position:absolute;left:5px;top:8px;width:4px;height:4px;border-radius:50%;background:#00ff47;box-shadow:0 0 6px rgba(0,255,71,.7);transition:transform .72s cubic-bezier(.2,.72,.16,1);opacity:.42}.cv-pointer i:nth-child(1){transform:translate(-9px,13px);opacity:.38}.cv-pointer i:nth-child(2){transform:translate(-17px,23px);opacity:.3}.cv-pointer i:nth-child(3){transform:translate(-24px,31px);opacity:.22}.cv-pointer i:nth-child(4){transform:translate(-30px,38px);opacity:.14}.cv-pointer>span{position:absolute;left:12px;top:18px;padding:2px 4px;border:1px solid rgba(0,255,71,.38);background:rgba(0,8,2,.84);color:#00ff47;font:7px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.06em}`;
    root.append(style);
    (document.body || document.documentElement).append(root);
    const state = window.__cennomoVisionState = { tracked: [], pointerIndex: 0, switchedAt: 0 };
    const labelFor = node => (node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('placeholder') || node.textContent || '').replace(/\s+/g, ' ').trim();
    const usable = node => {
      if (!node?.isConnected || node.closest('#__cennomo_operator_vision__')) return false;
      const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
      const semantic = /^(H1|H2|H3|PRE|TABLE|ARTICLE)$/.test(node.tagName) || ['alert','dialog'].includes(node.getAttribute('role'));
      if (labelFor(node).length < 2 || rect.width < 22 || rect.height < 14 || rect.width > innerWidth * (semantic ? .92 : .65) || rect.height > innerHeight * (semantic ? .6 : .42) || rect.bottom < 18 || rect.top > innerHeight - 18 || rect.right < 18 || rect.left > innerWidth - 18 || css.display === 'none' || css.visibility === 'hidden' || Number(css.opacity || 1) <= 0) return false;
      const x = Math.max(1, Math.min(innerWidth - 2, rect.left + rect.width / 2));
      const y = Math.max(1, Math.min(innerHeight - 2, rect.top + rect.height / 2));
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit && (hit === node || node.contains(hit) || hit.contains(node)));
    };
    window.__cennomoVisionUpdate = () => {
      const selector = 'button,a[href],input,select,textarea,[role="button"],[role="link"],[role="tab"],h1,h2,h3,pre,table,[role="alert"],[role="dialog"],article';
      state.tracked = state.tracked.filter(usable);
      if (state.tracked.length < 2) {
        const candidates = [...document.querySelectorAll(selector)].filter(node => usable(node) && !state.tracked.includes(node));
        candidates.sort((a, b) => {
          const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
          const ac = Math.abs(ar.top + ar.height / 2 - innerHeight / 2), bc = Math.abs(br.top + br.height / 2 - innerHeight / 2);
          return ac - bc;
        });
        for (const node of candidates) {
          if (state.tracked.length >= 2) break;
          const rect = node.getBoundingClientRect();
          if (state.tracked.every(other => { const r = other.getBoundingClientRect(); return Math.hypot(rect.left-r.left, rect.top-r.top) > 90; })) state.tracked.push(node);
        }
      }
      const boxes = [...root.querySelectorAll('.cv-box')];
      boxes.forEach((box, index) => {
        const node = state.tracked[index];
        if (!node) { box.style.display = 'none'; return; }
        const rect = node.getBoundingClientRect();
        box.style.display = 'block';
        box.style.transform = `translate(${Math.max(1,rect.left)}px,${Math.max(1,rect.top)}px)`;
        box.style.width = `${Math.min(innerWidth-Math.max(1,rect.left),rect.width)}px`;
        box.style.height = `${Math.min(innerHeight-Math.max(1,rect.top),rect.height)}px`;
        box.firstElementChild.textContent = `${node.tagName.toLowerCase()} · ${labelFor(node).slice(0,42)}`;
      });
      const now = Date.now();
      if (state.tracked.length > 1 && now - state.switchedAt > 3600) { state.pointerIndex = (state.pointerIndex + 1) % state.tracked.length; state.switchedAt = now; }
      const focus = state.tracked[state.pointerIndex] || state.tracked[0], pointer = root.querySelector('.cv-pointer');
      if (focus) {
        const rect = focus.getBoundingClientRect();
        pointer.style.display = 'block';
        pointer.style.setProperty('--px', `${Math.max(8,Math.min(innerWidth-24,rect.left+rect.width*.58))}px`);
        pointer.style.setProperty('--py', `${Math.max(8,Math.min(innerHeight-28,rect.top+rect.height*.58))}px`);
      } else pointer.style.display = 'none';
    };
    window.__cennomoVisionUpdate();
  });
}

async function advanceLivePage(name, page, result) {
  const browse = liveBrowseState.get(name), frameState = liveFrameState.get(name);
  if (!browse || !frameState || browse.navigating || page.isClosed()) return;
  browse.navigating = true;
  const operator = frameState.operator;
  try {
    browse.visited.add(String(result.currentUrl || page.url()).split('#')[0]);
    let next = (result.links || []).find(link => !browse.visited.has(link.url))?.url;
    if (!next) {
      browse.round += 1;
      browse.visited.clear();
      next = operator.target_url;
    }
    browse.visited.add(next);
    if (!frameState.video) frameState.suspended = true;
    await page.goto(next, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(error => console.warn(`${name}: continuous route navigation settled partially: ${error.message}`));
    await installOperatorVision(page);
    await page.evaluate(() => { window.__cennomoNaturalReader = { paused: false, seen: new Set(), lastPump: Date.now() }; });
    browse.bottomSeen = 0;
    browse.recheckAt = 0;
  } finally {
    browse.navigating = false;
    if (!frameState.video) frameState.suspended = false;
    liveBrowseState.set(name, browse);
  }
}

function startLiveScrollPump() {
  if (liveScrollPump) clearInterval(liveScrollPump);
  liveScrollPump = setInterval(() => {
    if (liveScrollPumping) return;
    liveScrollPumping = true;
    const entries = [...livePages.entries()];
    (async () => {
      const scrollResults = await Promise.allSettled(entries.map(([, page]) => page.evaluate(() => {
        const state = window.__cennomoNaturalReader;
        if (!state || state.paused) return null;
        const root = document.scrollingElement || document.documentElement;
        const limit = Math.max(0, root.scrollHeight - innerHeight);
        const now = Date.now(), elapsed = Math.min(600, Math.max(0, now - (state.lastPump || now - 250)));
        state.lastPump = now;
        if (root.scrollTop < limit - 3) root.scrollTop = Math.min(limit, root.scrollTop + elapsed * .058);
        window.__cennomoVisionUpdate?.();
        if (root.scrollTop < limit - 3) return null;
        const links = [...document.querySelectorAll('a[href]')].map(link => {
          try {
            const url = new URL(link.href, location.href);
            url.hash = '';
            const label = (link.getAttribute('aria-label') || link.textContent || '').replace(/\s+/g, ' ').trim();
            if (url.origin !== location.origin || !/^https?:$/.test(url.protocol) || url.href === location.href.split('#')[0] || label.length < 2 || /\.(?:pdf|zip|png|jpe?g|gif|svg|webp|mp4|mp3)$/i.test(url.pathname) || /\b(?:logout|signout|login|signin|auth)\b/i.test(url.pathname)) return null;
            return { url: url.href, label: label.slice(0, 80) };
          } catch { return null; }
        }).filter(Boolean);
        return { currentUrl: location.href, links };
      })));
      scrollResults.forEach((result, index) => { if (result.status === 'fulfilled' && result.value) void advanceLivePage(entries[index][0], entries[index][1], result.value); });
      const captures = [];
      for (let offset = 0; offset < Math.min(3, entries.length); offset += 1) captures.push(entries[(liveCaptureCursor + offset) % entries.length]);
      liveCaptureCursor = entries.length ? (liveCaptureCursor + captures.length) % entries.length : 0;
      await Promise.allSettled(captures.map(async ([name]) => {
        const state = liveFrameState.get(name), session = liveSessions.get(name);
        if (!state || !session || state.video || state.busy || state.suspended || Date.now() - state.lastPublished < liveFrameIntervalMs) return;
        state.busy = true;
        state.lastPublished = Date.now();
        try {
          const frame = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 60, fromSurface: true, captureBeyondViewport: false });
          if (frame?.data && state.operator) await publishLiveFrame(state.operator, frame.data, state.telemetry || null);
        } catch (error) {
          console.warn(`${name}: active capture failed: ${error.message}`);
        } finally { state.busy = false; }
      }));
    })().finally(() => { liveScrollPumping = false; });
  }, 250);
  liveScrollPump.unref?.();
}

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
    startLiveScrollPump();
    browser.on('disconnected', () => { if (liveBrowser === browser) liveBrowser = null;if(liveScrollPump){clearInterval(liveScrollPump);liveScrollPump=null}liveVideoRecorders.clear();livePages.clear(); liveSessions.clear(); liveFrameState.clear(); liveBrowseState.clear(); });
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
    await installOperatorVision(page);
    const session = await page.createCDPSession();
    livePages.set(operator.name, page);
    liveSessions.set(operator.name, session);
    liveFrameState.set(operator.name, { busy: false, suspended: false, video: false, lastPublished: 0, operator });
    liveBrowseState.set(operator.name, { visited: new Set([page.url().split('#')[0]]), bottomSeen: 0, round: 1, recheckAt: 0 });
    session.on('Page.screencastFrame', payload => {
      void session.send('Page.screencastFrameAck', { sessionId: payload.sessionId }).catch(() => {});
      const state = liveFrameState.get(operator.name);
      if (!state || state.busy || state.suspended || Date.now() - state.lastPublished < liveFrameIntervalMs) return;
      state.busy = true;
      state.lastPublished = Date.now();
      void publishLiveFrame(operator, payload.data, state.telemetry || null)
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
        if (!activeNames.has(name)) { await stopDemandVideo(name); await page.close().catch(() => {}); livePages.delete(name); liveSessions.delete(name); liveFrameState.delete(name); liveBrowseState.delete(name); }
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
              if (session && !frameState?.video) {
                await session.send('Page.stopScreencast').catch(() => {});
                await session.send('Page.startScreencast', screencastOptions);
              }
              await page.evaluate(() => {
                if (window.__cennomoNaturalReader) return;
                window.__cennomoNaturalReader = { paused: false, seen: new Set(), lastPump: Date.now() };
              });
              await installOperatorVision(page);
              await wait(720);
              const telemetry = await page.evaluate(() => {
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
              if (frameState) frameState.telemetry = telemetry;
              liveBrowseState.set(operator.name, browse);
              delete telemetry.links;
              delete telemetry.atBottom;
              await wait(250);
              if (session && frameState && !frameState.video) {
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
            await stopDemandVideo(operator.name);
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
setInterval(() => void monitorVideoDemand().catch(error => console.warn(`video demand monitor failed: ${error.message}`)), 500).unref?.();
for (;;) {
  const started = Date.now();
  try { await cycle(); }
  catch (error) { console.error(`worker cycle failed: ${error.message}`); }
  const remaining = Math.max(1_000, intervalMs - (Date.now() - started));
  await new Promise(resolveWait => setTimeout(resolveWait, remaining));
}
