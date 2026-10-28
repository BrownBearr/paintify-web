// Drives the built app (web/dist) in Chromium and saves screenshots. Run under
// xvfb-run (Linux CI): node web/test/ui.mjs <outDir>
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../dist');
const outDir = process.argv[2] || 'ui-shots';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json',
                '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (u.endsWith('/')) u += 'index.html';
  fs.readFile(path.join(dist, u), (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(u)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(0);
const url = `http://localhost:${server.address().port}/`;
// Headful under xvfb-run: headless Chromium does not present WebGPU canvases.
const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan',
  '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera'], acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error' || /WebGPU\]/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', e => errors.push(e.message));
fs.mkdirSync(outDir, { recursive: true });
const shot = async n => { await page.screenshot({ path: path.join(outDir, n + '.png') }); console.log('shot', n, '|', await page.textContent('#hud')); };
const strokes = () => page.waitForFunction(() => /[1-9][\d,]* strokes/.test(document.getElementById('hud').textContent), null, { timeout: 120000 });

await page.goto(url);
await page.waitForSelector('#loading', { state: 'hidden', timeout: 60000 });
await shot('1-empty');
await page.click('.empty-samples [data-sample="media/coffee.jpg"]');
await strokes();
await page.waitForTimeout(500);
await shot('2-coffee');
const before = await page.textContent('#hud');
await page.click('.brush-list button:has-text("Rhythmic ridge")');
await page.waitForFunction(b => document.getElementById('hud').textContent !== b, before, { timeout: 120000 });
await page.waitForTimeout(500);
await shot('3-vangogh');
await page.click('#view-mode [data-mode="1"]');
await page.waitForTimeout(1500);
await shot('4-split');
await page.click('#samples > .btn');
await page.click('#samples [data-sample="media/cat.mp4"]');
await page.waitForFunction(() => /fps/.test(document.getElementById('hud').textContent), null, { timeout: 120000 });
await page.waitForTimeout(20000);
await shot('5-video');

// Exporting a file paints every frame and downloads an MP4.
const t0 = Date.now();
await page.evaluate(() => { window.paintifyExportLimit = 24; });
const exp = page.waitForEvent('download', { timeout: 900000 });
await page.click('#record-btn');
const expDl = await exp;
const expPath = path.join(outDir, expDl.suggestedFilename());
await expDl.saveAs(expPath);
const expSize = fs.statSync(expPath).size;
console.log('exported', expDl.suggestedFilename(), expSize, 'bytes in', Math.round((Date.now() - t0) / 1000), 's |', await page.textContent('#notice'));
if (expSize < 10000) errors.push('exported video is empty');

// A saved look opens again.
await page.click('#look-menu > .btn');
const lookDl = page.waitForEvent('download');
await page.click('#save-look');
const look = await lookDl;
const lookPath = path.join(outDir, look.suggestedFilename());
await look.saveAs(lookPath);
await page.setInputFiles('#look-input', lookPath);
await page.waitForSelector('#notice:not([hidden])');
const lookNote = await page.textContent('#notice');
console.log('look:', look.suggestedFilename(), '->', lookNote);
if (!/Opened look/.test(lookNote)) errors.push('look did not reopen: ' + lookNote);
await page.click('#camera-btn');
await page.waitForFunction(() => document.title.startsWith('Camera'), null, { timeout: 60000 });
await page.waitForTimeout(20000);
await shot('6-camera');

// The camera records live until Stop.
const rec = page.waitForEvent('download', { timeout: 120000 });
await page.click('#record-btn');
await page.waitForTimeout(15000);
await page.click('#record-btn');
const recDl = await rec;
const recPath = path.join(outDir, recDl.suggestedFilename());
await recDl.saveAs(recPath);
console.log('recorded', recDl.suggestedFilename(), fs.statSync(recPath).size, 'bytes');
if (fs.statSync(recPath).size < 1000) errors.push('camera recording is empty');
console.log(errors.length ? 'ERRORS:\n' + errors.slice(0, 20).join('\n') : 'no console errors');
const failed = errors.length > 0;
await browser.close();
server.close();
if (failed) process.exit(1);
