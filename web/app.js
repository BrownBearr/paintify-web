// Paintify in the browser: the page around the painter. Sources (image,
// video, camera), the view, the settings panel, and export.
import { startPainter, Unsupported } from './painter.js';
import { Display } from './display.js';
import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.js';
import { negotiateVideoEncoderConfig, seekVideo, waitForEncoderQueue, chooseRecordingMimeType } from './video-export.js';

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};

const PRESETS = [
  ['Balanced', '8,4,2'], ['Broad', '12,6,3'], ['Fine', '6,3,1.5'], ['Large wash', '20,10'], ['Tiny marks', '4,2'],
];
const LIVE_SIZES = [['540p', 540], ['720p', 720], ['1080p', 1080], ['Full', 0]];
const MAX_IMAGE = 4096;   // long side; larger photos are scaled down to this

let painter, display, recDisplay;
const view = { zoom: 1, focusX: -1, focusY: -1, wipe: 0.5, mode: 0, backdrop: [0.886, 0.886, 0.875] };
let framing = null;
const src = { kind: null, name: '', w: 0, h: 0, liveShort: 720, steadyTouched: false };
const scaler = document.createElement('canvas');
const video = $('video');
let stream = null;
let defaults = {};
let initialLook = '';
let paintPending = false, drawPending = false, framePending = false, pumping = false;
let lastPaintMs = 0, fps = 0, frameTimes = [];
let recorder = null, recStart = 0;
let exporting = null;   // {done, total, cancel} while a video export runs
let recordingSession = null;

function busy() {
  if (!exporting) return false;
  notice('Cancel the video export before changing the source or settings.');
  return true;
}

// ── start ──────────────────────────────────────────────────────────────────
async function main() {
  try {
    painter = await startPainter();
  } catch (e) {
    $('loading').hidden = true;
    $('unsupported-why').textContent = e instanceof Unsupported ? e.message : `The painter failed to start: ${e.message}`;
    $('unsupported').hidden = false;
    console.error(e);
    return;
  }
  display = new Display(painter.device, $('view'));
  painter.lost.then(info => {
    if (info.reason === 'destroyed') return;
    stopRecording();
    stopLive();
    notice('The graphics card was reset. Reload the page to keep painting.', true, 0);
  });
  for (const k of ALL_KEYS) defaults[k] = painter.get(k);
  initialLook = painter.saveLook();
  setBackdrop();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { setBackdrop(); requestDraw(); });
  buildPanel();
  wireUi();
  $('loading').hidden = true;
  new ResizeObserver(() => requestDraw()).observe($('stage'));
}

function setBackdrop() {
  const c = getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas').trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  if (m) { const n = parseInt(m[1], 16); view.backdrop = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
}

// ── the paint/draw pump ────────────────────────────────────────────────────
// One loop does all GPU work in order: a new video frame, then a repaint if a
// setting changed, then a redraw. Painting can wait on the GPU, so nothing
// else may touch the painter while it runs.
function requestPaint() { paintPending = true; kick(); }
function requestDraw() { drawPending = true; kick(); }
function kick() { if (!pumping) pump(); }
const nextFrame = () => new Promise(r => requestAnimationFrame(r));

async function pump() {
  if (exporting) return;
  pumping = true;
  try {
    while (paintPending || drawPending || framePending) {
      if (!src.kind) { paintPending = drawPending = framePending = false; break; }
      if (framePending) {
        framePending = false;
        await paintLiveFrame();
      } else if (paintPending) {
        paintPending = false;
        const t0 = performance.now();
        if (await painter.render(false)) lastPaintMs = performance.now() - t0;
        drawPending = true;
      }
      if (drawPending) { drawPending = false; draw(); }
      await nextFrame();
    }
  } catch (e) {
    console.error(e);
    notice(`Painting failed: ${e.message}`, true);
  } finally {
    pumping = false;
  }
}

async function paintLiveFrame() {
  if (video.readyState < 2 || !src.w) return;
  const cx = scaler.getContext('2d');
  cx.drawImage(video, 0, 0, src.w, src.h);
  const steady = painter.get('p.frameDiffThreshold') > 0;
  const t0 = performance.now();
  await painter.setSource(scaler, src.w, src.h);
  display.setSource(scaler, src.w, src.h);
  await painter.render(steady && !video.paused);
  lastPaintMs = performance.now() - t0;
  const now = performance.now();
  frameTimes.push(now);
  while (frameTimes.length && now - frameTimes[0] > 1000) frameTimes.shift();
  fps = frameTimes.length;
  drawPending = true;
}

function draw() {
  const { output } = painter.textures();
  framing = display.draw(output, src.w, src.h, view);
  if ((recorder || exporting) && recDisplay) {
    recDisplay.source = display.source;
    recDisplay.draw(output, src.w, src.h, { zoom: 1, focusX: -1, focusY: -1, wipe: 0, mode: 0, backdrop: [0, 0, 0] });
  }
  placeWipe();
  updateHud();
  updateTransport();
}

function updateHud() {
  if (!src.kind) { $('hud').textContent = ''; return; }
  const s = painter.stats();
  const parts = [`${src.w}×${src.h}`, `${s.drawn.toLocaleString()} strokes`];
  if (exporting) parts.push(`exporting frame ${exporting.done} of ${exporting.total}`);
  else if (src.kind !== 'image' && !video.paused) parts.push(`${fps} fps`);
  else if (lastPaintMs) parts.push(`${Math.round(lastPaintMs)} ms`);
  if (recorder) parts.push(`● REC ${fmtTime((performance.now() - recStart) / 1000)}`);
  $('hud').textContent = parts.join('  ·  ');
}

// ── sources ────────────────────────────────────────────────────────────────
function stopLive() {
  if (exporting) { exporting.cancel = true; exporting.controller.abort(); }
  video.pause();
  if (video.__rvfc) { video.cancelVideoFrameCallback?.(video.__rvfc); video.__rvfc = 0; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  video.srcObject = null;
  if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute('src'); video.load(); }
}

function sourceReady(kind, name, w, h) {
  src.kind = kind; src.name = name; src.w = w; src.h = h;
  $('empty').hidden = true;
  $('save-btn').disabled = false;
  $('record-btn').disabled = kind === 'image';
  $('record-btn').textContent = kind === 'video' ? 'Export video' : 'Record';
  $('record-btn').title = kind === 'video' ? 'Export a silent painted MP4 at an estimated frame rate' : 'Record the painted camera (MP4 or WebM)';
  $('transport').hidden = kind !== 'video';
  src.fps = 0; src.frameDeltas = [];
  view.zoom = 1; view.focusX = view.focusY = -1;
  painter.resetTemporal();
  if (kind !== 'image' && !src.steadyTouched) painter.set('p.frameDiffThreshold', 12);
  buildPanel();
  document.title = `${name} · Paintify`;
}

