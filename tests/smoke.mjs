import puppeteer from 'puppeteer-core';

const base = process.env.CENNOMO_TEST_URL || 'http://127.0.0.1:4185/';
const executablePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await puppeteer.launch({ headless: true, executablePath, args: ['--disable-gpu', '--no-first-run'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const failures = [];
const checks = [];
page.on('pageerror', error => failures.push(`pageerror: ${error.message}`));
page.on('console', message => { if (message.type() === 'error') failures.push(`console: ${message.text()}`); });

async function check(name, condition) {
  const result = typeof condition === 'function' ? await condition() : condition;
  if (!result) failures.push(name); else checks.push(name);
}

await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
await page.waitForFunction(() => document.documentElement.dataset.api === 'online', { timeout: 15_000 });
await check('API health', () => page.evaluate(() => fetch('/api/health').then(r => r.ok)));
await check('Live route active', () => page.$eval('#route-live', node => node.classList.contains('active')));
await check('Real Tardigrade Agent selected', () => page.$eval('#operatorName', node => node.textContent !== 'no tardigrade registered'));
await check('Live frame URL', () => page.$eval('.crawl-browser-frame', node => Boolean(node.getAttribute('src'))));

for (const route of ['operators', 'skills', 'gateway', 'territories', 'treasury', 'deploy', 'manual', 'live']) {
  await page.click(`[data-route="${route}"]`);
  await page.waitForFunction(id => document.querySelector(`#route-${id}`)?.classList.contains('active'), {}, route);
  await check(`${route} route visible`, () => page.$eval(`#route-${route}`, node => getComputedStyle(node).display !== 'none'));
}

await page.click('[data-route="operators"]');
await check('Tardigrade Agent cards rendered', () => page.$$eval('#monitorGrid .operator-monitor', nodes => nodes.length === 12));
await check('Official crypto tardigrades lead first row', () => page.$$eval('#monitorGrid .operator-monitor header span', nodes => nodes.slice(0, 3).map(node => node.textContent).every((value, index) => value.includes(['jupiter-tardigrade-01','wormhole-tardigrade-02','aave-tardigrade-03'][index]))));
await page.waitForFunction(() => [...document.querySelectorAll('#monitorGrid .operator-live-frame')].slice(0, 3).every(image => image.naturalWidth > 0));
await check('First-row live frames render', () => page.$$eval('#monitorGrid .operator-live-frame', nodes => nodes.slice(0, 3).every(image => image.naturalWidth > 0)));
await page.click('#monitorGrid .operator-monitor');
await page.waitForSelector('#liveRoom.open');
await check('Live room has real operator', () => page.$eval('#roomName', node => node.textContent.length > 2));
await page.click('#closeLive');
await check('Live room closes', () => page.$eval('#liveRoom', node => !node.classList.contains('open')));
await page.click('[data-wall-filter="degrading"]');
await check('Tardigrade filter responds', () => page.$$eval('#monitorGrid .operator-monitor', nodes => nodes.every(node => node.dataset.state === 'degrading')));
await page.click('[data-wall-filter="all"]');

await page.click('[data-route="skills"]');
await check('Skills page has registry result', () => page.$eval('#skillRows', node => node.children.length > 0));
await page.type('#skillSearch', 'no-such-real-skill');
await check('Skill search has empty state', () => page.$eval('#skillRows', node => node.textContent.includes('No callable routes match')));

await page.click('[data-route="gateway"]');
await check('Gateway publishes 12 tools', () => page.$$eval('#gatewayRows .gateway-tool', nodes => nodes.length === 12));
await check('Gateway REST catalog works', () => page.evaluate(() => fetch('/api/v1/skills').then(r => r.json()).then(body => body.data.length === 12)));
await check('Gateway MCP catalog works', () => page.evaluate(() => fetch('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }).then(r => r.json()).then(body => body.result.tools.length === 12)));

await page.click('[data-route="territories"]');
await check('Territory list rendered', () => page.$$eval('#territoryList .territory-item', nodes => nodes.length > 0));
await check('Territory canvas drawn', () => page.$eval('#territoryCanvas', node => node.width > 0 && node.height > 0));

await page.click('[data-route="treasury"]');
await check('Treasury value rendered', () => page.$eval('.treasury-total strong', node => node.textContent.includes('SOL')));
await check('Treasury events rendered', () => page.$eval('#treasuryEvents', node => node.children.length > 0));
await check('Treasury wallet links to Solscan', () => page.$eval('#treasuryExplorer', node => !node.hidden && node.href.startsWith('https://solscan.io/account/')));
await check('Treasury reports real settlement counters', () => page.$eval('#treasurySettlements', node => /^\d+$/.test(node.textContent.trim())));
await check('Treasury reports token live', () => page.$eval('#treasuryPhase', node => node.textContent === 'TOKEN LIVE'));
await check('Treasury publishes official CA', () => page.$eval('#treasuryMint', node => node.textContent === 'Bos5G96FCGEGWmhVG6RCfByvKxyoiM2kZDR3HDX4pump'));
await check('Treasury links official Pump.fun coin', () => page.$eval('#treasuryPumpfun', node => node.href === 'https://pump.fun/coin/Bos5G96FCGEGWmhVG6RCfByvKxyoiM2kZDR3HDX4pump'));
await check('Treasury publishes launch tax address', () => page.$eval('#treasuryWallet', node => node.textContent === 'AoFRLLN3GjGcz5BxNuRTqLNDYSgrbhmYggUNotbDAHNF'));
await check('Treasury heading is neutral', () => page.$eval('#route-treasury .section-head b', node => node.textContent === 'NETWORK TREASURY'));

await page.click('[data-route="deploy"]');
await check('Deploy awaits wallet with live CA', () => page.$eval('#spawnButton', node => !node.disabled && node.textContent.includes('connect wallet')));
await page.click('#connectWallet');
await page.waitForSelector('#walletModal.open');
await check('Wallet selector opens', () => page.$eval('#walletModal', node => node.getAttribute('aria-hidden') === 'false'));
await page.click('#closeWalletModal');
await check('Deploy identity logo centered', () => page.$eval('.identity-console-head', node => { const host=node.getBoundingClientRect(),logo=node.querySelector('.core-mark').getBoundingClientRect(); return Math.abs((host.left+host.width/2)-(logo.left+logo.width/2))<2; }));

await page.click('[data-route="manual"]');
await page.click('[data-manual-target="security"]');
await check('Manual tabs work', () => page.$eval('#manual-security', node => node.classList.contains('active')));
await page.click('[data-manual-target="gateway"]');
await check('Manual Gateway chapter works', () => page.$eval('#manual-gateway', node => node.classList.contains('active')));
await page.click('[data-manual-target="deployment"]');
await check('Manual Deployment chapter works', () => page.$eval('#manual-deployment', node => node.classList.contains('active')));

await check('X link configured', () => page.$eval('.x-link', node => node.href === 'https://x.com/tardumocoin'));
await check('Hugging Face source link configured', () => page.$eval('.hf-link', node => node.href === 'https://huggingface.co/spaces/tardumo/Tardumo'));
await check('Tardumo branding configured', () => page.$eval('.wordmark', node => node.textContent === 'Tardumo'));
await check('Tardumo logo configured', () => page.$eval('.brand img', node => node.getAttribute('src') === 'tardumo-logo.png'));
await check('Tardigrade navigation configured', () => page.$eval('[data-route="operators"]', node => node.textContent === 'tardigrades'));
await check('Official CA configured', () => page.$eval('.ca-row code', node => node.textContent === 'Bos5G96FCGEGWmhVG6RCfByvKxyoiM2kZDR3HDX4pump'));
await check('Pump link uses official coin', () => page.$eval('.buy', node => node.href === 'https://pump.fun/coin/Bos5G96FCGEGWmhVG6RCfByvKxyoiM2kZDR3HDX4pump'));

await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
await page.goto(`${base}#live`, { waitUntil: 'networkidle2', timeout: 30_000 });
await page.waitForFunction(() => document.documentElement.dataset.api === 'online', { timeout: 15_000 });
await check('Mobile page has no body overflow', () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
await page.click('[data-route="operators"]');
await check('Mobile Tardigrades renders', () => page.$$eval('#monitorGrid .operator-monitor', nodes => nodes.length === 12));
await page.click('[data-route="deploy"]');
await check('Mobile Deploy renders', () => page.$eval('#spawnButton', node => getComputedStyle(node).display !== 'none'));
await page.click('[data-route="manual"]');
await page.click('[data-manual-target="protocol"]');
await check('Mobile Manual tabs work', () => page.$eval('#manual-protocol', node => node.classList.contains('active')));

await browser.close();
if (failures.length) {
  console.error(`Smoke test failed (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`Smoke test passed: ${checks.length} checks`);
for (const name of checks) console.log(`  ✓ ${name}`);
