#!/usr/bin/env bash
# Builds the browser version into web/dist: the painter compiled to
# WebAssembly, the shaders translated to WGSL, and the page itself.
# Needs emsdk (em++), glslangValidator, spirv-cross and naga on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=web/dist
mkdir -p "$OUT"

node web/tools/build_shaders.mjs "$OUT/shaders.json"

FLAGS=(-O2 -std=c++17 -Isrc -DSBR_ROOT_DIR=\"/\")
SRCS=(src/web/main_web.cpp src/pipeline.cpp src/gl_util.cpp src/brush_atlas.cpp
      src/styles.cpp src/paramfile.cpp)
em++ "${FLAGS[@]}" "${SRCS[@]}" -o "$OUT/paintify.js" \
  --js-library web/gl_webgpu.js \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPaintify -sENVIRONMENT=web \
  -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=65536 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sSTACK_SIZE=1MB \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=ccall,UTF8ToString,stringToUTF8,HEAPU8 \
  -sINCOMING_MODULE_JS_API=print,printErr,locateFile,preRun,onAbort \
  -sEXPORT_KEEPALIVE=1

shopt -s nullglob
for f in web/*.html web/*.js web/*.css; do
  case "$f" in web/gl_webgpu.js) ;; *) cp "$f" "$OUT/" ;; esac
done
cp assets/icon/paintify.png "$OUT/"
mkdir -p "$OUT/vendor" && cp web/vendor/* "$OUT/vendor/"
mkdir -p "$OUT/media" "$OUT/fonts"
cp web/media/* "$OUT/media/"
cp assets/sample.jpg "$OUT/media/landscape.jpg"
cp assets/fonts/*.ttf assets/fonts/*.txt "$OUT/fonts/"
echo "built $OUT"
