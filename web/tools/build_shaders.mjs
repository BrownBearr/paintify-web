// Translates shaders/*.comp|vert|frag (GL 4.6 GLSL) into WGSL for the web
// build, with the reflection the WebGPU layer needs to bind them.
//
//   GLSL --(binding rewrite, combined samplers split)--> Vulkan GLSL
//        --glslangValidator--> SPIR-V --naga--> WGSL
//
// Everything lives in bind group 0. GL's per-type binding numbers overlap
// (sampler 0, image 0 and SSBO 0 can coexist), so each type gets its own
// range: see SLOT below. web/gl_webgpu.js uses the same table.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SLOT = { storage: 0, uniform: 16, defaultBlock: 20, texture: 24, sampler: 40, image: 56,
               readTexture: 72, readSampler: 88 };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shaderDir = path.join(root, 'shaders');
const outFile = process.argv[2] || path.join(root, 'web/build/shaders.json');
const glslang = process.env.GLSLANG || 'glslangValidator';
const naga = process.env.NAGA || 'naga';
const spirvCross = process.env.SPIRV_CROSS || 'spirv-cross';

function splice(name) {
  const src = fs.readFileSync(path.join(shaderDir, name), 'utf8');
  return src.split('\n').map(line => {
    const m = /^\s*#include\s+"([^"]+)"/.exec(line);
    return m ? fs.readFileSync(path.join(shaderDir, m[1]), 'utf8') : line;
  }).join('\n');
}

// GL binding numbers -> group 0 slots, and sampler2D -> texture + sampler.
function rewrite(src, res) {
  const readCopies = [];
  // Storage images: layout(fmt, binding = N) uniform [qualifiers] image2D name
  src = src.replace(/layout\s*\(([^)]*)\)\s*uniform\s+((?:(?:readonly|writeonly|restrict|coherent|volatile)\s+)*)(image2D|image2DArray|uimage2D|iimage2D)\s+(\w+)\s*;/g,
    (all, lay, quals, type, name) => {
      const b = +/binding\s*=\s*(\d+)/.exec(lay)[1];
      const fmt = /(rgba16f|rgba32f|rg16f|rg32f|r16f|r32f|r32ui|rgba8)/.exec(lay)[1];
      const access = /writeonly/.test(quals) ? 'write' : /readonly/.test(quals) ? 'read' : 'read_write';
      res.push({ kind: 'image', gl: b, slot: SLOT.image + b, name, format: fmt, access });
      // Half-float single and dual channel storage is an optional WebGPU
      // feature; the web build stores those textures as 32-bit float.
      let lay2 = lay.replace(/binding\s*=\s*\d+/, `set = 0, binding = ${SLOT.image + b}`)
                    .replace(/\br16f\b/, 'r32f').replace(/\brg16f\b/, 'rg32f');
      if (access !== 'read_write') return `layout(${lay2}) uniform ${quals}${type} ${name};`;
      // Read-write rgba16f storage is optional too. Every read-write image
      // here only ever reads the texel its own invocation writes, so the
      // reads can come from a copy taken just before the dispatch.
      readCopies.push(name);
      res.push({ kind: 'imagecopy', gl: b, slot: SLOT.readTexture + b, samplerSlot: SLOT.readSampler + b, name });
      return `layout(${lay2}) uniform writeonly ${quals}${type} ${name};\n` +
             `layout(set = 0, binding = ${SLOT.readTexture + b}) uniform texture2D ${name}_rt;\n` +
             `layout(set = 0, binding = ${SLOT.readSampler + b}) uniform sampler ${name}_rs;`;
    });
  for (const n of readCopies)
    src = src.replace(new RegExp(`\\bimageLoad\\s*\\(\\s*${n}\\s*,`, 'g'), `texelFetch(sampler2D(${n}_rt, ${n}_rs), 0 + `)
             .replace(new RegExp(`texelFetch\\(sampler2D\\(${n}_rt, ${n}_rs\\), 0 \\+ ([^;]*?)\\)`, 'g'), `texelFetch(sampler2D(${n}_rt, ${n}_rs), $1, 0)`);
  // Combined samplers become a texture and a sampler; a macro rebuilds the
  // combined type at every use so the shader bodies stay untouched.
  src = src.replace(/layout\s*\(\s*binding\s*=\s*(\d+)\s*\)\s*uniform\s+(sampler2D|sampler2DArray|usampler2D|isampler2D)\s+(\w+)\s*;/g,
    (all, b, type, name) => {
      b = +b;
      const tex = type.replace('sampler', 'texture');
      res.push({ kind: 'sampler', gl: b, slot: SLOT.texture + b, samplerSlot: SLOT.sampler + b, name,
                 array: type === 'sampler2DArray' });
      return `layout(set = 0, binding = ${SLOT.texture + b}) uniform ${tex} ${name}_t;\n` +
             `layout(set = 0, binding = ${SLOT.sampler + b}) uniform sampler ${name}_s;\n` +
             `#define ${name} ${type}(${name}_t, ${name}_s)`;
    });
  // SSBOs and UBOs: layout(std430|std140, binding = N) ... buffer|uniform Name
  src = src.replace(/layout\s*\(\s*(std430|std140)\s*,\s*binding\s*=\s*(\d+)\s*\)\s*((?:(?:readonly|writeonly|restrict|coherent)\s+)*)(buffer|uniform)\s+(\w+)/g,
    (all, std, b, quals, kw, name) => {
      b = +b;
      const kind = kw === 'buffer' ? 'storage' : 'uniform';
      const slot = (kind === 'storage' ? SLOT.storage : SLOT.uniform) + b;
      res.push({ kind, gl: b, slot, name, readonly: /readonly/.test(quals) });
      // WGSL storage buffers are read or read_write; there is no write-only.
      quals = quals.replace(/writeonly\s+/, '');
      return `layout(${std}, set = 0, binding = ${slot}) ${quals}${kw} ${name}`;
    });
  return splitSamplerParams(src, new Set(res.filter(r => r.kind === 'sampler').map(r => r.name)));
}