async function openImage(blob, name) {
  if (busy()) return;
  stopRecording();
  stopLive();
  let bmp = await createImageBitmap(blob);
  let w = bmp.width, h = bmp.height;
  if (Math.max(w, h) > MAX_IMAGE) {
    const k = MAX_IMAGE / Math.max(w, h);
    w = Math.round(w * k); h = Math.round(h * k);
    bmp.close();
    bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    notice(`Scaled to ${w}×${h} to fit the graphics card.`);
  }
  sourceReady('image', name, w, h);
  await painter.setSource(bmp, w, h);
  display.setSource(bmp, w, h);
  requestPaint();
}

function liveSize(vw, vh) {
  const short = src.liveShort;
  if (!short || Math.min(vw, vh) <= short) return [vw - (vw & 1), vh - (vh & 1)];
  const k = short / Math.min(vw, vh);
  return [Math.round(vw * k / 2) * 2, Math.round(vh * k / 2) * 2];
}

function watchFrames() {
  let last = -1;
  const tick = (now, meta) => {
    // The frame rate, for export: the commonest gap between presented frames.
    if (meta && last >= 0 && meta.mediaTime > last && meta.mediaTime - last < 0.2) {
      src.frameDeltas.push(meta.mediaTime - last);
      if (src.frameDeltas.length > 40) src.frameDeltas.shift();
    }
    if (meta) last = meta.mediaTime;
    if (!exporting) { framePending = true; kick(); }
    video.__rvfc = video.requestVideoFrameCallback(tick);
  };
  if ('requestVideoFrameCallback' in video) video.__rvfc = video.requestVideoFrameCallback(tick);
  else {
    const poll = () => { if (src.kind && src.kind !== 'image') { if (!video.paused) { framePending = true; kick(); } requestAnimationFrame(poll); } };
    requestAnimationFrame(poll);
  }
}

async function startVideo(url, name) {
  video.srcObject = null;
  video.src = url;
  video.loop = true;
  await new Promise((res, rej) => { video.onloadeddata = res; video.onerror = () => rej(new Error('This video format cannot be played by the browser.')); });
  const [w, h] = liveSize(video.videoWidth, video.videoHeight);
  scaler.width = w; scaler.height = h;
  sourceReady('video', name, w, h);
  updateExportCapability();
  watchFrames();
  framePending = true; kick();
  try { await video.play(); } catch { /* autoplay blocked: the play button works */ }
  updateTransport();
}

async function openVideo(blob, name) {
  if (busy()) return;
  stopRecording();
  stopLive();
  try { await startVideo(URL.createObjectURL(blob), name); }
  catch (e) { notice(e.message, true); }
}

async function openCamera() {
  if (busy()) return;
  stopRecording();
  stopLive();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  } catch (e) {
    notice(e.name === 'NotAllowedError' ? 'Camera access was declined.' : `No camera: ${e.message}`, true);
    return;
  }
  video.srcObject = stream;
  video.loop = false;
  await new Promise(res => { video.onloadeddata = res; });
  await video.play();
  const [w, h] = liveSize(video.videoWidth, video.videoHeight);
  scaler.width = w; scaler.height = h;
  sourceReady('camera', 'Camera', w, h);
  watchFrames();
  framePending = true; kick();
}

async function openFile(file) {
  if (busy()) return;
  if (!file) return;
  const name = file.name.replace(/\.[^.]+$/, '');
  if (/\.sbr$/i.test(file.name)) return loadLookText(await file.text(), file.name);
  if (file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v|mkv)$/i.test(file.name)) return openVideo(file, name);
  if (file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(file.name)) return openImage(file, name);
  notice(`${file.name} is not an image or a video.`, true);
}

