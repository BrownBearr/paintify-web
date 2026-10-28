// Starts the painter: a WebGPU device, the translated shaders and the
// WebAssembly build of the shared C++ renderer, behind a small async API.
import createPaintify from './paintify.js';

export class Unsupported extends Error {}

export async function startPainter({ base = '.' } = {}) {
  if (!navigator.gpu) throw new Unsupported('This browser has no WebGPU.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Unsupported('No WebGPU graphics adapter is available.');
  // The canvas stores paint height as 32-bit float and blends strokes into
  // it; sampling those textures filtered is wanted but optional.
  if (!adapter.features.has('float32-blendable'))
    throw new Unsupported('This graphics adapter cannot blend 32-bit float paint (float32-blendable).');
  const features = ['float32-blendable', 'float32-filterable'].filter(f => adapter.features.has(f));
  const L = adapter.limits;
  const device = await adapter.requestDevice({
    requiredFeatures: features,
    requiredLimits: {
      maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
      maxBufferSize: L.maxBufferSize,
      maxStorageBuffersPerShaderStage: Math.min(L.maxStorageBuffersPerShaderStage, 10),
    },
  });
  const [shaders, M] = await Promise.all([
    fetch(`${base}/shaders.json`).then(r => r.json()),
    createPaintify({ locateFile: f => `${base}/${f}` }),
  ]);
  M.GLW.init(device, shaders);
  M.GLW.adapterName = (adapter.info && (adapter.info.description || adapter.info.vendor)) || 'WebGPU';
  if (!M._pfy_init()) throw new Error('The painter failed to start; see the console.');
  return new Painter(M, device);
}

export class Painter {
  constructor(M, device) {
    this.M = M;
    this.device = device;
    this.busy = Promise.resolve();
    this.styles = JSON.parse(M.UTF8ToString(M._pfy_styles()));
    // A lost device (driver reset, GPU process crash) cannot be recovered
    // in place: the renderer's every texture and buffer went with it.
    this.lost = device.lost.then(info => { console.error('WebGPU device lost:', info.message); return info; });
  }
  str(fn, ...args) { return this.M.UTF8ToString(fn(...args)); }
  withString(s, fn) {
    const M = this.M, n = s.length * 3 + 1, p = M._malloc(n);
    M.stringToUTF8 ? M.stringToUTF8(s, p, n) : new TextEncoder().encodeInto(s + '\0', M.HEAPU8.subarray(p, p + n));
    try { return fn(p); } finally { M._free(p); }
  }
  // Painting calls can suspend on a GPU read-back, so they are serialised.
  run(fn) {
    const r = this.busy.then(fn);
    this.busy = r.catch(() => {});
    return r;
  }
  get(key) { return this.withString(key, p => this.M._pfy_get(p)); }
  set(key, v) { return this.withString(key, p => this.M._pfy_set(p, v)); }
  styleDefault(key) { return this.withString(key, p => this.M._pfy_style_default(p)); }
  setStyle(i) { this.M._pfy_set_style(i); }
  get style() { return this.M._pfy_style(); }
  get radii() { return this.str(this.M._pfy_radii); }
  set radii(text) { this.withString(text, p => this.M._pfy_set_radii(p)); }
  get width() { return this.M._pfy_width(); }
  get height() { return this.M._pfy_height(); }
  stats() { return JSON.parse(this.str(this.M._pfy_stats)); }
  resetTemporal() { this.M._pfy_reset_temporal(); }

  // `source`: ImageBitmap, HTMLVideoElement, VideoFrame or canvas. It is
  // copied straight into the source texture on the GPU.
  setSource(source, w, h) {
    return this.run(() => {
      this.M.GLW.external = source;
      return this.M.ccall('pfy_set_source', 'number', ['number', 'number', 'number'], [0, w, h], { async: true });
    });
  }
  setSourcePixels(rgba, w, h) {
    return this.run(async () => {
      const M = this.M, p = M._malloc(rgba.length);
      M.HEAPU8.set(rgba, p);
      try { return await M.ccall('pfy_set_source', 'number', ['number', 'number', 'number'], [p, w, h], { async: true }); }
      finally { M._free(p); }
    });
  }
  render(temporal = false) {
    return this.run(() => this.M.ccall('pfy_render', 'number', ['number'], [temporal ? 1 : 0], { async: true }));
  }
  // The painting as RGBA8 (top row first).
  read() {
    return this.run(async () => {
      const M = this.M;
      const p = await M.ccall('pfy_read_canvas', 'number', [], [], { async: true });
      const n = this.width * this.height * 4;
      const out = M.HEAPU8.slice(p, p + n);
      M._free(p);
      return new ImageData(new Uint8ClampedArray(out.buffer), this.width, this.height);
    });
  }
  // GPUTextures for display: the painting and the source photo.
  textures() {
    const G = this.M.GLW;
    const out = G.textures.get(this.M._pfy_output_texture());
    // Flush so the page's own commands run after the painting's.
    G.flush();
    return { output: out && out.tex };
  }
  saveLook() { return this.str(this.M._pfy_save_look); }
  loadLook(text) { return this.withString(text, p => this.M.UTF8ToString(this.M._pfy_load_look(p))); }
}