// A sampler cannot be passed to a user function once it is a constructed
// texture+sampler pair (and naga cannot read image parameters anyway), so a
// function with sampler parameters is specialised per call: one copy for each
// combination of samplers it is called with, the parameters dropped and the
// global sampler named directly in the body.
function splitSamplerParams(src, samplers) {
  const fnRe = /\b(\w+)\s*\(([^()]*\bsampler2D(?:Array)?\s+\w+[^()]*)\)\s*\{/;
  let m;
  while ((m = fnRe.exec(src))) {
    const name = m[1];
    const params = m[2].split(',').map(x => x.trim());
    const sp = params.map(prm => (/^(?:in\s+)?sampler2D(?:Array)?\s+(\w+)$/.exec(prm) || [])[1]);
    const open = m.index + m[0].length - 1;
    let depth = 0, close = open;
    for (; close < src.length; close++) {
      if (src[close] === '{') depth++;
      else if (src[close] === '}' && --depth === 0) break;
    }
    const ret = /(\w+)\s*$/.exec(src.slice(0, m.index).replace(/\s+$/, ''))[1];
    const retStart = src.lastIndexOf(ret, m.index);
    const body = src.slice(open, close + 1);
    let rest = src.slice(close + 1);
    const copies = new Map();
    rest = rest.replace(new RegExp(`\\b${name}\\s*\\(((?:[^()]|\\([^()]*\\))*)\\)`, 'g'), (all, args) => {
      const parts = []; let d = 0, cur = '';
      for (const ch of args) {
        if (ch === ',' && d === 0) { parts.push(cur); cur = ''; continue; }
        if (ch === '(') d++; if (ch === ')') d--;
        cur += ch;
      }
      parts.push(cur);
      const bound = sp.map((p, i) => p ? parts[i].trim() : null);
      if (bound.some((b, i) => sp[i] && !samplers.has(b))) throw new Error(`${name}: sampler argument is not a global sampler`);
      const key = `${name}_${bound.filter(Boolean).join('_')}`;
      if (!copies.has(key)) {
        let bd = body;
        sp.forEach((p, i) => { if (p) bd = bd.replace(new RegExp(`\\b${p}\\b`, 'g'), bound[i]); });
        const keep = params.filter((_, i) => !sp[i]);
        copies.set(key, `${ret} ${key}(${keep.join(', ')}) ${bd}`);
      }
      return `${key}(${parts.filter((_, i) => !sp[i]).join(',')})`;
    });
    src = src.slice(0, retStart) + [...copies.values()].join('\n') + rest;
  }
  return src;
}

function translate(file) {
  const ext = path.extname(file).slice(1);
  const stage = { comp: 'compute', vert: 'vertex', frag: 'fragment' }[ext];
  const res = [];
  const glsl = rewrite(splice(file), res);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pfy-'));
  const src = path.join(tmp, `s.${ext}`), spv = path.join(tmp, 's.spv');
  fs.writeFileSync(src, glsl);
  const args = ['-V', '-R', '--target-env', 'vulkan1.1', '--aml',
                '--sdub', 'DefaultUniforms', '0', String(SLOT.defaultBlock), '-o', spv, src];
  if (stage === 'vertex') args.splice(0, 0, '--iy');
  try { execFileSync(glslang, args, { stdio: 'pipe' }); }
  catch (e) { throw new Error(`${file}: glslang\n${e.stdout}${e.stderr}`); }

  // Default-block layout (loose uniforms) from SPIRV-Cross reflection.
  const refl = JSON.parse(execFileSync(spirvCross, [spv, '--reflect'], { encoding: 'utf8' }));
  const uniforms = [];
  let blockSize = 0;
  for (const u of refl.ubos || []) {
    if (u.binding !== SLOT.defaultBlock) continue;
    blockSize = u.block_size;
    const t = refl.types[u.type];
    for (const m of t.members) uniforms.push({ name: m.name, offset: m.offset, type: m.type });
  }
  let localSize = [1, 1, 1];
  if (stage === 'compute') {
    const ep = refl.entryPoints[0];
    if (ep.workgroup_size) localSize = ep.workgroup_size;
  }

  const wgslPath = path.join(tmp, 's.wgsl');
  try { execFileSync(naga, [spv, wgslPath], { stdio: 'pipe' }); }
  catch (e) { throw new Error(`${file}: naga\n${e.stdout}${e.stderr}`); }
  const wgsl = fs.readFileSync(wgslPath, 'utf8');
  // Every binding the WGSL declares, used or not: the WebGPU layer builds an
  // explicit layout from these, so an unused declaration is harmless.
  const bindings = [];
  for (const m of wgsl.matchAll(/@group\(0\) @binding\((\d+)\)\s*var(?:<([^>]*)>)?\s+\w+\s*:\s*([^;]+);/g)) {
    const binding = +m[1], space = m[2] || '', type = m[3].trim();
    let b;
    if (space.startsWith('storage')) b = { type: /read_write/.test(space) ? 'storage' : 'read-only-storage' };
    else if (space === 'uniform') b = { type: 'uniform' };
    else if (type === 'sampler') b = { type: 'sampler' };
    else if (type.startsWith('texture_storage_2d')) {
      const f = /<(\w+),\s*(\w+)>/.exec(type);
      b = { type: 'storageTexture', format: f[1], access: { write: 'write-only', read: 'read-only', read_write: 'read-write' }[f[2]] };
    } else if (type.startsWith('texture_2d_array')) b = { type: 'texture', dim: '2d-array', sample: /u32/.test(type) ? 'uint' : 'float' };
    else if (type.startsWith('texture_2d')) b = { type: 'texture', dim: '2d', sample: /u32/.test(type) ? 'uint' : 'float' };
    else throw new Error(`${file}: unhandled binding type ${type}`);
    bindings.push({ binding, ...b });
  }
  if (blockSize) res.push({ kind: 'default', gl: 0, slot: SLOT.defaultBlock, name: 'DefaultUniforms' });
  fs.rmSync(tmp, { recursive: true, force: true });
  return { stage, wgsl, bindings, resources: res, uniforms, uniformBlockSize: Math.ceil(blockSize / 16) * 16, localSize };
}

const out = {};
let failed = 0;
for (const f of fs.readdirSync(shaderDir).sort()) {
  if (!/\.(comp|vert|frag)$/.test(f)) continue;
  try { out[f] = translate(f); console.log(`ok   ${f}`); }
  catch (e) { failed++; console.error(`FAIL ${e.message}`); }
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out));
if (failed) process.exit(1);
