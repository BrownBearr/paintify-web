// The GL 4.6 subset Paintify uses (src/gl_subset.h), implemented on WebGPU,
// as an Emscripten JS library. The renderer (src/pipeline.cpp) runs unchanged
// on top of it; see src/mac/gl_metal.mm for the same layer on Metal.
//
// How GL maps onto WebGPU here:
//  - Shaders are translated to WGSL ahead of time (web/tools/build_shaders.mjs)
//    and looked up by file name; the "source" handed to glShaderSource is the
//    name. Everything sits in bind group 0, in per-type slot ranges (SLOT).
//  - Commands are recorded into one command encoder in GL order. Uploads go
//    through a staging buffer copied *inside* that encoder, so a later
//    glNamedBufferSubData never overtakes an earlier dispatch; WebGPU orders
//    passes and dispatches itself, so the barrier calls are no-ops.
//  - Loose uniforms (glUniform*) live in a per-program CPU block, copied into
//    a uniform arena at each dispatch or draw, as GL captures them.
//  - Read-backs flush the encoder and wait for the map; ASYNCIFY suspends
//    the C++ caller meanwhile, so to it they block, as they do on GL.
//  - R16F and RG16F are stored as 32-bit float: half-float storage textures
//    are an optional WebGPU feature. Read-write rgba16f images read from a
//    copy taken before the dispatch (the translator rewrote their imageLoads).
//  - Texel row 0 is the top row in WebGPU; the translator flips clip-space y
//    so a framebuffer's row 0 is still texel row 0, as on GL.

