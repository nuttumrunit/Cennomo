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
for (const route of ['skills', 'territories', 'treasury', 'deploy', 'manual']) {
  await page.goto(`${base}?v=production-3#${route}`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.documentElement.dataset.api === 'online');
  await page.screenshot({ path: resolve(output, `${route}.png`) });
}
await browser.close();
