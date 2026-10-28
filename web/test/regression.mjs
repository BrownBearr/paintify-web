import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://test').pathname;
  const file = path.join(root, url.startsWith('/test/') ? '' : 'dist', url);
  fs.readFile(file, (err, data) => { res.writeHead(err ? 404 : 200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); res.end(data); });
}).listen(0);
let browser;
try {
  browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://localhost:${server.address().port}/test/paint.html`);
  await page.waitForFunction(() => window.ready);
  console.log(await page.evaluate(() => window.regressionTest('/media/coffee.jpg')));
  if (errors.length) throw new Error(errors.join('\n'));
} finally { await browser?.close(); server.close(); }