async function openSample(url) {
  if (busy()) return;
  // The sample video ships as H.264 and VP9; not every browser plays both.
  if (/\.mp4$/.test(url) && !document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'))
    url = url.replace(/\.mp4$/, '.webm');
  const name = url.split('/').pop().replace(/\.[^.]+$/, '');
  try {
    const blob = await (await fetch(url)).blob();
    if (/\.(mp4|webm)$/.test(url)) await openVideo(blob, name);
    else await openImage(blob, name);
  } catch (e) { notice(`Could not open the sample: ${e.message}`, true); }
}

// ── transport ──────────────────────────────────────────────────────────────
const fmtTime = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function updateTransport() {
  if (src.kind !== 'video') return;
  $('play-btn').classList.toggle('playing', !video.paused);
  if (!scrubbing && video.duration) $('scrub').value = String(Math.round(video.currentTime / video.duration * 1000));
  $('time').textContent = `${fmtTime(video.currentTime || 0)} / ${fmtTime(video.duration || 0)}`;
}
let scrubbing = false;
function togglePlay() {
  if (exporting) return;
  if (src.kind !== 'video') return;
  if (video.paused) { painter.resetTemporal(); video.play(); } else video.pause();
  setTimeout(updateTransport, 0);
}

// ── export ─────────────────────────────────────────────────────────────────
function download(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function saveImage() {
  if (!src.kind) return;
  const im = await painter.read();
  const c = document.createElement('canvas');
  c.width = im.width; c.height = im.height;
  c.getContext('2d').putImageData(im, 0, 0);
  c.toBlob(b => download(b, `${src.name}-painted.png`), 'image/png');
}

function recordingType() {
  return chooseRecordingMimeType();
}

// The camera is recorded live, as it paints.
function startRecording() {
  if (src.kind !== 'camera' || recorder) return;
  const type = recordingType();
  if (!type) { notice('This browser cannot record video.', true); return; }
  // An invisible canvas at the painting's size feeds the recorder.
  const c = el('canvas', { style: 'position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:.01;pointer-events:none', 'aria-hidden': 'true' });
  c.width = src.w; c.height = src.h;
  const session = { name: src.name, chunks: [], canvas: c, stream: null, display: null };
  const cleanup = () => {
    session.stream?.getTracks().forEach(t => t.stop());
    session.display?.destroy?.();
    c.remove();
    if (recDisplay === session.display) recDisplay = null;
    if (recordingSession === session) { recordingSession = null; recorder = null; }
  };
  try {
    document.body.append(c);
    session.display = new Display(painter.device, c);
    session.display.fixedSize = true;
    recDisplay = session.display;
    session.stream = c.captureStream(30);
    const r = new MediaRecorder(session.stream, { mimeType: type.mimeType, videoBitsPerSecond: 12e6 });
    session.recorder = r;
    recorder = r;
    recordingSession = session;
    r.ondataavailable = e => { if (e.data.size) session.chunks.push(e.data); };
    r.onerror = e => { session.failed = true; notice(`Recording failed: ${e.error?.message || 'encoder error'}`, true); stopRecording(); };
    r.onstop = () => {
      const mime = r.mimeType || type.mimeType;
      if (!session.failed && session.chunks.length) download(new Blob(session.chunks, { type: mime }), `${session.name}-painted.${mime.startsWith('video/mp4') ? 'mp4' : 'webm'}`);
      cleanup();
    };
    r.start(250);
    recStart = performance.now();
    $('record-btn').textContent = 'Stop';
    $('record-btn').classList.add('recording');
    notice(`Recording silent ${type.extension.toUpperCase()} video. Press Stop to save.`, false, 5000);
  } catch (e) {
    cleanup();
    notice(`Recording failed: ${e.message}`, true);
  }
}

function stopRecording() {
  if (!recorder) return;
  const r = recorder;
  recorder = null;
  if (r.state !== 'inactive') r.stop();
  $('record-btn').textContent = 'Record';
  $('record-btn').classList.remove('recording');
  updateHud();
}

// A video file is sampled at an estimated constant frame rate, painted and
// encoded offline. This does not preserve exact source timestamps or audio.
async function exportVideo() {
  if (exporting) { exporting.cancel = true; exporting.controller.abort(); return; }
  if (src.kind !== 'video') return;
  if (!Number.isFinite(video.duration) || video.duration <= 0) { notice('Wait for a video with a known duration before exporting.', true); return; }
  if (!window.VideoEncoder) { notice('This browser cannot encode video (WebCodecs). Try Chrome, Edge or Safari.', true); return; }
  const w = src.w, h = src.h;
  const d = [...src.frameDeltas].sort((a, b) => a - b);
  const fps = d.length >= 5 ? Math.min(60, Math.max(10, Math.round(1 / d[d.length >> 1]))) : 30;
  const bitrate = Math.round(w * h * fps * 0.25);
  const wasPlaying = !video.paused;
  const originalTime = video.currentTime;
  const name = src.name;
  video.pause();
  // window.paintifyExportLimit caps the frame count (the UI test sets it).
  const total = Math.max(1, Math.min(window.paintifyExportLimit || Infinity, Math.floor(video.duration * fps)));
  const session = { done: 0, total, cancel: false, controller: new AbortController() };
  exporting = session;
  const { signal } = session.controller;
  const btn = $('record-btn');
  btn.textContent = 'Cancel export';
  btn.classList.add('recording');
  const locked = [...document.querySelectorAll('#panel input, #panel select, #panel button, #panel summary, .bar button, #scrub, #play-btn')]
    .filter(e => e !== btn).map(e => [e, e.disabled]);
  for (const [e] of locked) { if ('disabled' in e) e.disabled = true; else e.setAttribute('inert', ''); }
  $('panel').setAttribute('inert', '');
  $('export-progress').hidden = false;
  $('export-progress').max = total;
  $('export-progress').value = 0;
  let c = null, encoder = null, exportDisplay = null;
  let failure = null;
  const steady = painter.get('p.frameDiffThreshold') > 0;
  try {
    // Let the active paint operation finish before taking exclusive GPU ownership.
    while (pumping) { if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError'); await nextFrame(); }
    paintPending = drawPending = framePending = false;
    const pick = await negotiateVideoEncoderConfig({ width: w, height: h, bitrate, framerate: fps });
    if (!pick) throw new Error('No supported MP4 video encoder is available at this processing size. Try a smaller Processing size or another browser.');
    if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
    c = el('canvas', { style: 'position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:.01;pointer-events:none', 'aria-hidden': 'true' });
    c.width = w; c.height = h;
    document.body.append(c);
    exportDisplay = new Display(painter.device, c);
    exportDisplay.fixedSize = true;
    recDisplay = exportDisplay;
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({ target, fastStart: 'in-memory', video: { codec: pick.mux, width: w, height: h, frameRate: fps } });
    encoder = new VideoEncoder({ output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { failure = e; } }, error: e => { failure = e; } });
    encoder.configure(pick.config);
    painter.resetTemporal();
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (failure) throw failure;
      await seekVideo(video, Math.min(video.duration, (i + 0.5) / fps), signal);
      scaler.getContext('2d').drawImage(video, 0, 0, w, h);
      await painter.setSource(scaler, w, h);
      display.setSource(scaler, w, h);
      await painter.render(steady);
      draw();
      const frame = new VideoFrame(c, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      try { encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 }); } finally { frame.close(); }
      await waitForEncoderQueue(encoder, { signal, getError: () => failure });
      session.done = i + 1;
      $('export-progress').value = session.done;
      updateHud();
    }
    if (failure) throw failure;
    if (!session.cancel) {
      await boundedExportFlush(encoder, signal);
      if (failure) throw failure;
      muxer.finalize();
      download(new Blob([target.buffer], { type: 'video/mp4' }), `${name}-painted.mp4`);
      notice(`Exported ${total} painted frames at an estimated ${fps} fps (silent MP4).`);
    } else notice('Export cancelled.');
  } catch (e) {
    if (e.name === 'AbortError') notice('Export cancelled.');
    else { console.error(e); notice(`Export failed: ${e.message}`, true); }
  } finally {
    try { encoder?.close(); } catch { /* closed */ }
    exportDisplay?.destroy?.();
    c?.remove();
    if (recDisplay === exportDisplay) recDisplay = null;
    exporting = null;
    btn.textContent = 'Export video';
    btn.classList.remove('recording');
    $('panel').removeAttribute('inert');
    for (const [e, disabled] of locked) { if ('disabled' in e) e.disabled = disabled; else e.removeAttribute('inert'); }
    $('export-progress').hidden = true;
    painter.resetTemporal();
    if (src.kind === 'video') { video.currentTime = originalTime; if (wasPlaying) video.play().catch(() => {}); }
    refreshAll();
    requestPaint();
    updateHud();
  }
}

function boundedExportFlush(encoder, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new DOMException('Export cancelled', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('The video encoder timed out while finishing.')); }, 30000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    encoder.flush().then(() => { cleanup(); resolve(); }, e => { cleanup(); reject(e); });
  });
}

