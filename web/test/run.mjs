// Paints a test image with each named brush in headless Chromium (WebGPU on
// SwiftShader) and writes the results as PNGs. Fails if any brush paints no
// strokes. node web/test/run.mjs <outDir> <image> [style...]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [outDir, image, ...rest] = process.argv.slice(2);
// key=value arguments are settings (e.g. c.relaxIterations=2), the rest brushes.
const settings = Object.fromEntries(rest.filter(a => a.includes('=')).map(a => [a.split('=')[0], Number(a.split('=')[1])]));
const styles = rest.filter(a => !a.includes('='));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
                '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = u.startsWith('/img/') ? path.resolve(u.slice(5)) : path.join(root, u.startsWith('/test/') ? '' : 'dist', u);
  if (u.startsWith('/test/')) f = path.join(root, u);
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(0);
const port = server.address().port;
// The test page imports ../painter.js; serve dist at the root and the test
// folder beside it.
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan',
  '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface'] });
const page = await browser.newPage();
page.on('console', m => console.log('[page]', m.text()));
page.on('pageerror', e => console.log('[page error]', e.message));
await page.goto(`http://localhost:${port}/test/paint.html`);
await page.waitForFunction(() => window.ready);
const res = await page.evaluate(([img, st, se]) => window.paintTest(img, st, se),
                                [`/img/${path.resolve(image)}`, styles.length ? styles : ['none'], settings]);
fs.mkdirSync(outDir, { recursive: true });
let failed = 0;
for (const [k, v] of Object.entries(res)) {
  if (v.stats.drawn < 1000) failed++;
  fs.writeFileSync(path.join(outDir, `${k}.png`), Buffer.from(v.png, 'base64'));
  console.log(`${k.padEnd(14)} ${v.ms.toFixed(0).padStart(6)} ms  drawn ${v.stats.drawn}  strokes ${v.stats.strokes}`);
}
await browser.close();
server.close();
if (failed) { console.error(`${failed} brush(es) painted too few strokes`); process.exit(1); }