addToLibrary({
  $GLW__deps: ['$UTF8ToString', '$stringToNewUTF8'],
  $GLW__postset: 'Module["GLW"] = GLW;',
  $GLW: {
    SLOT: { storage: 0, uniform: 16, defaultBlock: 20, texture: 24, sampler: 40, image: 56,
            readTexture: 72, readSampler: 88 },
    device: null, queue: null, shaders: null, filterable32: true,
    next: 1,
    textures: new Map(), buffers: new Map(), fbos: new Map(), shaderObjs: new Map(),
    programs: new Map(), queries: new Map(),
    ssbo: [], ubo: [], units: [], images: [],
    bufTarget: {}, program: 0, drawFbo: 0, readFbo: 0,
    caps: { blend: false, scissor: false, depth: false },
    blend: [], viewport: [0, 0, 0, 0], scissor: [0, 0, 0, 0], clearColor: [0, 0, 0, 0],
    enc: null, cpass: null, staging: [], samplers: new Map(), strings: {},
    arena: null, arenaCpu: null, arenaOff: 0, ARENA: 1 << 20,
    external: null,   // a VideoFrame / ImageBitmap / canvas for the next null-pixel upload
    errors: 0,

    init(device, shaders) {
      GLW.device = device;
      GLW.queue = device.queue;
      GLW.shaders = shaders;
      GLW.filterable32 = device.features.has('float32-filterable');
      GLW.blendable32 = device.features.has('float32-blendable');
      GLW.arena = device.createBuffer({ size: GLW.ARENA, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      GLW.arenaCpu = new Uint8Array(GLW.ARENA);
      const B = GPUBufferUsage;
      GLW.dummyBuf = device.createBuffer({ size: 65536, usage: B.STORAGE | B.UNIFORM | B.COPY_DST });
      GLW.dummy = {};
      device.addEventListener && device.addEventListener('uncapturederror', e => {
        if (GLW.errors++ < 20) console.error('[WebGPU]', e.error.message);
      });
    },

    // --- formats --------------------------------------------------------
    fmt(glInternal) {
      switch (glInternal) {
        case 0x8058: return 'rgba8unorm';     // GL_RGBA8
        case 0x881A: return 'rgba16float';    // GL_RGBA16F
        case 0x8814: return 'rgba32float';    // GL_RGBA32F
        case 0x822F: case 0x8230: return 'rg32float';   // GL_RG16F, GL_RG32F
        case 0x822D: case 0x822E: return 'r32float';    // GL_R16F, GL_R32F
        case 0x8236: return 'r32uint';        // GL_R32UI
      }
      throw new Error('gl_webgpu: unsupported internal format 0x' + glInternal.toString(16));
    },
    bpp(f) { return { rgba8unorm: 4, rgba16float: 8, r16float: 2, rgba32float: 16, rg32float: 8, r32float: 4, r32uint: 4 }[f]; },
    channels(f) { return { rgba8unorm: 4, rgba16float: 4, r16float: 1, rgba32float: 4, rg32float: 2, r32float: 1, r32uint: 1 }[f]; },
    glChannels(format) {
      switch (format) { case 0x1903: case 0x8D94: return 1; case 0x8227: return 2; case 0x1907: return 3; default: return 4; }
    },
    is32f(f) { return f === 'r32float' || f === 'rg32float' || f === 'rgba32float'; },

    // --- half floats ------------------------------------------------------
    f32: new Float32Array(1), u32v: null,
    toHalf(v) {
      const f = GLW.f32; f[0] = v;
      const x = (GLW.u32v || (GLW.u32v = new Uint32Array(f.buffer)))[0];
      const sign = (x >>> 16) & 0x8000;
      let e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
      if (((x >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
      if (e >= 31) return sign | 0x7c00;
      if (e <= 0) {
        if (e < -10) return sign;
        m = (m | 0x800000) >> (1 - e);
        return sign | ((m + 0x1000) >> 13);
      }
      return sign | (e << 10) | ((m + 0x1000) >> 13);
    },
    fromHalf(h) {
      const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
      if (e === 0) return s * m * 5.960464477539063e-8;
      if (e === 31) return m ? NaN : s * Infinity;
      return s * (1 + m / 1024) * Math.pow(2, e - 15);
    },

    // Reads `count` texels of GL client data as floats (or uints) per channel.
    readClient(ptr, n, ch, type) {
      switch (type) {
        case 0x1401: return HEAPU8.subarray(ptr, ptr + n * ch);                     // UNSIGNED_BYTE
        case 0x1406: return HEAPF32.subarray(ptr >> 2, (ptr >> 2) + n * ch);        // FLOAT
        case 0x1405: return HEAPU32.subarray(ptr >> 2, (ptr >> 2) + n * ch);        // UNSIGNED_INT
        case 0x140B: { const h = HEAPU16.subarray(ptr >> 1, (ptr >> 1) + n * ch);   // HALF_FLOAT
          const o = new Float32Array(n * ch); for (let i = 0; i < o.length; i++) o[i] = GLW.fromHalf(h[i]); return o; }
      }
      throw new Error('gl_webgpu: unsupported pixel type 0x' + type.toString(16));
    },
    // Converts client texels to the bytes of texture format `f`.
    pack(src, n, srcCh, type, f) {
      const dstCh = GLW.channels(f);
      const unorm = type === 0x1401;
      const get = (i, c) => c < srcCh ? (unorm && f !== 'rgba8unorm' ? src[i * srcCh + c] / 255 : src[i * srcCh + c])
                                      : (c === 3 ? (f === 'rgba8unorm' && unorm ? 255 : 1) : 0);
      if (f === 'rgba8unorm') {
        if (unorm && srcCh === 4) return new Uint8Array(src);
        const o = new Uint8Array(n * 4);
        for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) {
          const v = get(i, c); o[i * 4 + c] = unorm ? v : Math.max(0, Math.min(255, Math.round(v * 255)));
        }
        return o;
      }
      if (f === 'rgba16float') {
        const o = new Uint16Array(n * 4);
        for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) o[i * 4 + c] = GLW.toHalf(get(i, c));
        return new Uint8Array(o.buffer);
      }
      if (f === 'r16float') { const o = new Uint16Array(n); for (let i = 0; i < n; i++) o[i] = GLW.toHalf(get(i, 0)); return new Uint8Array(o.buffer); }
      if (f === 'r32uint') { const o = new Uint32Array(n); for (let i = 0; i < n; i++) o[i] = src[i * srcCh]; return new Uint8Array(o.buffer); }
      const o = new Float32Array(n * dstCh);
      for (let i = 0; i < n; i++) for (let c = 0; c < dstCh; c++) o[i * dstCh + c] = get(i, c);
      return new Uint8Array(o.buffer);
    },

    // --- command recording ------------------------------------------------
    encoder() {
      if (!GLW.enc) GLW.enc = GLW.device.createCommandEncoder();
      return GLW.enc;
    },
    endPass() {
      if (GLW.cpass) { GLW.cpass.end(); GLW.cpass = null; }
    },
    computePass() {
      if (!GLW.cpass) GLW.cpass = GLW.encoder().beginComputePass();
      return GLW.cpass;
    },
    flush() {
      GLW.endPass();
      if (GLW.arenaOff) {
        GLW.queue.writeBuffer(GLW.arena, 0, GLW.arenaCpu, 0, GLW.arenaOff);
        GLW.arenaOff = 0;
      }
      if (GLW.enc) {
        GLW.queue.submit([GLW.enc.finish()]);
        GLW.enc = null;
      }
      if (GLW.staging.length) {
        const s = GLW.staging; GLW.staging = [];
        GLW.queue.onSubmittedWorkDone().then(() => s.forEach(b => b.destroy()));
      }
    },
    arenaAlloc(bytes) {
      const size = Math.max(16, Math.ceil(bytes / 16) * 16);
      if (GLW.arenaOff + size > GLW.ARENA) GLW.flush();
      const off = GLW.arenaOff;
      GLW.arenaOff = Math.ceil((off + size) / 256) * 256;
      return off;
    },
    // A buffer filled with `bytes`, for a copy recorded in the encoder.
    stage(bytes) {
      const size = Math.max(4, Math.ceil(bytes.byteLength / 4) * 4);
      const b = GLW.device.createBuffer({ size, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
      new Uint8Array(b.getMappedRange()).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      b.unmap();
      GLW.staging.push(b);
      return b;
    },

    // --- objects ------------------------------------------------------------
    makeTexture(t) {
      const f = t.format, U = GPUTextureUsage;
      let usage = U.TEXTURE_BINDING | U.COPY_SRC | U.COPY_DST | U.RENDER_ATTACHMENT;
      if (f !== 'r16float') usage |= U.STORAGE_BINDING;
      t.tex = GLW.device.createTexture({
        size: [t.w, t.h, t.depth], format: f, mipLevelCount: t.levels, usage,
        dimension: '2d',
      });
      t.views = {};
    },
    view(t, kind, level) {
      const key = kind + level;
      if (t.views[key]) return t.views[key];
      let d;
      if (kind === 'sample') d = { dimension: t.array ? '2d-array' : '2d' };
      else if (kind === 'sampleLevel') d = { dimension: '2d', baseMipLevel: level, mipLevelCount: 1 };
      else d = { dimension: '2d', baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 };
      return (t.views[key] = t.tex.createView(d));
    },
    sampler(t, forceNearest) {
      const mf = t.minF, nearest = forceNearest;
      const lin = v => (!nearest && (v === 0x2601 || v === 0x2701 || v === 0x2703)) ? 'linear' : 'nearest';
      const mip = (mf === 0x2702 || mf === 0x2703) && !nearest ? 'linear' : 'nearest';
      const useMips = mf >= 0x2700 && mf <= 0x2703;
      const wrap = v => v === 0x2901 ? 'repeat' : 'clamp-to-edge';
      const key = [lin(t.magF), lin(mf), mip, useMips, wrap(t.wrapS), wrap(t.wrapT)].join();
      let s = GLW.samplers.get(key);
      if (!s) {
        s = GLW.device.createSampler({
          magFilter: lin(t.magF), minFilter: lin(mf), mipmapFilter: mip,
          lodMinClamp: 0, lodMaxClamp: useMips ? 32 : 0,
          addressModeU: wrap(t.wrapS), addressModeV: wrap(t.wrapT),
        });
        GLW.samplers.set(key, s);
      }
      return s;
    },
    dummyTexture(kind, format) {
      const key = kind + format;
      if (GLW.dummy[key]) return GLW.dummy[key];
      const t = { w: 1, h: 1, depth: 1, levels: 1, format, array: kind === 'array',
                  minF: 0x2600, magF: 0x2600, wrapS: 0x812F, wrapT: 0x812F };
      GLW.makeTexture(t);
      return (GLW.dummy[key] = t);
    },
    // A same-sized scratch copy of texture `t`, for reading what a pass also
    // writes (read-write images, or a sampler aliasing an attachment).
    snapshot(t, level) {
      const key = '__copy' + level;
      let c = t[key];
      const w = Math.max(1, t.w >> level), h = Math.max(1, t.h >> level);
      if (!c) {
        c = { w, h, depth: 1, levels: 1, format: t.format, array: false,
              minF: 0x2600, magF: 0x2600, wrapS: 0x812F, wrapT: 0x812F };
        GLW.makeTexture(c);
        t[key] = c;
      }
      GLW.endPass();
      GLW.encoder().copyTextureToTexture({ texture: t.tex, mipLevel: level }, { texture: c.tex }, [w, h, 1]);
      return c;
    },

    // Without float32-filterable a 32-bit float texture cannot be sampled
    // through a filtering sampler, so it is read through a half-float copy
    // (every mip level) instead: the precision the desktop build stores
    // those textures at anyway.
    halfCopy(t) {
      const fmt = { r32float: 'r16float', rg32float: 'rg16float', rgba32float: 'rgba16float' }[t.format];
      let c = t.__half;
      if (!c) {
        c = { w: t.w, h: t.h, depth: 1, levels: t.levels, format: fmt, array: false,
              minF: t.minF, magF: t.magF, wrapS: t.wrapS, wrapT: t.wrapT };
        const U = GPUTextureUsage;
        c.tex = GLW.device.createTexture({ size: [t.w, t.h], format: fmt, mipLevelCount: t.levels,
          usage: U.TEXTURE_BINDING | U.RENDER_ATTACHMENT });
        c.views = {};
        t.__half = c;
      }
      Object.assign(c, { minF: t.minF, magF: t.magF, wrapS: t.wrapS, wrapT: t.wrapT });
      GLW.half = GLW.half || {};
      if (!GLW.half[fmt]) {
        const code = `
          @group(0) @binding(0) var src: texture_2d<f32>;
          @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
            let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
            return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
          }
          @fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
            return textureLoad(src, vec2i(pos.xy), 0);
          }`;
        const m = GLW.device.createShaderModule({ code });
        const bgl = GLW.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' } }] });
        GLW.half[fmt] = { bgl, pipe: GLW.device.createRenderPipeline({
          layout: GLW.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
          vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: fmt }] },
          primitive: { topology: 'triangle-list' } }) };
      }
      const H = GLW.half[fmt];
      GLW.endPass();
      const enc = GLW.encoder();
      for (let l = 0; l < t.levels; l++) {
        const pass = enc.beginRenderPass({ colorAttachments: [{ view: GLW.view(c, 'attach', l), loadOp: 'clear', storeOp: 'store' }] });
        pass.setPipeline(H.pipe);
        pass.setBindGroup(0, GLW.device.createBindGroup({ layout: H.bgl, entries: [{ binding: 0, resource: GLW.view(t, 'sampleLevel', l) }] }));
        pass.draw(3);
        pass.end();
      }
      return c;
    },

    // --- programs -------------------------------------------------------------
    link(p) {
      const stages = p.shaders.map(s => GLW.shaderObjs.get(s)).map(s => ({ type: s.type, info: GLW.shaders[s.key], key: s.key }));
      for (const s of stages) if (!s.info) { p.log = 'no translated shader for ' + s.key; return false; }
      const vis = { compute: GPUShaderStage.COMPUTE, vertex: GPUShaderStage.VERTEX, fragment: GPUShaderStage.FRAGMENT };
      const merged = new Map();
      p.uniforms = []; p.blockSize = 0; p.resources = [];
      for (const s of stages) {
        for (const b of s.info.bindings) {
          const m = merged.get(b.binding);
          if (m) m.visibility |= vis[s.info.stage];
          else merged.set(b.binding, { ...b, visibility: vis[s.info.stage] });
        }
        for (const r of s.info.resources) p.resources.push(r);
        if (s.info.uniformBlockSize) {
          p.blockSize = Math.max(p.blockSize, s.info.uniformBlockSize);
          for (const u of s.info.uniforms) if (!p.uniforms.find(x => x.name === u.name)) p.uniforms.push(u);
        }
      }
      p.bindings = [...merged.values()].sort((a, b) => a.binding - b.binding);
      p.block = new Uint8Array(Math.max(16, p.blockSize));
      p.blockView = new DataView(p.block.buffer);
      const entries = p.bindings.map(b => {
        const e = { binding: b.binding, visibility: b.visibility };
        if (b.type === 'uniform') e.buffer = { type: 'uniform' };
        else if (b.type === 'storage') e.buffer = { type: 'storage' };
        else if (b.type === 'read-only-storage') e.buffer = { type: 'read-only-storage' };
        else if (b.type === 'sampler') e.sampler = { type: 'filtering' };
        else if (b.type === 'texture') e.texture = { sampleType: b.sample === 'uint' ? 'uint' : 'float', viewDimension: b.dim };
        else if (b.type === 'storageTexture') e.storageTexture = { access: b.access, format: b.format, viewDimension: '2d' };
        return e;
      });
      p.bgl = GLW.device.createBindGroupLayout({ entries });
      p.layout = GLW.device.createPipelineLayout({ bindGroupLayouts: [p.bgl] });
      p.modules = {};
      for (const s of stages) {
        p.modules[s.info.stage] = GLW.device.createShaderModule({ code: s.info.wgsl, label: s.key });
        if (s.info.stage === 'compute') p.localSize = s.info.localSize;
      }
      p.compute = !!p.modules.compute;
      p.pipelines = new Map();
      p.keys = stages.map(s => s.key).join('+');
      return true;
    },
    computePipeline(p) {
      if (!p.cp) p.cp = GLW.device.createComputePipeline({ layout: p.layout, label: p.keys,
                                                           compute: { module: p.modules.compute, entryPoint: 'main' } });
      return p.cp;
    },
    glBlend(v) {
      return { 0: 'zero', 1: 'one', 0x0302: 'src-alpha', 0x0303: 'one-minus-src-alpha' }[v] || 'one';
    },
    renderPipeline(p, formats, topology) {
      const blends = formats.map((f, i) => GLW.caps.blend ? (GLW.blend[i] || [1, 0]) : null);
      const key = formats.join() + '|' + topology + '|' + JSON.stringify(blends);
      let rp = p.pipelines.get(key);
      if (rp) return rp;
      rp = GLW.device.createRenderPipeline({
        layout: p.layout, label: p.keys,
        vertex: { module: p.modules.vertex, entryPoint: 'main' },
        fragment: { module: p.modules.fragment, entryPoint: 'main',
          targets: formats.map((format, i) => {
            const t = { format };
            if (blends[i]) {
              const c = { srcFactor: GLW.glBlend(blends[i][0]), dstFactor: GLW.glBlend(blends[i][1]), operation: 'add' };
              t.blend = { color: c, alpha: c };
            }
            return t;
          }) },
        primitive: { topology, stripIndexFormat: undefined },
      });
      p.pipelines.set(key, rp);
      return rp;
    },

    // Bind group 0 for the current program from GL's binding state. `writes`
    // lists the textures this pass writes (images, attachments): a sampler
    // that names one of them reads a copy instead, since WebGPU forbids
    // reading and writing one texture in a single pass or dispatch.
    bindGroup(p, attachments) {
      const S = GLW.SLOT;
      const writes = new Set(attachments || []);
      for (const r of p.resources) if (r.kind === 'image') { const im = GLW.images[r.gl]; if (im) writes.add(im.tex); }
      const entries = [];
      for (const b of p.bindings) {
        const n = b.binding;
        let res;
        if (b.type === 'uniform' && n === S.defaultBlock) {
          const off = GLW.arenaAlloc(p.blockSize);
          GLW.arenaCpu.set(p.block.subarray(0, p.blockSize), off);
          res = { buffer: GLW.arena, offset: off, size: Math.max(16, p.blockSize) };
        } else if (b.type === 'uniform') {
          const buf = GLW.buffers.get(GLW.ubo[n - S.uniform]);
          res = buf ? { buffer: buf.buf } : { buffer: GLW.dummyBuf };
        } else if (b.type === 'storage' || b.type === 'read-only-storage') {
          const buf = GLW.buffers.get(GLW.ssbo[n - S.storage]);
          res = buf ? { buffer: buf.buf } : { buffer: GLW.dummyBuf };
        } else if (b.type === 'storageTexture') {
          const im = GLW.images[n - S.image];
          const t = im && GLW.textures.get(im.tex);
          res = t && t.format === b.format ? GLW.view(t, 'storage', im.level)
                                           : GLW.view(GLW.dummyTexture('storage', b.format), 'storage', 0);
        } else if (b.type === 'texture' && n >= S.readTexture) {
          const im = GLW.images[n - S.readTexture];
          const t = im && GLW.textures.get(im.tex);
          res = t ? GLW.view(GLW.snapshot(t, im.level), 'sampleLevel', 0)
                  : GLW.view(GLW.dummyTexture('2d', 'rgba16float'), 'sample', 0);
        } else if (b.type === 'texture') {
          const name = GLW.units[n - S.texture];
          let t = name && GLW.textures.get(name);
          const wantArray = b.dim === '2d-array';
          if (!t || !!t.array !== wantArray) t = GLW.dummyTexture(wantArray ? 'array' : '2d', 'rgba16float');
          else if (writes.has(name)) t = GLW.snapshot(t, 0);
          if (!GLW.filterable32 && GLW.is32f(t.format)) t = GLW.halfCopy(t);
          res = GLW.view(t, 'sample', 0);
        } else if (b.type === 'sampler' && n >= S.readSampler) {
          res = GLW.sampler(GLW.dummyTexture('2d', 'rgba16float'), true);
        } else if (b.type === 'sampler') {
          const name = GLW.units[n - S.sampler];
          const t = (name && GLW.textures.get(name)) || GLW.dummyTexture('2d', 'rgba16float');
          res = GLW.sampler(t);
        }
        entries.push({ binding: n, resource: res });
      }
      return GLW.device.createBindGroup({ layout: p.bgl, entries });
    },

    async readBuffer(src, offset, size) {
      const a0 = offset & ~3, a1 = Math.ceil((offset + size) / 4) * 4;
      const rb = GLW.device.createBuffer({ size: a1 - a0, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      GLW.endPass();
      GLW.encoder().copyBufferToBuffer(src, a0, rb, 0, a1 - a0);
      GLW.flush();
      await rb.mapAsync(GPUMapMode.READ);
      const out = new Uint8Array(rb.getMappedRange().slice(offset - a0, offset - a0 + size));
      rb.unmap(); rb.destroy();
      return out;
    },

    cstr(s) {
      if (!GLW.strings[s]) GLW.strings[s] = stringToNewUTF8(s);
      return GLW.strings[s];
    },
  },

  // --- context ---------------------------------------------------------------
  glGetString__deps: ['$GLW'],
  glGetString: (name) => {
    const s = { 0x1F00: 'WebGPU', 0x1F01: (GLW.adapterName || 'WebGPU'), 0x1F02: 'GL 4.6 subset on WebGPU' }[name] || '';
    return GLW.cstr(s);
  },
  glEnable__deps: ['$GLW'],
  glEnable: (cap) => { if (cap === 0x0BE2) GLW.caps.blend = true; else if (cap === 0x0C11) GLW.caps.scissor = true; else if (cap === 0x0B71) GLW.caps.depth = true; },
  glDisable__deps: ['$GLW'],
  glDisable: (cap) => { if (cap === 0x0BE2) GLW.caps.blend = false; else if (cap === 0x0C11) GLW.caps.scissor = false; else if (cap === 0x0B71) GLW.caps.depth = false; },
  glIsEnabled__deps: ['$GLW'],
  glIsEnabled: (cap) => (cap === 0x0BE2 ? GLW.caps.blend : cap === 0x0C11 ? GLW.caps.scissor : cap === 0x0B71 ? GLW.caps.depth : false) ? 1 : 0,
  glGetIntegerv__deps: ['$GLW'],
  glGetIntegerv: (pname, ptr) => {
    const v = pname === 0x0C10 ? GLW.scissor : pname === 0x0BA2 ? GLW.viewport : [0];
    for (let i = 0; i < v.length; i++) HEAP32[(ptr >> 2) + i] = v[i];
  },
  glViewport__deps: ['$GLW'],
  glViewport: (x, y, w, h) => { GLW.viewport = [x, y, w, h]; },
  glScissor__deps: ['$GLW'],
  glScissor: (x, y, w, h) => { GLW.scissor = [x, y, w, h]; },
  glClearColor__deps: ['$GLW'],
  glClearColor: (r, g, b, a) => { GLW.clearColor = [r, g, b, a]; },
  glClear__deps: ['$GLW'],
  glClear: (mask) => {
    const f = GLW.fbos.get(GLW.drawFbo);
    if (!f) return;   // the window is drawn by the page, not through GL
    GLW.endPass();
    const [r, g, b, a] = GLW.clearColor;
    const atts = f.drawBuffers.map(i => f.att[i]).filter(Boolean).map(at => ({
      view: GLW.view(GLW.textures.get(at.tex), 'attach', at.level), loadOp: 'clear', storeOp: 'store',
      clearValue: { r, g, b, a } }));
    if (atts.length) GLW.encoder().beginRenderPass({ colorAttachments: atts }).end();
  },
  glFinish__deps: ['$GLW'],
  glFinish__async: true,
  glFinish: () => Asyncify.handleAsync(async () => { GLW.flush(); await GLW.queue.onSubmittedWorkDone(); }),
  glMemoryBarrier: (bits) => {},
  glTextureBarrier: () => {},
  glBlendFunci__deps: ['$GLW'],
  glBlendFunci: (buf, src, dst) => { GLW.blend[buf] = [src, dst]; },

  // --- textures ---------------------------------------------------------------
  glCreateTextures__deps: ['$GLW'],
  glCreateTextures: (target, n, ptr) => {
    for (let i = 0; i < n; i++) {
      const name = GLW.next++;
      GLW.textures.set(name, { target, array: target === 0x8C1A, tex: null,
        minF: 0x2702, magF: 0x2601, wrapS: 0x2901, wrapT: 0x2901 });
      HEAPU32[(ptr >> 2) + i] = name;
    }
  },
  glGenTextures__deps: ['glCreateTextures'],
  glGenTextures: (n, ptr) => _glCreateTextures(0x0DE1, n, ptr),
  glDeleteTextures__deps: ['$GLW'],
  glDeleteTextures: (n, ptr) => {
    for (let i = 0; i < n; i++) {
      const name = HEAPU32[(ptr >> 2) + i];
      const t = GLW.textures.get(name);
      if (t) {
        // Commands already recorded may still use it: destroy after they run.
        const doomed = [t.tex, t.__copy0 && t.__copy0.tex].filter(Boolean);
        GLW.flush();
        GLW.queue.onSubmittedWorkDone().then(() => doomed.forEach(x => x.destroy()));
        GLW.textures.delete(name);
      }
    }
  },
  glBindTexture: (target, tex) => {},
  glTextureStorage2D__deps: ['$GLW'],
  glTextureStorage2D: (name, levels, ifmt, w, h) => {
    const t = GLW.textures.get(name);
    Object.assign(t, { w, h, depth: 1, levels, format: GLW.fmt(ifmt), glFormat: ifmt, array: false });
    GLW.makeTexture(t);
  },
  glTextureStorage3D__deps: ['$GLW'],
  glTextureStorage3D: (name, levels, ifmt, w, h, d) => {
    const t = GLW.textures.get(name);
    // Arrays (the brush tiles) are only ever sampled, so without
    // float32-filterable R16F stays a real half float.
    let format = GLW.fmt(ifmt);
    if (!GLW.filterable32 && ifmt === 0x822D) format = 'r16float';
    Object.assign(t, { w, h, depth: d, levels, format, array: true });
    GLW.makeTexture(t);
  },
  glTextureSubImage3D__deps: ['$GLW'],
  glTextureSubImage3D: (name, level, x, y, z, w, h, d, format, type, pixels) => {
    const t = GLW.textures.get(name);
    const ch = GLW.glChannels(format), n = w * h * d;
    const bytes = GLW.pack(GLW.readClient(pixels, n, ch, type), n, ch, type, t.format);
    const bpp = GLW.bpp(t.format), row = w * bpp, aligned = Math.ceil(row / 256) * 256;
    let data = bytes;
    if (aligned !== row) {
      data = new Uint8Array(aligned * h * d);
      for (let r = 0; r < h * d; r++) data.set(bytes.subarray(r * row, (r + 1) * row), r * aligned);
    }
    const st = GLW.stage(data);
    GLW.endPass();
    GLW.encoder().copyBufferToTexture({ buffer: st, bytesPerRow: aligned, rowsPerImage: h },
                                      { texture: t.tex, mipLevel: level, origin: [x, y, z] }, [w, h, d]);
  },
  glTextureSubImage2D__deps: ['glTextureSubImage3D'],
  glTextureSubImage2D: (name, level, x, y, w, h, format, type, pixels) => {
    if (!pixels && GLW.external) {
      // The page handed over a decoded frame (video, camera, image bitmap):
      // copy it straight in, skipping a trip through the wasm heap.
      const t = GLW.textures.get(name);
      GLW.flush();
      GLW.queue.copyExternalImageToTexture({ source: GLW.external }, { texture: t.tex, mipLevel: level, origin: [x, y] }, [w, h]);
      GLW.external = null;
      return;
    }
    _glTextureSubImage3D(name, level, x, y, 0, w, h, 1, format, type, pixels);
  },
  glTexImage2D: () => { throw new Error('gl_webgpu: glTexImage2D is not supported'); },
  glTextureParameteri__deps: ['$GLW'],
  glTextureParameteri: (name, pname, v) => {
    const t = GLW.textures.get(name);
    if (!t) return;
    if (pname === 0x2801) t.minF = v; else if (pname === 0x2800) t.magF = v;
    else if (pname === 0x2802) t.wrapS = v; else if (pname === 0x2803) t.wrapT = v;
  },
  glTexParameteri: () => {},
  glGenerateTextureMipmap__deps: ['$GLW'],
  glGenerateTextureMipmap: (name) => {
    const t = GLW.textures.get(name);
    if (!t || t.levels <= 1) return;
    const f = t.format;
    GLW.mip = GLW.mip || {};
    if (!GLW.mip[f]) {
      const sample = f === 'r32uint' ? 'u32' : 'f32';
      const code = `
        @group(0) @binding(0) var src: texture_2d<${sample}>;
        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
          let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
          return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
        }
        @fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
          let s = vec2i(textureDimensions(src)) - 1;
          let q = vec2i(pos.xy) * 2;
          var acc = vec4f(0.0);
          for (var j = 0; j < 2; j++) { for (var i = 0; i < 2; i++) {
            acc += vec4f(textureLoad(src, min(q + vec2i(i, j), s), 0));
          } }
          return acc * 0.25;
        }`;
      const m = GLW.device.createShaderModule({ code });
      const bgl = GLW.device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: sample === 'u32' ? 'uint' : 'unfilterable-float' } }] });
      GLW.mip[f] = { bgl, pipe: GLW.device.createRenderPipeline({
        layout: GLW.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: f }] },
        primitive: { topology: 'triangle-list' } }) };
    }
    const M = GLW.mip[f];
    GLW.endPass();
    const enc = GLW.encoder();
    for (let l = 1; l < t.levels; l++) {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: GLW.view(t, 'attach', l), loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(M.pipe);
      pass.setBindGroup(0, GLW.device.createBindGroup({ layout: M.bgl, entries: [{ binding: 0, resource: GLW.view(t, 'sampleLevel', l - 1) }] }));
      pass.draw(3);
      pass.end();
    }
  },
  glGenerateMipmap: () => {},
  glBindTextureUnit__deps: ['$GLW'],
  glBindTextureUnit: (unit, tex) => { GLW.units[unit] = tex; },
  glBindImageTexture__deps: ['$GLW'],
  glBindImageTexture: (unit, tex, level, layered, layer, access, format) => {
    GLW.images[unit] = tex ? { tex, level, access } : null;
  },
  glClearTexImage__deps: ['$GLW'],
  glClearTexImage: (name, level, format, type, data) => {
    const t = GLW.textures.get(name);
    const v = [0, 0, 0, 0];
    if (data) {
      const ch = GLW.glChannels(format), src = GLW.readClient(data, 1, ch, type);
      for (let c = 0; c < ch; c++) v[c] = type === 0x1401 ? src[c] / 255 : src[c];
    }
    GLW.endPass();
    GLW.encoder().beginRenderPass({ colorAttachments: [{ view: GLW.view(t, 'attach', level), loadOp: 'clear', storeOp: 'store',
      clearValue: { r: v[0], g: v[1], b: v[2], a: v[3] } }] }).end();
  },
  glCopyImageSubData__deps: ['$GLW'],
  glCopyImageSubData: (src, st, sl, sx, sy, sz, dst, dt, dl, dx, dy, dz, w, h, d) => {
    const a = GLW.textures.get(src), b = GLW.textures.get(dst);
    GLW.endPass();
    GLW.encoder().copyTextureToTexture({ texture: a.tex, mipLevel: sl, origin: [sx, sy, sz] },
                                       { texture: b.tex, mipLevel: dl, origin: [dx, dy, dz] }, [w, h, d]);
  },
  glGetTextureImage__deps: ['$GLW'],
  glGetTextureImage__async: true,
  glGetTextureImage: (name, level, format, type, bufSize, pixels) => Asyncify.handleAsync(async () => {
    const t = GLW.textures.get(name);
    const w = Math.max(1, t.w >> level), h = Math.max(1, t.h >> level);
    const bpp = GLW.bpp(t.format), row = w * bpp, aligned = Math.ceil(row / 256) * 256;
    const rb = GLW.device.createBuffer({ size: aligned * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    GLW.endPass();
    GLW.encoder().copyTextureToBuffer({ texture: t.tex, mipLevel: level }, { buffer: rb, bytesPerRow: aligned, rowsPerImage: h }, [w, h, 1]);
    GLW.flush();
    await rb.mapAsync(GPUMapMode.READ);
    const raw = new Uint8Array(rb.getMappedRange());
    const srcCh = GLW.channels(t.format), outCh = GLW.glChannels(format);
    const half = t.format === 'rgba16float' || t.format === 'r16float', u8 = t.format === 'rgba8unorm';
    const f32 = new Float32Array(raw.buffer), u16 = new Uint16Array(raw.buffer);
    const out = type === 0x1401 ? HEAPU8 : HEAPF32;
    const base = type === 0x1401 ? pixels : pixels >> 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < outCh; c++) {
          let v;
          if (c >= srcCh) v = c === 3 ? 1 : 0;
          else if (u8) v = raw[y * aligned + x * 4 + c] / 255;
          else if (half) v = GLW.fromHalf(u16[(y * aligned + x * bpp) / 2 + c]);
          else v = f32[(y * aligned + x * bpp) / 4 + c];
          const i = base + (y * w + x) * outCh + c;
          out[i] = type === 0x1401 ? Math.max(0, Math.min(255, Math.round(v * 255))) : v;
        }
      }
    }
    rb.unmap(); rb.destroy();
  }),

  // --- buffers ---------------------------------------------------------------
  glGenBuffers__deps: ['$GLW'],
  glGenBuffers: (n, ptr) => {
    for (let i = 0; i < n; i++) { const name = GLW.next++; GLW.buffers.set(name, { buf: null, size: 0 }); HEAPU32[(ptr >> 2) + i] = name; }
  },
  glDeleteBuffers__deps: ['$GLW'],
  glDeleteBuffers: (n, ptr) => {
    for (let i = 0; i < n; i++) {
      const name = HEAPU32[(ptr >> 2) + i], b = GLW.buffers.get(name);
      if (b && b.buf) { const doomed = b.buf; GLW.flush(); GLW.queue.onSubmittedWorkDone().then(() => doomed.destroy()); }
      GLW.buffers.delete(name);
    }
  },
  glBindBuffer__deps: ['$GLW'],
  glBindBuffer: (target, name) => { GLW.bufTarget[target] = name; },
  glBindBufferBase__deps: ['$GLW'],
  glBindBufferBase: (target, index, name) => {
    if (target === 0x90D2) GLW.ssbo[index] = name; else if (target === 0x8A11) GLW.ubo[index] = name;
    GLW.bufTarget[target] = name;
  },
  glBufferData__deps: ['$GLW'],
  glBufferData: (target, size, data, usage) => {
    const b = GLW.buffers.get(GLW.bufTarget[target]);
    if (b.buf) { const doomed = b.buf; GLW.flush(); GLW.queue.onSubmittedWorkDone().then(() => doomed.destroy()); }
    const U = GPUBufferUsage;
    b.size = size;
    b.buf = GLW.device.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16),
      usage: U.STORAGE | U.UNIFORM | U.INDIRECT | U.COPY_SRC | U.COPY_DST });
    if (data) _glNamedBufferSubData(GLW.bufTarget[target], 0, size, data);
  },
  glNamedBufferSubData__deps: ['$GLW'],
  glNamedBufferSubData: (name, offset, size, data) => {
    const b = GLW.buffers.get(name);
    const bytes = HEAPU8.slice(data, data + size);
    if (offset % 4 || size % 4) throw new Error('gl_webgpu: unaligned buffer upload');
    const st = GLW.stage(bytes);
    GLW.endPass();
    GLW.encoder().copyBufferToBuffer(st, 0, b.buf, offset, size);
  },
  glGetNamedBufferSubData__deps: ['$GLW'],
  glGetNamedBufferSubData__async: true,
  glGetNamedBufferSubData: (name, offset, size, data) => Asyncify.handleAsync(async () => {
    const b = GLW.buffers.get(name);
    const bytes = await GLW.readBuffer(b.buf, offset, size);
    HEAPU8.set(bytes, data);
  }),
  glClearNamedBufferSubData__deps: ['$GLW'],
  glClearNamedBufferSubData: (name, ifmt, offset, size, format, type, data) => {
    const b = GLW.buffers.get(name);
    GLW.endPass();
    const word = data ? HEAPU32[data >> 2] : 0;
    if (!word) { GLW.encoder().clearBuffer(b.buf, offset, size); return; }
    const pat = new Uint32Array(size / 4).fill(word);
    const st = GLW.stage(new Uint8Array(pat.buffer));
    GLW.encoder().copyBufferToBuffer(st, 0, b.buf, offset, size);
  },
  glClearNamedBufferData__deps: ['glClearNamedBufferSubData'],
  glClearNamedBufferData: (name, ifmt, format, type, data) => {
    const b = GLW.buffers.get(name);
    _glClearNamedBufferSubData(name, ifmt, 0, Math.ceil(b.size / 4) * 4, format, type, data);
  },
  glCopyNamedBufferSubData__deps: ['$GLW'],
  glCopyNamedBufferSubData: (src, dst, so, d0, size) => {
    GLW.endPass();
    GLW.encoder().copyBufferToBuffer(GLW.buffers.get(src).buf, so, GLW.buffers.get(dst).buf, d0, size);
  },

  // --- framebuffers ----------------------------------------------------------
  glCreateFramebuffers__deps: ['$GLW'],
  glCreateFramebuffers: (n, ptr) => {
    for (let i = 0; i < n; i++) { const name = GLW.next++; GLW.fbos.set(name, { att: [], drawBuffers: [0] }); HEAPU32[(ptr >> 2) + i] = name; }
  },
  glDeleteFramebuffers__deps: ['$GLW'],
  glDeleteFramebuffers: (n, ptr) => { for (let i = 0; i < n; i++) GLW.fbos.delete(HEAPU32[(ptr >> 2) + i]); },
  glBindFramebuffer__deps: ['$GLW'],
  glBindFramebuffer: (target, fbo) => {
    if (target !== 0x8CA8) GLW.drawFbo = fbo;
    if (target !== 0x8CA9) GLW.readFbo = fbo;
  },
  glNamedFramebufferTexture__deps: ['$GLW'],
  glNamedFramebufferTexture: (fbo, attachment, tex, level) => {
    // Strokes blend into every attachment, and blending 32-bit float is an
    // optional feature. Without it an R16F attachment (paint height) goes
    // back to real half floats: it is never a storage image, so nothing
    // else needs it 32-bit. Attachments are made right after the texture,
    // before anything is drawn into it.
    const t = tex && GLW.textures.get(tex);
    if (t && !GLW.blendable32 && t.glFormat === 0x822D && t.format === 'r32float') {
      t.tex.destroy();
      t.format = 'r16float';
      GLW.makeTexture(t);
    }
    GLW.fbos.get(fbo).att[attachment - 0x8CE0] = tex ? { tex, level } : null;
  },
  glNamedFramebufferDrawBuffers__deps: ['$GLW'],
  glNamedFramebufferDrawBuffers: (fbo, n, ptr) => {
    const f = GLW.fbos.get(fbo);
    f.drawBuffers = [];
    for (let i = 0; i < n; i++) f.drawBuffers.push(HEAPU32[(ptr >> 2) + i] - 0x8CE0);
  },
  glBlitNamedFramebuffer: () => { /* the page draws the window itself (web/app.js) */ },

  glGenVertexArrays: (n, ptr) => { for (let i = 0; i < n; i++) HEAPU32[(ptr >> 2) + i] = i + 1; },
  glDeleteVertexArrays: () => {},
  glBindVertexArray: () => {},

  // --- shaders and programs ----------------------------------------------------
  glCreateShader__deps: ['$GLW'],
  glCreateShader: (type) => { const name = GLW.next++; GLW.shaderObjs.set(name, { type, key: '', ok: false, log: '' }); return name; },
  glShaderSource__deps: ['$GLW'],
  glShaderSource: (sh, count, strings, lengths) => {
    // gl_util.cpp passes the shader's file name on the web (see Program::build).
    GLW.shaderObjs.get(sh).key = UTF8ToString(HEAPU32[strings >> 2]);
  },
  glCompileShader__deps: ['$GLW'],
  glCompileShader: (sh) => {
    const s = GLW.shaderObjs.get(sh);
    s.ok = !!GLW.shaders[s.key];
    s.log = s.ok ? '' : 'no translated shader for ' + s.key + '\n';
  },
  glGetShaderiv__deps: ['$GLW'],
  glGetShaderiv: (sh, pname, ptr) => {
    const s = GLW.shaderObjs.get(sh);
    HEAP32[ptr >> 2] = pname === 0x8B81 ? (s.ok ? 1 : 0) : pname === 0x8B84 ? s.log.length + 1 : 0;
  },
  glGetShaderInfoLog__deps: ['$GLW', '$stringToUTF8'],
  glGetShaderInfoLog: (sh, max, lenPtr, log) => {
    const n = stringToUTF8(GLW.shaderObjs.get(sh).log, log, max);
    if (lenPtr) HEAP32[lenPtr >> 2] = n;
  },
  glDeleteShader: () => {},
  glCreateProgram__deps: ['$GLW'],
  glCreateProgram: () => { const name = GLW.next++; GLW.programs.set(name, { shaders: [], ok: false, log: '' }); return name; },
  glAttachShader__deps: ['$GLW'],
  glAttachShader: (prog, sh) => { GLW.programs.get(prog).shaders.push(sh); },
  glDetachShader: () => {},
  glLinkProgram__deps: ['$GLW'],
  glLinkProgram: (prog) => {
    const p = GLW.programs.get(prog);
    try { p.ok = GLW.link(p); } catch (e) { p.ok = false; p.log = String(e && e.message || e); }
  },
  glGetProgramiv__deps: ['$GLW'],
  glGetProgramiv: (prog, pname, ptr) => {
    const p = GLW.programs.get(prog);
    HEAP32[ptr >> 2] = pname === 0x8B82 ? (p.ok ? 1 : 0) : pname === 0x8B84 ? (p.log || '').length + 1 : 0;
  },
  glGetProgramInfoLog__deps: ['$GLW', '$stringToUTF8'],
  glGetProgramInfoLog: (prog, max, lenPtr, log) => {
    const n = stringToUTF8(GLW.programs.get(prog).log || '', log, max);
    if (lenPtr) HEAP32[lenPtr >> 2] = n;
  },
  glDeleteProgram__deps: ['$GLW'],
  glDeleteProgram: (prog) => { GLW.programs.delete(prog); },
  glUseProgram__deps: ['$GLW'],
  glUseProgram: (prog) => { GLW.program = prog; },
  glGetUniformLocation__deps: ['$GLW'],
  glGetUniformLocation: (prog, namePtr) => {
    const p = GLW.programs.get(prog), name = UTF8ToString(namePtr);
    if (!p || !p.uniforms) return -1;
    return p.uniforms.findIndex(u => u.name === name);
  },
  $glwUniform__deps: ['$GLW'],
  $glwUniform: (loc, fn) => {
    const p = GLW.programs.get(GLW.program);
    if (!p || loc < 0 || loc >= p.uniforms.length) return;
    fn(p.blockView, p.uniforms[loc].offset);
  },
  glUniform1i__deps: ['$glwUniform'],
  glUniform1i: (loc, v) => glwUniform(loc, (d, o) => d.setInt32(o, v, true)),
  glUniform2i__deps: ['$glwUniform'],
  glUniform2i: (loc, a, b) => glwUniform(loc, (d, o) => { d.setInt32(o, a, true); d.setInt32(o + 4, b, true); }),
  glUniform1ui__deps: ['$glwUniform'],
  glUniform1ui: (loc, v) => glwUniform(loc, (d, o) => d.setUint32(o, v >>> 0, true)),
  glUniform1f__deps: ['$glwUniform'],
  glUniform1f: (loc, v) => glwUniform(loc, (d, o) => d.setFloat32(o, v, true)),
  glUniform3f__deps: ['$glwUniform'],
  glUniform3f: (loc, a, b, c) => glwUniform(loc, (d, o) => { d.setFloat32(o, a, true); d.setFloat32(o + 4, b, true); d.setFloat32(o + 8, c, true); }),

  // --- work ------------------------------------------------------------------
  glDispatchCompute__deps: ['$GLW'],
  glDispatchCompute: (x, y, z) => {
    if (!x || !y || !z) return;
    const p = GLW.programs.get(GLW.program);
    const pipe = GLW.computePipeline(p);
    const bg = GLW.bindGroup(p, null);   // may record copies, so before the pass
    const pass = GLW.computePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(x, y, z);
  },
  glDrawArraysIndirect__deps: ['$GLW'],
  glDrawArraysIndirect: (mode, offset) => {
    const p = GLW.programs.get(GLW.program);
    const f = GLW.fbos.get(GLW.drawFbo);
    if (!f) return;
    const atts = f.drawBuffers.map(i => f.att[i]);
    const texs = atts.map(a => GLW.textures.get(a.tex));
    const formats = texs.map(t => t.format);
    const topology = mode === 0x0005 ? 'triangle-strip' : 'triangle-list';
    const pipe = GLW.renderPipeline(p, formats, topology);
    const bg = GLW.bindGroup(p, atts.map(a => a.tex));
    GLW.endPass();
    const pass = GLW.encoder().beginRenderPass({ colorAttachments: atts.map((a, i) => ({
      view: GLW.view(texs[i], 'attach', a.level), loadOp: 'load', storeOp: 'store' })) });
    const aw = Math.max(1, texs[0].w >> atts[0].level), ah = Math.max(1, texs[0].h >> atts[0].level);
    // GL rectangles count rows from the bottom; WebGPU's from the top. With
    // clip-space y flipped in the shaders, row k of the texture is GL row k,
    // so the rectangle maps across unchanged.
    const [vx, vy, vw, vh] = GLW.viewport;
    pass.setViewport(vx, vy, Math.min(vw, aw - vx), Math.min(vh, ah - vy), 0, 1);
    if (GLW.caps.scissor) {
      const [sx, sy, sw, sh] = GLW.scissor;
      const x0 = Math.max(0, sx), y0 = Math.max(0, sy);
      pass.setScissorRect(x0, y0, Math.max(0, Math.min(aw, sx + sw) - x0), Math.max(0, Math.min(ah, sy + sh) - y0));
    }
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bg);
    pass.drawIndirect(GLW.buffers.get(GLW.bufTarget[0x8F3F]).buf, offset);
    pass.end();
  },

  // --- queries ---------------------------------------------------------------
  // GPU timing is not exposed to the page here: every query reads as an
  // available zero, so the pipeline's per-stage timers report 0 ms. The page
  // measures whole frames itself.
  glGenQueries: (n, ptr) => { for (let i = 0; i < n; i++) HEAPU32[(ptr >> 2) + i] = i + 1; },
  glDeleteQueries: () => {},
  glBeginQuery: () => {},
  glEndQuery: () => {},
  glQueryCounter: () => {},
  glGetQueryObjectiv: (id, pname, ptr) => { HEAP32[ptr >> 2] = pname === 0x8867 ? 1 : 0; },
  glGetQueryObjectui64v: (id, pname, ptr) => { HEAPU32[ptr >> 2] = 0; HEAPU32[(ptr >> 2) + 1] = 0; },
});