// ── looks ──────────────────────────────────────────────────────────────────
function saveLook() {
  const text = painter.saveLook();
  const brush = painter.styles[painter.style];
  download(new Blob([text], { type: 'text/plain' }), `${brush.key === 'none' ? 'look' : brush.key}.sbr`);
}
function loadLookText(text, name) {
  if (busy()) return;
  const err = painter.loadLook(text);
  if (err) { notice(`${name}: ${err}`, true); return; }
  notice(`Opened look ${name}`);
  buildPanel();
  requestPaint();
}

let capabilityRevision = 0;
async function updateExportCapability() {
  const revision = ++capabilityRevision;
  if (src.kind !== 'video' || exporting) return;
  const pick = await negotiateVideoEncoderConfig({ width: src.w, height: src.h, bitrate: Math.round(src.w * src.h * 30 * 0.25), framerate: 30 });
  if (revision !== capabilityRevision || src.kind !== 'video' || exporting) return;
  const message = pick ? 'Silent MP4 export available. Frame rate is estimated; large videos need more memory.'
    : 'MP4 export is unavailable at this processing size. Try a smaller size or a browser with a video encoder.';
  $('record-btn').title = message;
  const status = $('export-capability');
  if (status) status.textContent = message;
}

// ── settings panel ───────────────────────────────────────────────────────────
// Mirrors the desktop app's inspector (src/main.cpp): the same sections,
// labels, ranges and defaults, over the same parameter blocks.
const ALL_KEYS = [];
const reg = k => { if (!ALL_KEYS.includes(k)) ALL_KEYS.push(k); return k; };
[
  'p.threshold', 'p.gridFactor', 'p.minStrokeLength', 'p.maxStrokeLength', 'p.curvature', 'p.sizeJitter',
  'p.angleJitter', 'p.tensorSigma', 'p.etfRadius', 'p.relaxAreaWeight', 'p.relaxMoveScale', 'p.relaxCandidates',
  'p.relaxRemove', 'p.opacity', 'p.jitterHue', 'p.jitterSat', 'p.jitterVal', 'p.opacityJitter', 'p.texStrength',
  'p.texTaper', 'p.dryBrush', 'p.impastoStrength', 'p.impastoLight', 'p.lightAngle', 'p.frameDiffThreshold',
  's.fieldMix', 's.perturb', 's.vortexSpiral', 's.vortexRadius', 's.saturation', 's.warmCool', 's.labJitterL',
  's.labJitterAB', 's.palettePull', 's.underOpacity', 's.impastoLight', 's.reliefScale', 's.specular', 's.weave',
  's.varnish', 's.crackle', 's.vignette', 's.licStrength', 's.contour', 's.rain',
  'c.bristleDensity', 'c.freshPaint', 'c.etfIterations', 'c.relaxIterations', 'c.flowLevels', 'c.flowIterations',
].forEach(reg);

const openState = { Brush: true, Strokes: true };
let refreshers = [];
let controlId = 0;

function changed(look) {
  if (exporting) return;
  if (look) painter.set('s.enabled', 1);
  if (src.kind && src.kind !== 'image' && !video.paused) painter.resetTemporal();
  requestPaint();
}

function section(title, open) {
  const body = el('div', { class: 'section-body' });
  const d = el('details', { class: 'section', open: openState[title] ?? open }, el('summary', {}, title), body);
  d.addEventListener('toggle', () => { openState[title] = d.open; });
  $('panel').append(d);
  return body;
}
function disclosure(parent, title) {
  const body = el('div', { class: 'disclosure-body' });
  const key = 'adv:' + title;
  const d = el('details', { class: 'disclosure', open: openState[key] }, el('summary', {}, 'Advanced'), body);
  d.addEventListener('toggle', () => { openState[key] = d.open; });
  parent.append(d);
  return body;
}
const group = (parent, text) => parent.append(el('div', { class: 'group-label' }, text));
const caption = (parent, text) => parent.append(el('div', { class: 'caption' }, text));

function decimals(step) { return step >= 1 ? 0 : step >= 0.1 ? 1 : 2; }

// A slider bound to a painter setting. Double-click resets to the default.
function slider(parent, o) {
  const step = o.step ?? (o.int ? 1 : (o.max - o.min) <= 2 ? 0.01 : (o.max - o.min) <= 20 ? 0.1 : 1);
  const out = el('output');
  const id = `setting-${++controlId}`;
  const input = el('input', { id, type: 'range', min: o.min, max: o.max, step, 'aria-label': o.label });
  const field = el('div', { class: 'field', title: o.help || '' }, el('label', { for: id }, o.label), out, input);
  const def = () => o.def !== undefined ? (typeof o.def === 'function' ? o.def() : o.def) : defaults[o.key];
  const show = v => {
    out.textContent = (o.int ? String(Math.round(v)) : v.toFixed(o.dp ?? decimals(step))) + (o.unit || '');
    input.style.setProperty('--fill', `${(v - o.min) / (o.max - o.min) * 100}%`);
    const d = def();
    field.classList.toggle('changed', d !== undefined && !Number.isNaN(d) && Math.abs(v - d) > step / 2);
  };
  const refresh = () => {
    const v = painter.get(o.key);
    input.value = String(v);
    show(v);
    if (o.enabled) {
      input.disabled = !o.enabled();
      out.setAttribute('aria-disabled', String(input.disabled));
      field.classList.toggle('disabled', input.disabled);
    }
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    painter.set(o.key, v);
    show(v);
    o.onChange?.(v);
    changed(o.look);
  });
  const reset = () => {
    const d = def();
    if (d === undefined || Number.isNaN(d)) return;
    painter.set(o.key, d); refresh(); o.onChange?.(d); changed(o.look);
  };
  field.addEventListener('dblclick', reset);
  out.addEventListener('click', () => {
    if (input.disabled || exporting) return;
    const t = prompt(o.label, out.textContent.replace(/[^\d.\-]/g, ''));
    if (t === null || t.trim() === '' || Number.isNaN(Number(t))) return;
    const v = Math.min(o.max, Math.max(o.min, Number(t)));
    painter.set(o.key, v); refresh(); o.onChange?.(v); changed(o.look);
  });
  refreshers.push(refresh);
  refresh();
  parent.append(field);
  return field;
}

function toggle(parent, label, get, set, help, enabled) {
  const input = el('input', { type: 'checkbox', role: 'switch' });
  const t = el('label', { class: 'toggle', title: help || '' }, label, input);
  const refresh = () => { input.checked = get(); input.disabled = enabled ? !enabled() : false; t.classList.toggle('disabled', input.disabled); };
  input.addEventListener('change', () => { set(input.checked); refreshAll(); });
  refreshers.push(refresh);
  refresh();
  parent.append(t);
}

