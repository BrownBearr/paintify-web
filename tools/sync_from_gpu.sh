#!/usr/bin/env bash
# Pulls the shared painter (renderer, styles, look files, shaders, fonts)
# from a paintify-GPU checkout, so a fix made there reaches the web app.
#   tools/sync_from_gpu.sh ../paintify-GPU
set -euo pipefail
GPU=${1:?usage: tools/sync_from_gpu.sh <paintify-GPU checkout>}
cd "$(dirname "$0")/.."
for f in pipeline gl_util brush_atlas styles paramfile; do cp "$GPU/src/$f.cpp" src/; done
for f in pipeline gl_util brush_atlas styles paramfile params style gl_subset; do cp "$GPU/src/$f.h" src/; done
rm -rf shaders && cp -r "$GPU/shaders" shaders
cp "$GPU"/assets/fonts/* assets/fonts/
cp "$GPU/assets/icon/paintify.png" assets/icon/
echo "synced from $GPU ($(git -C "$GPU" rev-parse --short HEAD 2>/dev/null || echo unknown))"
git status --short
