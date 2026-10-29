# Building Paintify for the web

Paintify for the web is a C++ painter compiled to WebAssembly. `pipeline.cpp`, the style registry and the look files build unchanged with Emscripten; underneath them, `web/gl_webgpu.js` implements the GL subset the renderer uses (`src/gl_subset.h`) on WebGPU. The GLSL shaders are translated ahead of time to WGSL by `web/tools/build_shaders.mjs` (glslang to SPIR-V, then naga), with a bind-group slot table that both sides share. The page (`web/index.html`, `app.js`, `display.js`) owns the window: sources (image, video, camera), the view, the settings panel, PNG export and recording with MediaRecorder.

Build it with emsdk, glslang, SPIRV-Cross and naga on PATH:

    sudo apt install glslang-tools spirv-cross      # or: brew install glslang spirv-cross
    cargo install naga-cli --version 30.0.1 --locked
    git clone https://github.com/emscripten-core/emsdk ~/emsdk
    ~/emsdk/emsdk install 6.0.13 && ~/emsdk/emsdk activate 6.0.13 && source ~/emsdk/emsdk_env.sh
    web/build.sh                     # writes web/dist
    python3 -m http.server -d web/dist 8000

Then open http://localhost:8000 in Chrome, Edge or Safari 26. Any WebGPU adapter works. The optional `float32-blendable` and `float32-filterable` features are used when present; without them (some browsers hide them, Brave among them) paint height is blended in half floats and 32-bit textures are sampled through half-float copies. `?basic` turns them off to test that path.

Where the web layer differs from GL, and why:

- `R16F` and `RG16F` textures are stored as 32-bit float, because half-float storage textures are optional in WebGPU.
- The three read-write `rgba16f` images (flat, impasto, post) read from a copy taken just before each dispatch. Every one of them reads only the texel its own invocation writes, so the result is the same.
- A texture that a pass both samples and writes is sampled from a copy, since WebGPU forbids that within one pass.
- Read-backs (stroke counters, `glGetTextureImage`) suspend the C++ caller with Asyncify while the GPU catches up, so to the pipeline they block, as on GL.
- GPU timer queries read as zero; the page times whole frames itself.

`web/test/run.mjs` paints `assets/sample.jpg` with every brush in headless Chromium on SwiftShader; against the same renderer on Linux OpenGL, stroke counts agree within about 1% and mean brightness and contrast within 0.3/255. `web/test/ui.mjs` walks through the app (under `xvfb-run` on Linux). CI (`.github/workflows/web.yml`) runs both and, from main, publishes `web/dist` to the `gh-pages` branch that GitHub Pages serves.

`node --test web/test/video-export.mjs` covers encoder/MIME negotiation, aborts, seek timeouts and backpressure. `node web/test/regression.mjs` checks smoothing retention and original/current saved-look compatibility. UI checks include mobile/light/dark screenshots, capability failure, export cancellation, source locks and decoding a downloaded MP4 to a nonblack frame. CI uploads `web-test-output` and the built `paintify-web-preview`; pull requests do not publish to Pages.

The original 260-float style layout is unchanged. See `system_architecture.md` for smoothing, export lifecycle and format contracts.