function select(parent, label, items, get, set, enabled) {
  const id = `setting-${++controlId}`;
  const s = el('select', { id, class: 'select', 'aria-label': label },
    items.map((it, i) => el('option', { value: i }, it)));
  const refresh = () => { s.value = String(get()); s.disabled = enabled ? !enabled() : false; };
  s.addEventListener('change', () => { set(Number(s.value)); refreshAll(); });
  refreshers.push(refresh);
  refresh();
  parent.append(el('label', { class: 'select-label', for: id }, label), s);
}

function refreshAll() { refreshers.forEach(r => r()); }

function buildPanel() {
  const panel = $('panel');
  const scroll = panel.scrollTop;
  panel.textContent = '';
  refreshers = [];
  const styles = painter.styles;
  const si = painter.style;
  const brushOn = si > 0;
  const brushDefault = k => () => painter.styleDefault(k);

  // ── Brush ──
  let b = section('Brush', true);
  const list = el('div', { class: 'brush-list', role: 'group', 'aria-label': 'Brush' });
  styles.forEach((s, i) => {
    const item = el('button', { class: i === si ? 'on' : '', 'aria-pressed': i === si ? 'true' : 'false',
      onclick: () => {
        painter.setStyle(i);
        buildPanel();
        changed(false);
      } },
      el('b', {}, s.name), el('small', {}, i === 0 ? 'Original tile brush' : `${s.era} · ${s.years}`));
    list.append(item);
  });
  b.append(list);
  requestAnimationFrame(() => list.querySelector('.on')?.scrollIntoView({ block: 'nearest' }));
  caption(b, brushOn ? `Inspired by ${styles[si].era}, ${styles[si].artists}. Sets the mark only; colour, strokes and finish keep their values.`
                     : 'Original tile brush. Tune its texture below.');
  if (painter.M._pfy_layer_specs()) {
    b.append(el('div', { class: 'accent-note' }, 'This look sets stroke paths per layer, which override length, detail and curvature.'));
  }

  // Stroke size
  const radii = painter.radii;
  const norm = t => t.split(',').map(Number).join(',');
  const match = PRESETS.findIndex(p => norm(p[1]) === norm(radii));
  const sizeSel = el('select', { class: 'select', 'aria-label': 'Stroke size' },
    PRESETS.map((p, i) => el('option', { value: i }, `${p[0]}  (${p[1].replace(/,/g, ', ')} px)`)),
    match < 0 ? el('option', { value: -1 }, 'Custom') : null);
  sizeSel.value = String(match);
  sizeSel.addEventListener('change', () => { if (+sizeSel.value >= 0) { painter.radii = PRESETS[+sizeSel.value][1]; buildPanel(); changed(false); } });
  const radiiIn = el('input', { class: 'text-input mono', value: radii, 'aria-label': 'Custom sizes', placeholder: 'e.g. 12, 6, 3', title: 'Brush sizes from largest to smallest, in pixels. Press Enter to apply.' });
  radiiIn.addEventListener('keydown', e => { if (e.key === 'Enter') { painter.radii = radiiIn.value; buildPanel(); changed(false); } });
  b.append(el('div', {}, el('label', { class: 'select-label' }, 'Stroke size'), sizeSel));
  b.append(el('div', {}, el('label', { class: 'select-label' }, 'Custom sizes'), radiiIn));

  if (brushOn) {
    slider(b, { key: 's.widthScale', label: 'Width', min: 0.3, max: 2.5, unit: '×', def: brushDefault('s.widthScale'), help: 'Stroke width relative to the brush size.' });
    slider(b, { key: 's.bristles', label: 'Bristle count', min: 0, max: 60, step: 1, def: brushDefault('s.bristles'), help: '0 = a smooth mark.' });
    slider(b, { key: 's.load', label: 'Paint load', min: 0.1, max: 1, def: brushDefault('s.load'), help: 'Less paint gives broken, dry strokes.' });
    slider(b, { key: 's.impasto', label: 'Paint thickness', min: 0, max: 2, def: brushDefault('s.impasto'), help: 'Raised paint height, lit by Relief in Ground & finish.' });
    const adv = disclosure(b, 'brush');
    group(adv, 'Bristles');
    slider(adv, { key: 's.bristleClump', label: 'Bristle clumping', min: 0, max: 1, def: brushDefault('s.bristleClump') });
    slider(adv, { key: 's.bristleContrast', label: 'Streak contrast', min: 0, max: 1, def: brushDefault('s.bristleContrast') });
    group(adv, 'Dry brush');
    slider(adv, { key: 's.dryout', label: 'Runs dry', min: 0, max: 1, def: brushDefault('s.dryout'), help: 'Paint fades along the stroke.' });
    slider(adv, { key: 's.dryTooth', label: 'Skips canvas texture', min: 0, max: 1, def: brushDefault('s.dryTooth'), help: 'Paint catches only the raised weave.' });
    group(adv, 'Edges');
    slider(adv, { key: 's.edgeRough', label: 'Edge roughness', min: 0, max: 0.6, def: brushDefault('s.edgeRough') });
    slider(adv, { key: 's.endJag', label: 'Ragged ends', min: 0, max: 1, def: brushDefault('s.endJag') });
    slider(adv, { key: 's.ridge', label: 'Edge ridges', min: 0, max: 1, def: brushDefault('s.ridge') });
    slider(adv, { key: 's.groove', label: 'Bristle grooves', min: 0, max: 2, def: brushDefault('s.groove') });
    group(adv, 'Wet paint');
    slider(adv, { key: 's.pickup', label: 'Picks up wet paint', min: 0, max: 1, def: brushDefault('s.pickup') });
    slider(adv, { key: 's.smear', label: 'Drags paint underneath', min: 0, max: 1, def: brushDefault('s.smear'), help: 'Smears the paint below along each stroke.' });
    b.append(el('button', { class: 'small-btn', onclick: () => { painter.setStyle(si); buildPanel(); changed(false); },
      title: "Restore every brush-mark value to this brush's defaults." }, 'Reset brush'));
  }
  if (painter.get('s.brushModel') <= 0.5) {
    group(b, 'Classic tile brush');
    const texOn = () => painter.get('p.texStrength') > 0;
    slider(b, { key: 'p.texStrength', label: 'Brush texture strength', min: 0, max: 1, onChange: () => refreshAll() });
    slider(b, { key: 'c.bristleDensity', label: 'Bristle density', min: 2, max: 30, enabled: texOn, help: 'Bristles across the stroke width.' });
    slider(b, { key: 'p.texTaper', label: 'Tip taper', min: 0, max: 1, enabled: texOn });
    slider(b, { key: 'p.dryBrush', label: 'Fades along stroke', min: 0, max: 1, enabled: texOn });
    group(b, 'Relief');
    const finishLights = () => painter.get('s.enabled') > 0.5 && painter.get('s.finish') > 0;
    slider(b, { key: 'p.impastoStrength', label: 'Thickness', min: 0, max: 0.5, help: 'Paint height accumulated per stroke.' });
    slider(b, { key: 'p.impastoLight', label: 'Light strength', min: 0, max: 0.5, enabled: () => !finishLights(), onChange: () => refreshAll() });
    slider(b, { key: 'p.lightAngle', label: 'Light direction', min: 0, max: 360, step: 1, unit: '°',
                enabled: () => !finishLights() && painter.get('p.impastoLight') > 0 });
  }

  // ── Strokes ──
  b = section('Strokes', true);
  slider(b, { key: 'p.threshold', label: 'Detail', min: 1, max: 150, step: 1, help: 'Lower adds more strokes where the painting differs from the photo.' });
  slider(b, { key: 'p.gridFactor', label: 'Spacing', min: 0.25, max: 2.5, unit: '×', help: 'Grid spacing in brush sizes. Higher = fewer strokes.' });
  slider(b, { key: 'p.minStrokeLength', label: 'Min length', min: 1, max: 32, step: 1, help: 'Shortest stroke, in steps of about one brush size.',
              onChange: v => { if (painter.get('p.maxStrokeLength') < v) { painter.set('p.maxStrokeLength', v); refreshAll(); } } });
  slider(b, { key: 'p.maxStrokeLength', label: 'Max length', min: 1, max: 32, step: 1, help: 'Longest stroke, in steps of about one brush size.',
              onChange: v => { if (painter.get('p.minStrokeLength') > v) { painter.set('p.minStrokeLength', v); refreshAll(); } } });
  slider(b, { key: 'p.curvature', label: 'Curvature', min: 0, max: 1, help: "0 = straight strokes, 1 = strokes follow the image's curves." });
  let adv = disclosure(b, 'strokes');
  group(adv, 'Variation');
  slider(adv, { key: 'p.sizeJitter', label: 'Size variation', min: 0, max: 0.6 });
  slider(adv, { key: 'p.angleJitter', label: 'Angle variation', min: 0, max: 45, step: 1, unit: '°' });
  group(adv, 'Direction');
  select(adv, 'Direction source', ['Follow image', 'Swirl', 'Patches', 'Curl', 'Waves', 'Fixed angle'],
    () => Math.round(painter.get('s.fieldMode')), v => { painter.set('s.fieldMode', v); changed(true); });
  caption(adv, 'Follow image uses the picture’s edges, with a fallback direction in flat areas. Pattern strength applies to the other direction sources.');
  slider(adv, { key: 's.fieldMix', label: 'Pattern strength', min: 0, max: 1, look: true,
    enabled: () => painter.get('s.fieldMode') > 0.5, help: '0 = follow the image, 1 = follow the pattern.' });
  slider(adv, { key: 's.perturb', label: 'Wobble', min: 0, max: 1.5, look: true });
  const swirl = () => Math.round(painter.get('s.fieldMode')) === 1;
  toggle(adv, 'Centre swirl on brightest area', () => painter.get('s.autoVortex') > 0.5, v => { painter.set('s.autoVortex', v ? 1 : 0); changed(true); }, 'Only applies to Swirl.', swirl);
  slider(adv, { key: 's.vortexSpiral', label: 'Spiral twist', min: -1.5, max: 1.5, look: true, enabled: swirl });
  slider(adv, { key: 's.vortexRadius', label: 'Swirl size', min: 0.05, max: 1, look: true, enabled: swirl });
  group(adv, 'Direction smoothing');
  toggle(adv, 'Smooth directions', () => painter.get('tensorOn') > 0.5, v => { painter.set('tensorOn', v ? 1 : 0); changed(false); },
         'Uses a smoother direction field (structure tensor). Good for faces and soft gradients.');
  slider(adv, { key: 'p.tensorSigma', label: 'Amount', min: 0.5, max: 8, enabled: () => painter.get('tensorOn') > 0.5 });
  slider(adv, { key: 'c.etfIterations', label: 'Edge-aware passes', min: 0, max: 8, int: true, onChange: () => refreshAll(),
                help: 'Edge-aware smoothing of stroke directions. 0 = off. Slower.' });
  slider(adv, { key: 'p.etfRadius', label: 'Radius', min: 1, max: 12, step: 1, unit: ' px', enabled: () => painter.get('c.etfIterations') > 0 });
  group(adv, 'Refine strokes');
  const relaxOn = () => painter.get('c.relaxIterations') > 0;
  slider(adv, { key: 'c.relaxIterations', label: 'Refinement passes', min: 0, max: 16, int: true, onChange: () => refreshAll(),
                help: 'Moves and removes strokes to match the image with fewer marks. Each pass costs about one extra render.' });
  slider(adv, { key: 'p.relaxAreaWeight', label: 'Economy', min: 0, max: 0.4, enabled: relaxOn, help: 'Higher = fewer, larger, bolder strokes.' });
  slider(adv, { key: 'p.relaxMoveScale', label: 'Move distance', min: 0, max: 2, unit: '×', enabled: relaxOn });
  slider(adv, { key: 'p.relaxCandidates', label: 'Tries per stroke', min: 1, max: 16, step: 1, enabled: relaxOn });
  slider(adv, { key: 'p.relaxRemove', label: 'Remove weak strokes', min: 0, max: 2, enabled: relaxOn });

  // ── Colour ──
  b = section('Colour', false);
  slider(b, { key: 'p.opacity', label: 'Opacity', min: 0.05, max: 1 });
  slider(b, { key: 's.saturation', label: 'Saturation', min: 0, max: 2, look: true });
  slider(b, { key: 's.warmCool', label: 'Warm / cool', min: -1, max: 1, look: true, help: 'Positive: warm lights and cool shadows. Negative: the reverse.' });
  adv = disclosure(b, 'colour');
  group(adv, 'Per-stroke variation');
  slider(adv, { key: 'p.jitterHue', label: 'Hue', min: 0, max: 0.3 });
  slider(adv, { key: 'p.jitterSat', label: 'Saturation', min: 0, max: 0.5 });
  slider(adv, { key: 'p.jitterVal', label: 'Brightness', min: 0, max: 0.5 });
  slider(adv, { key: 'p.opacityJitter', label: 'Opacity', min: 0, max: 0.6 });
  group(adv, 'Broken colour');
  slider(adv, { key: 's.labJitterL', label: 'Lightness', min: 0, max: 20, look: true });
  slider(adv, { key: 's.labJitterAB', label: 'Hue', min: 0, max: 20, look: true });
  if (painter.get('s.paletteCount') > 0) {
    group(adv, 'Palette');
    slider(adv, { key: 's.palettePull', label: 'Palette pull', min: 0, max: 1, look: true });
  }

  // ── Ground & finish ──
  b = section('Ground & finish', false);
  select(b, 'Ground', ['Blurred photo', 'Plain', 'Average colour', 'Toned ground'],
    () => painter.get('s.groundMode') > 0.5 ? 3 : painter.get('c.underpaint'),
    v => {
      if (v === 3) painter.set('s.groundMode', 1);
      else { painter.set('c.underpaint', v); painter.set('s.groundMode', 0); }
      changed(true);
    });
  slider(b, { key: 's.underOpacity', label: 'Photo over ground', min: 0, max: 1, look: true, enabled: () => painter.get('s.groundMode') > 0.5 });
  group(b, 'Finish');
  const finishOn = () => painter.get('s.finish') > 0.9;
  toggle(b, 'Finish effects', finishOn, v => {
    painter.set('s.finish', v ? 1 : (painter.get('s.brushModel') > 0.5 ? 0.5 : 0));
    changed(true);
  }, 'Canvas weave, varnish, cracks, vignette and more.');
  const lit = () => painter.get('s.finish') > 0;
  slider(b, { key: 's.impastoLight', label: 'Relief strength', min: 0, max: 2, look: true, enabled: lit });
  slider(b, { key: 's.reliefScale', label: 'Relief depth', min: 0, max: 4, look: true, enabled: lit });
  slider(b, { key: 's.specular', label: 'Gloss', min: 0, max: 0.6, look: true, enabled: lit });
  for (const [k, l, h] of [['s.weave', 'Canvas weave'], ['s.varnish', 'Varnish'], ['s.crackle', 'Cracks', 'Craquelure.'],
                           ['s.vignette', 'Vignette'], ['s.licStrength', 'Wet smear', 'Smears the finished painting along the stroke direction.'],
                           ['s.contour', 'Outline strokes'], ['s.rain', 'Rain']])
    slider(b, { key: k, label: l, min: 0, max: 1, look: true, enabled: finishOn, help: h });

  // ── Video motion ──
  if (src.kind && src.kind !== 'image') {
    b = section('Video motion', true);
    caption(b, 'Applied while the video plays and while recording.');
    caption(b, src.kind === 'video'
      ? 'Export a silent MP4 at an estimated 10–60 fps (30 fps until measured). Export can be slower than playback and keeps the encoded file in memory.'
      : 'Record silent painted camera video. Your browser chooses MP4 or WebM.');
    if (src.kind === 'video') b.append(el('div', { class: 'caption', id: 'export-capability', role: 'status' }, $('record-btn').title));
    const steady = () => painter.get('p.frameDiffThreshold') > 0;
    toggle(b, 'Steady strokes', steady, v => {
      src.steadyTouched = true;
      painter.set('p.frameDiffThreshold', v ? 12 : 0);
      painter.resetTemporal();
      requestPaint();
    }, 'Reuses paint where nothing moved, which stops flicker.');
    slider(b, { key: 'p.frameDiffThreshold', label: 'Repaint sensitivity', min: 1, max: 64, step: 1, def: 12, enabled: steady,
                help: 'Source change needed to repaint a cell. Lower = repaint more often.' });
    slider(b, { key: 'c.freshPaint', label: 'Fresh paint on movement', min: 0, max: 1, enabled: steady,
                help: 'Repaints fast-moving areas each frame instead of dragging old paint along.' });
    select(b, 'Processing size', LIVE_SIZES.map(s => s[0]), () => Math.max(0, LIVE_SIZES.findIndex(s => s[1] === src.liveShort)),
      v => {
        src.liveShort = LIVE_SIZES[v][1];
        const [w, h] = liveSize(video.videoWidth, video.videoHeight);
        scaler.width = w; scaler.height = h; src.w = w; src.h = h;
        painter.resetTemporal();
        framePending = true; kick();
        updateExportCapability();
      });
    caption(b, 'Smaller paints faster. Strokes keep their size in pixels, so a smaller frame also looks bolder.');
    adv = disclosure(b, 'video');
    slider(adv, { key: 'c.flowLevels', label: 'Motion tracking range', min: 0, max: 6, int: true, enabled: steady, onChange: () => refreshAll(),
                  help: 'Pyramid levels for motion tracking. 0 = off; 4 tracks about 32 px per frame.' });
    slider(adv, { key: 'c.flowIterations', label: 'Tracking accuracy', min: 1, max: 6, int: true,
                  enabled: () => steady() && painter.get('c.flowLevels') > 0 });
  }
  refreshAll();
  panel.scrollTop = scroll;
}

