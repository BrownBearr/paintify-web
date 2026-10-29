// Draws the painting (and the photo, for the split view) into a canvas on
// the painter's own WebGPU device: fit, zoom, pan and the wipe, the way the
// desktop app's blitToScreen frames it.
const SHADER = /* wgsl */ `
struct View {
  canvas: vec2f,      // canvas size, device pixels
  image: vec2f,       // image size, texels
  focus: vec2f,       // image point at the canvas centre
  scale: f32,         // device pixels per texel
  wipe: f32,          // split: device-pixel x of the divider
  backdrop: vec4f,
  mode: u32,          // 0 painted, 1 split, 2 source
  nearest: u32,
};
@group(0) @binding(0) var<uniform> v: View;
@group(0) @binding(1) var painted: texture_2d<f32>;
@group(0) @binding(2) var source: texture_2d<f32>;
@group(0) @binding(3) var smoothS: sampler;
@group(0) @binding(4) var sharp: sampler;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let ip = (pos.xy - v.canvas * 0.5) / v.scale + v.focus;
  if (any(ip < vec2f(0.0)) || any(ip >= v.image)) { return v.backdrop; }
  let uv = ip / v.image;
  let useSource = v.mode == 2u || (v.mode == 1u && pos.x < v.wipe);
  var c: vec4f;
  if (v.nearest == 1u) {
    c = select(textureSampleLevel(painted, sharp, uv, 0.0), textureSampleLevel(source, sharp, uv, 0.0), useSource);
  } else {
    c = select(textureSampleLevel(painted, smoothS, uv, 0.0), textureSampleLevel(source, smoothS, uv, 0.0), useSource);
  }
  return vec4f(c.rgb, 1.0);
}`;

export class Display {
  constructor(device, canvas) {
    this.device = device;
    this.canvas = canvas;
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    const m = device.createShaderModule({ code: SHADER });
    this.pipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: m, entryPoint: 'vs' },
      fragment: { module: m, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.ubo = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.smooth = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.sharp = device.createSampler({ magFilter: 'nearest', minFilter: 'linear' });
    this.source = null;
    this.bg = null;
    this.key = null;
  }

  // The photo, for Split and Original. Kept here rather than read from the
  // painter so the two never fight over a texture.
  setSource(image, w, h) {
    if (!this.source || this.source.width !== w || this.source.height !== h) {
      if (this.source) this.source.destroy();
      this.source = this.device.createTexture({ size: [w, h], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      this.key = null;
    }
    this.device.queue.copyExternalImageToTexture({ source: image }, { texture: this.source }, [w, h]);
  }

  // Recording/export displays borrow the main display's source texture.
  // Dispose only resources this display owns.
  destroy() {
    this.ubo?.destroy();
    this.ctx?.unconfigure();
    this.bg = null;
    this.painted = null;
    this.source = null;
  }

  // view: {zoom, focusX, focusY, wipe, mode, backdrop:[r,g,b]} in image
  // texels and CSS-independent units; returns the framing used.
  draw(painted, w, h, view) {
    // A recording canvas keeps the size it was given; the window's follows
    // its layout box.
    let cw = this.canvas.width, ch = this.canvas.height;
    if (!this.fixedSize) {
      const dpr = window.devicePixelRatio || 1;
      cw = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
      ch = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    }
    const fit = Math.min(cw / w, ch / h);
    const scale = fit * Math.max(view.zoom, 0.01);
    const fx = view.focusX < 0 ? w / 2 : view.focusX, fy = view.focusY < 0 ? h / 2 : view.focusY;
    if (!painted || !this.source) return { scale, fit, fx, fy, cw, ch };

    const key = [painted.label, painted.width, painted.height, this.source.width].join();
    if (this.key !== key || this.painted !== painted) {
      this.painted = painted;
      this.key = key;
      this.bg = this.device.createBindGroup({ layout: this.pipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.ubo } },
        { binding: 1, resource: painted.createView() },
        { binding: 2, resource: this.source.createView() },
        { binding: 3, resource: this.smooth },
        { binding: 4, resource: this.sharp },
      ] });
    }
    const left = cw / 2 - fx * scale;
    const wipePx = left + view.wipe * w * scale;
    const b = view.backdrop;
    const u = new ArrayBuffer(64), f = new Float32Array(u), i = new Uint32Array(u);
    f.set([cw, ch, w, h, fx, fy, scale, wipePx, b[0], b[1], b[2], 1]);
    i[12] = view.mode; i[13] = scale > 1 ? 1 : 0;
    this.device.queue.writeBuffer(this.ubo, 0, u);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(),
      loadOp: 'clear', storeOp: 'store', clearValue: { r: b[0], g: b[1], b: b[2], a: 1 } }] });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.bg);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    return { scale, fit, fx, fy, cw, ch, wipePx };
  }
}
