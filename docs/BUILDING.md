# Building Paintify for the web

Paintify for the web is the painter from [paintify-GPU](https://github.com/BrownBearr/paintify-GPU) compiled to WebAssembly. `pipeline.cpp`, the style registry and the look files build unchanged with Emscripten; underneath them, `web/gl_webgpu.js` implements the GL subset the renderer uses (`src/gl_subset.h`, shared with the Mac port's Metal layer) on WebGPU. The GLSL shaders are translated ahead of time to WGSL by `web/tools/build_shaders.mjs` (glslang to SPIR-V, then naga), with a bind-group slot table that both sides share. The page (`web/index.html`, `app.js`, `display.js`) owns the window: sources (image, video, camera), the view, the settings panel, PNG export and recording with MediaRecorder.

Build it with emsdk, glslang, SPIRV-Cross and naga on PATH:

    sudo apt install glslang-tools spirv-cross      # or: brew install glslang spirv-cross
    cargo install naga-cli --version 30.0.1 --locked
    git clone https://github.com/emscripten-core/emsdk ~/emsdk
    ~/emsdk/emsdk install 6.0.13 && ~/emsdk/emsdk activate 6.0.13 && source ~/emsdk/emsdk_env.sh
    web/build.sh                     # writes web/dist
    python3 -m http.server -d web/dist 8000

Then open http://localhost:8000 in Chrome, Edge or Safari 26. A WebGPU adapter with the `float32-blendable` feature is required (every desktop GPU has it).

Where the web layer differs from GL, and why:

- `R16F` and `RG16F` textures are stored as 32-bit float, because half-float storage textures are optional in WebGPU.
- The three read-write `rgba16f` images (flat, impasto, post) read from a copy taken just before each dispatch. Every one of them reads only the texel its own invocation writes, so the result is the same.
- A texture that a pass both samples and writes is sampled from a copy, since WebGPU forbids that within one pass.
- Read-backs (stroke counters, `glGetTextureImage`) suspend the C++ caller with Asyncify while the GPU catches up, so to the pipeline they block, as on GL.
- GPU timer queries read as zero; the page times whole frames itself.

`web/test/run.mjs` paints `assets/sample.jpg` with every brush in headless Chromium on SwiftShader; against the desktop build on Linux OpenGL, stroke counts agree within about 1% and mean brightness and contrast within 0.3/255. `web/test/ui.mjs` walks through the app (under `xvfb-run` on Linux). CI (`.github/workflows/web.yml`) runs both and publishes `web/dist` to GitHub Pages from main.

## Keeping in step with paintify-GPU

`src/` (except `src/web/`), `shaders/` and `assets/fonts/` are copies of paintify-GPU's. After a change there, bring it across and rebuild:

    tools/sync_from_gpu.sh ../paintify-GPU
    web/build.sh