// ── view: zoom, pan, wipe ──────────────────────────────────────────────────
function placeWipe() {
  const w = $('wipe');
  if (view.mode !== 1 || !framing || !src.kind) { w.hidden = true; return; }
  const dpr = window.devicePixelRatio || 1;
  w.hidden = false;
  w.style.left = `${framing.wipePx / dpr}px`;
}

function zoomAt(factor, cssX, cssY) {
  if (!framing || !src.kind) return;
  const dpr = window.devicePixelRatio || 1;
  const px = cssX * dpr, py = cssY * dpr;
  const ix = (px - framing.cw / 2) / framing.scale + framing.fx;
  const iy = (py - framing.ch / 2) / framing.scale + framing.fy;
  view.zoom = Math.min(64, Math.max(0.1, view.zoom * factor));
  const ns = framing.fit * view.zoom;
  view.focusX = ix - (px - framing.cw / 2) / ns;
  view.focusY = iy - (py - framing.ch / 2) / ns;
  requestDraw();
}
function fit() { view.zoom = 1; view.focusX = view.focusY = -1; requestDraw(); }

function wireView() {
  const c = $('view');
  c.addEventListener('wheel', e => {
    e.preventDefault();
    const r = c.getBoundingClientRect();
    if (e.ctrlKey || e.deltaMode === 1 || Math.abs(e.deltaY) >= 50 && !e.deltaX) {
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    } else if (framing) {
      // Trackpad two-finger scroll pans.
      const dpr = window.devicePixelRatio || 1;
      view.focusX = framing.fx + e.deltaX * dpr / framing.scale;
      view.focusY = framing.fy + e.deltaY * dpr / framing.scale;
      requestDraw();
    }
  }, { passive: false });
  let drag = null;
  const pointers = new Map();
  c.addEventListener('pointerdown', e => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!framing) return;
    c.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, fx: framing.fx, fy: framing.fy, scale: framing.scale, pinch: null };
    c.classList.add('dragging');
  });
  c.addEventListener('pointermove', e => {
    if (!drag) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && prev) {
      const [a, b2] = [...pointers.values()];
      const d = Math.hypot(a.x - b2.x, a.y - b2.y);
      if (drag.pinch) {
        const r = c.getBoundingClientRect();
        zoomAt(d / drag.pinch, (a.x + b2.x) / 2 - r.left, (a.y + b2.y) / 2 - r.top);
      }
      drag.pinch = d;
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    view.focusX = drag.fx - (e.clientX - drag.x) * dpr / drag.scale;
    view.focusY = drag.fy - (e.clientY - drag.y) * dpr / drag.scale;
    requestDraw();
  });
  const end = e => { pointers.delete(e.pointerId); if (!pointers.size) { drag = null; c.classList.remove('dragging'); } };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  c.addEventListener('dblclick', fit);

  const w = $('wipe');
  w.addEventListener('pointerdown', e => { w.setPointerCapture(e.pointerId); w.dragging = true; });
  w.addEventListener('pointermove', e => {
    if (!w.dragging || !framing) return;
    const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const left = framing.cw / 2 - framing.fx * framing.scale;
    view.wipe = Math.min(1, Math.max(0, ((e.clientX - r.left) * dpr - left) / (src.w * framing.scale)));
    requestDraw();
  });
  w.addEventListener('pointerup', () => { w.dragging = false; });
}

