import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('.');
const output = resolve(root, 'dist-pages');
if (!output.startsWith(`${root}\\`) && !output.startsWith(`${root}/`)) throw new Error('invalid Pages output directory');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const assets = [
  'index.html', 'app.js', 'styles.css', 'live-crawlnet.css', 'console-polish.css', 'tardumo-terminal.css',
  'tardumo-logo.png', 'favicon-original.png', 'favicon.svg'
];
for (const asset of assets) cpSync(resolve(root, asset), resolve(output, asset));

const apiOrigin = String(process.env.CENNOMO_API_ORIGIN || '').trim().replace(/\/$/, '');
if (apiOrigin && !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(apiOrigin)) throw new Error('CENNOMO_API_ORIGIN must be an HTTPS origin without a path');
writeFileSync(resolve(output, 'runtime-config.js'), `window.CENNOMO_API_ORIGIN=${JSON.stringify(apiOrigin)};\n`);
writeFileSync(resolve(output, '.nojekyll'), '');
console.log(`GitHub Pages bundle created at ${output}`);
console.log(`API origin: ${apiOrigin || 'NOT CONFIGURED'}`);
