import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.env.CENNOMO_TEST_URL || 'http://127.0.0.1:4185/';
const executablePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const output = resolve('test-artifacts');
mkdirSync(output, { recursive: true });
const browser = await puppeteer.launch({ headless: true, executablePath, args: ['--disable-gpu', '--no-first-run'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
for (const route of ['live', 'operators', 'skills', 'territories', 'treasury', 'deploy', 'manual']) {
  await page.goto(`${base}?v=production-3#${route}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.documentElement.dataset.api === 'online');
  if (route === 'live') {
    await page.waitForFunction(() => document.querySelector('#stageVision .live-proof'), { timeout: 60_000 });
    const firstFrame = await page.$eval('.crawl-browser-frame', image => image.dataset.framePath);
    await page.waitForFunction(previous => document.querySelector('.crawl-browser-frame')?.dataset.framePath !== previous, { timeout: 8_000 }, firstFrame);
  }
  if (route === 'operators') {
    await page.waitForFunction(() => document.querySelectorAll('.operator-live-frame.connected').length === 12, { timeout: 60_000 });
    const firstFrames = await page.$$eval('.operator-live-frame', images => images.map(image => image.dataset.framePath));
    await page.waitForFunction(previous => {
      const current = [...document.querySelectorAll('.operator-live-frame')].map(image => image.dataset.framePath);
      return current.length === 12 && current.every((path, index) => path && path !== previous[index]);
    }, { timeout: 40_000 }, firstFrames);
    await page.click('.operator-monitor button');
    await page.waitForSelector('#liveRoom.open #roomLiveFrame.connected', { timeout: 20_000 });
    await page.waitForSelector('#roomVision .live-proof', { timeout: 20_000 });
  }
  await page.screenshot({ path: resolve(output, `${route}.png`) });
}
await browser.close();