function setMode(m) {
  view.mode = m;
  for (const b of $('view-mode').children) {
    const selected = Number(b.dataset.mode) === m;
    b.classList.toggle('on', selected);
    b.setAttribute('aria-pressed', String(selected));
  }
  requestDraw();
}

// ── chrome ─────────────────────────────────────────────────────────────────
let noticeTimer = 0;
function notice(text, error = false, ms = error ? 6000 : 3000) {
  const n = $('notice');
  n.textContent = text;
  n.classList.toggle('error', error);
  n.hidden = false;
  clearTimeout(noticeTimer);
  if (ms) noticeTimer = setTimeout(() => { n.hidden = true; }, ms);
}

function wireUi() {
  $('settings-btn').onclick = () => {
    const collapsed = document.body.classList.toggle('settings-collapsed');
    $('settings-btn').setAttribute('aria-expanded', String(!collapsed));
  };
  $('open-btn').onclick = $('empty-open').onclick = () => $('file-input').click();
  $('camera-btn').onclick = $('empty-camera').onclick = openCamera;
  $('file-input').onchange = e => { openFile(e.target.files[0]); e.target.value = ''; };
  $('look-input').onchange = async e => { const f = e.target.files[0]; if (f) loadLookText(await f.text(), f.name); e.target.value = ''; };
  document.querySelectorAll('[data-sample]').forEach(b => b.addEventListener('click', () => { closeMenus(); openSample(b.dataset.sample); }));
  document.querySelectorAll('.menu > .btn').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const m = b.parentElement, was = m.classList.contains('open');
    closeMenus();
    m.classList.toggle('open', !was);
    b.setAttribute('aria-expanded', String(!was));
  }));
  document.querySelectorAll('.menu > .btn').forEach(b => {
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('keydown', e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault(); closeMenus();
      b.parentElement.classList.add('open'); b.setAttribute('aria-expanded', 'true');
      const items = b.parentElement.querySelectorAll('[role=menuitem]');
      items[e.key === 'ArrowUp' ? items.length - 1 : 0]?.focus();
    });
  });
  document.querySelectorAll('.menu-list').forEach(menu => menu.addEventListener('keydown', e => {
    const items = [...menu.querySelectorAll('[role=menuitem]')];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }));
  document.addEventListener('click', closeMenus);
  $('save-look').onclick = () => { closeMenus(); saveLook(); };
  $('open-look').onclick = () => { closeMenus(); $('look-input').click(); };
  $('reset-look').onclick = () => { closeMenus(); loadLookText(initialLook, 'defaults'); };
  $('save-btn').onclick = saveImage;
  $('record-btn').onclick = () => src.kind === 'video' ? exportVideo() : recorder ? stopRecording() : startRecording();
  for (const b of $('view-mode').children) b.onclick = () => setMode(Number(b.dataset.mode));
  $('play-btn').onclick = togglePlay;
  const scrub = $('scrub');
  scrub.addEventListener('pointerdown', () => { scrubbing = true; });
  scrub.addEventListener('input', () => {
    if (video.duration) { video.currentTime = Number(scrub.value) / 1000 * video.duration; painter.resetTemporal(); }
  });
  scrub.addEventListener('change', () => { scrubbing = false; });
  video.addEventListener('timeupdate', updateTransport);
  video.addEventListener('seeked', () => { if (!exporting) { framePending = true; kick(); } });

  const stage = $('stage');
  let depth = 0;
  stage.addEventListener('dragenter', e => { e.preventDefault(); depth++; $('drop').hidden = false; });
  stage.addEventListener('dragover', e => e.preventDefault());
  stage.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('drop').hidden = true; } });
  stage.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; $('drop').hidden = true;
    openFile(e.dataTransfer.files[0]);
  });
  document.addEventListener('paste', e => {
    const f = [...(e.clipboardData?.files || [])][0];
    if (f) openFile(f);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const trigger = document.querySelector('.menu.open > .btn');
      closeMenus(); trigger?.focus();
      return;
    }
    if (exporting) return;
    if (e.target.closest('input, textarea, select, button, summary, [contenteditable]')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 's') { e.preventDefault(); saveImage(); return; }
    if (mod && e.key === 'o') { e.preventDefault(); $('file-input').click(); return; }
    if (mod) return;
    if (e.key === '1' || e.key === '2' || e.key === '3') setMode(Number(e.key) - 1);
    else if (e.key === ' ' && src.kind === 'video') { e.preventDefault(); togglePlay(); }
    else if (e.key === '0' || e.key === 'f') fit();
    else if (e.key === '+' || e.key === '=') zoomAt(1.25, $('view').clientWidth / 2, $('view').clientHeight / 2);
    else if (e.key === '-') zoomAt(0.8, $('view').clientWidth / 2, $('view').clientHeight / 2);
    else if (e.key === 'c') openCamera();
    else if (e.key === 'o') $('file-input').click();
  });
  wireView();
}
function closeMenus() { document.querySelectorAll('.menu.open').forEach(m => {
  m.classList.remove('open'); m.querySelector(':scope > .btn').setAttribute('aria-expanded', 'false');
}); }

main();
