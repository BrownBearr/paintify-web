// Drives the built app (web/dist) in Chromium and saves screenshots. Run under
// xvfb-run (Linux CI): node web/test/ui.mjs <outDir>
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const outDir = process.argv[2] || 'ui-shots';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json',
                '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (u.endsWith('/')) u += 'index.html';
  fs.readFile(path.join(dist, u), (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    // Instrument only this test server's response, never the production file.
    // Await the actual serialized paint pump instead of guessing GPU timings.
    if (u === '/app.js') data = Buffer.concat([data, Buffer.from('\nwindow.paintifyTestIdle = () => !pumping && !paintPending && !drawPending;\n')]);
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
const paintIdle = () => page.waitForFunction(() => window.paintifyTestIdle?.(), null, { timeout: 120000 });

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

// Controls announce actual availability and retain direction choices.
await page.locator('.section').filter({ has: page.locator('summary', { hasText: /^Strokes$/ }) }).locator('.disclosure > summary').click();
const pattern = page.getByRole('slider', { name: 'Pattern strength', exact: true });
if (!(await pattern.isDisabled())) errors.push('Pattern strength must be disabled for Follow image');
const swirl = page.getByRole('switch', { name: 'Centre swirl on brightest area' });
if (!(await swirl.isDisabled())) errors.push('Swirl control must be disabled outside Swirl');
await page.getByLabel('Direction source', { exact: true }).selectOption('1');
if (await pattern.isDisabled() || await swirl.isDisabled()) errors.push('Swirl controls did not become available');
await page.getByLabel('Direction source', { exact: true }).selectOption('0');
await page.getByRole('button', { name: 'Samples', exact: true }).focus();
await page.keyboard.press('ArrowDown');
if (await page.getByRole('button', { name: 'Samples', exact: true }).getAttribute('aria-expanded') !== 'true') errors.push('Menu expanded state missing');
await page.keyboard.press('Escape');
if (await page.getByRole('button', { name: 'Samples', exact: true }).getAttribute('aria-expanded') !== 'false') errors.push('Escape did not close menu');

await page.locator('.section > summary').filter({ hasText: /^Experimental$/ }).click();
const experiment = page.getByRole('switch', { name: 'Experimental effects', exact: true });
if (await experiment.isChecked()) errors.push('Experimental UI defaults on');
await experiment.check();
await paintIdle();
for (const mode of ['0', '1', '2']) {
  await page.getByLabel('Experimental algorithm', { exact: true }).selectOption(mode);
  await paintIdle();
  await shot(`experimental-${mode}`);
}
await experiment.uncheck();
await paintIdle();

await page.setViewportSize({ width: 390, height: 844 });
await shot('mobile-settings');
await page.click('#settings-btn');
if (await page.locator('#panel').isVisible()) errors.push('Mobile settings did not collapse');
await shot('mobile-canvas');
await page.click('#settings-btn');
await page.setViewportSize({ width: 740, height: 390 });
await shot('mobile-landscape');
await page.setViewportSize({ width: 1440, height: 900 });
await page.emulateMedia({ colorScheme: 'dark' });
await shot('dark');
await page.emulateMedia({ colorScheme: 'light' });

await page.click('#samples > .btn');
await page.click('#samples [data-sample="media/cat.mp4"]');
await page.waitForFunction(() => /fps/.test(document.getElementById('hud').textContent), null, { timeout: 120000 });
await page.waitForTimeout(20000);
await shot('5-video');

// Missing API is a clear capability error; cancellation restores locked UI.
await page.evaluate(() => { window.savedEncoder = window.VideoEncoder; window.VideoEncoder = undefined; });
await page.click('#record-btn');
await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('cannot encode video'));
await page.evaluate(() => { window.VideoEncoder = window.savedEncoder; delete window.savedEncoder; });
await page.click('#record-btn');
await page.waitForFunction(() => document.querySelector('#record-btn').textContent === 'Cancel export');
if (!(await page.locator('#open-btn').isDisabled())) errors.push('Source controls not locked during export');
await page.click('#record-btn');
await page.waitForFunction(() => document.querySelector('#record-btn').textContent === 'Export video');
if (await page.locator('#open-btn').isDisabled()) errors.push('Cancel did not restore controls');

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
// Decode the download and inspect a real frame, rather than accepting size alone.
const decoded = await page.evaluate(async b64 => {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Export decode timeout')), 15000);
      v.onloadeddata = () => { clearTimeout(timer); resolve(); };
      v.onerror = () => { clearTimeout(timer); reject(new Error('Export could not decode')); };
      v.src = url;
    });
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    const cx = c.getContext('2d'); cx.drawImage(v, 0, 0);
    const rgba = cx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, square = 0;
    for (let i = 0; i < rgba.length; i += 4) { const l = (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3; sum += l; square += l * l; }
    const n = rgba.length / 4, mean = sum / n;
    return { width: v.videoWidth, height: v.videoHeight, duration: v.duration, mean, variance: square / n - mean * mean };
  } finally { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); }
}, fs.readFileSync(expPath).toString('base64'));
console.log('decoded export', decoded);
if (!(decoded.width > 0 && decoded.height > 0 && decoded.duration > 0 && decoded.duration < 3 && decoded.mean > 5 && decoded.variance > 10)) errors.push('Decoded export is black, flat, or has incorrect duration');

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
