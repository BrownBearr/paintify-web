// The browser build's entry points: the shared painter (Pipeline, the style
// registry, look files) behind a small C API that web/app.js drives. The page
// owns everything a desktop shell would: the window, the controls, decoding
// images and video, and drawing the result.
//
// Painting calls can wait on the GPU (render reads its stroke counters back),
// so the page calls them through ccall with {async: true}; ASYNCIFY suspends
// the C++ stack while a read-back is in flight.
#include "paramfile.h"
#include "pipeline.h"
#include "styles.h"

#include <emscripten/emscripten.h>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

namespace {

Pipeline g_pipe;
TuningParams g_params;
RenderConfig g_cfg;
StyleParams g_style;
int g_styleIdx = 0;
bool g_tensorOn = false;
bool g_ready = false;
std::string g_text;   // backing store for strings handed to the page

// A setting the page can read and write by name. Names follow the desktop
// panel's groups: p. = TuningParams, s. = StyleParams, c. = RenderConfig.
struct Field {
    const char* key;
    enum Kind { Tuning, Style, CfgFloat, CfgInt } kind;
    size_t offset;
};

#define P(f) {"p." #f, Field::Tuning, offsetof(TuningParams, f)}
#define S(f) {"s." #f, Field::Style, offsetof(StyleParams, f)}
#define CF(f) {"c." #f, Field::CfgFloat, offsetof(RenderConfig, f)}
#define CI(f) {"c." #f, Field::CfgInt, offsetof(RenderConfig, f)}
const Field kFields[] = {
    // Strokes
    P(threshold), P(gridFactor), P(minStrokeLength), P(maxStrokeLength), P(curvature),
    P(sizeJitter), P(angleJitter), P(tensorSigma), P(etfRadius),
    P(relaxAreaWeight), P(relaxMoveScale), P(relaxCandidates), P(relaxRemove),
    // Colour
    P(opacity), P(jitterHue), P(jitterSat), P(jitterVal), P(opacityJitter),
    // Classic tile brush and relief
    P(texStrength), P(texTaper), P(dryBrush), P(impastoStrength), P(impastoLight), P(lightAngle),
    // Video
    P(frameDiffThreshold), P(jitterPerFrame),
    // Brush (era brushes)
    S(widthScale), S(bristles), S(load), S(impasto), S(bristleClump), S(bristleContrast),
    S(dryout), S(dryTooth), S(edgeRough), S(endJag), S(ridge), S(groove), S(pickup), S(smear),
    // Direction
    S(fieldMode), S(fieldMix), S(perturb), S(autoVortex), S(vortexSpiral), S(vortexRadius),
    // Colour (look)
    S(saturation), S(warmCool), S(labJitterL), S(labJitterAB), S(palettePull), S(paletteCount),
    // Ground and finish
    S(groundMode), S(underOpacity), S(finish), S(impastoLight), S(reliefScale), S(specular),
    S(weave), S(varnish), S(crackle), S(vignette), S(licStrength), S(contour), S(rain),
    S(brushModel), S(enabled),
    S(experimentEnabled), S(experimentMode), S(experimentScale), S(experimentStrength),
    CF(bristleDensity), CF(freshPaint),
    CI(etfIterations), CI(relaxIterations), CI(flowLevels), CI(flowIterations), CI(passesPerLayer),
};
#undef P
#undef S
#undef CF
#undef CI

float* floatField(const Field& f) {
    switch (f.kind) {
        case Field::Tuning: return reinterpret_cast<float*>(reinterpret_cast<char*>(&g_params) + f.offset);
        case Field::Style: return reinterpret_cast<float*>(reinterpret_cast<char*>(&g_style) + f.offset);
        case Field::CfgFloat: return reinterpret_cast<float*>(reinterpret_cast<char*>(&g_cfg) + f.offset);
        default: return nullptr;
    }
}

const Field* findField(const char* key) {
    for (const Field& f : kFields)
        if (std::strcmp(f.key, key) == 0) return &f;
    return nullptr;
}

std::string jsonEscape(const char* s) {
    std::string o;
    for (; *s; ++s) {
        if (*s == '"' || *s == '\\') o += '\\';
        o += *s;
    }
    return o;
}

// The desktop app's restyle(): a brush choice resets the brush mark only.
void restyle() {
    styles::applyBrushTexture(g_styleIdx, g_style);
    g_pipe.setStyle(g_style);
    g_pipe.resetTemporal();
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE int pfy_init() {
    if (g_ready) return 1;
    if (!g_pipe.init()) return 0;
    g_cfg.radii = paramfile::parseRadii("8,4,2");
    restyle();
    g_ready = true;
    return 1;
}

// [{key, name, era, years, artists, summary}, ...] in registry order; index 0
// is the original tile brush.
EMSCRIPTEN_KEEPALIVE const char* pfy_styles() {
    g_text = "[";
    const auto& list = styles::list();
    for (size_t i = 0; i < list.size(); ++i) {
        const styles::Info& s = list[i];
        if (i) g_text += ",";
        g_text += "{\"key\":\"" + jsonEscape(s.key) + "\",\"name\":\"" + jsonEscape(s.name) +
                  "\",\"era\":\"" + jsonEscape(s.era) + "\",\"years\":\"" + jsonEscape(s.years) +
                  "\",\"artists\":\"" + jsonEscape(s.artists) + "\",\"summary\":\"" +
                  jsonEscape(s.summary) + "\"}";
    }
    g_text += "]";
    return g_text.c_str();
}

// RGBA8, top row first. A null `rgba` means the page has staged a decoded
// frame for the WebGPU layer to copy in directly (see gl_webgpu.js).
EMSCRIPTEN_KEEPALIVE int pfy_set_source(const unsigned char* rgba, int w, int h) {
    return g_pipe.setSource(rgba, w, h) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void pfy_set_style(int index) {
    g_styleIdx = std::clamp(index, 0, int(styles::list().size()) - 1);
    restyle();
}
EMSCRIPTEN_KEEPALIVE int pfy_style() { return g_styleIdx; }

// Brush defaults for the current style, for a field's reset value.
EMSCRIPTEN_KEEPALIVE float pfy_style_default(const char* key) {
    const Field* f = findField(key);
    if (!f || f->kind != Field::Style) return NAN;
    StyleParams d;
    styles::applyBrushTexture(g_styleIdx, d);
    return *reinterpret_cast<float*>(reinterpret_cast<char*>(&d) + f->offset);
}

EMSCRIPTEN_KEEPALIVE float pfy_get(const char* key) {
    if (std::strcmp(key, "tensorOn") == 0) return g_tensorOn ? 1.f : 0.f;
    if (std::strcmp(key, "c.underpaint") == 0) return float(int(g_cfg.underpaint));
    const Field* f = findField(key);
    if (!f) return NAN;
    if (f->kind == Field::CfgInt)
        return float(*reinterpret_cast<int*>(reinterpret_cast<char*>(&g_cfg) + f->offset));
    return *floatField(*f);
}

EMSCRIPTEN_KEEPALIVE int pfy_set(const char* key, float v) {
    if (std::strcmp(key, "tensorOn") == 0) {
        g_tensorOn = v > 0.5f;
        if (g_tensorOn && g_params.tensorSigma <= 0.f) g_params.tensorSigma = 0.5f;
        return 1;
    }
    if (std::strcmp(key, "c.underpaint") == 0) {
        g_cfg.underpaint = Underpaint(std::clamp(int(v), 0, 2));
        return 1;
    }
    const Field* f = findField(key);
    if (!f) return 0;
    if (f->kind == Field::CfgInt)
        *reinterpret_cast<int*>(reinterpret_cast<char*>(&g_cfg) + f->offset) = int(std::lround(v));
    else
        *floatField(*f) = v;
    if (f->kind == Field::Style) g_pipe.setStyle(g_style);
    if (std::strcmp(key, "p.frameDiffThreshold") == 0) g_pipe.resetTemporal();
    return 1;
}

EMSCRIPTEN_KEEPALIVE void pfy_set_radii(const char* text) {
    std::vector<float> r = paramfile::parseRadii(text);
    if (!r.empty()) g_cfg.radii = r;
    g_cfg.layerSpecs.clear();
}
EMSCRIPTEN_KEEPALIVE const char* pfy_radii() {
    g_text = paramfile::radiiToString(g_cfg.radii);
    return g_text.c_str();
}
EMSCRIPTEN_KEEPALIVE int pfy_layer_specs() { return int(g_cfg.layerSpecs.size()); }
EMSCRIPTEN_KEEPALIVE void pfy_clear_layer_specs() { g_cfg.layerSpecs.clear(); }

// Paints when anything that reaches the canvas changed; returns whether it
// did. `temporal` (video playing with steady strokes) always paints.
EMSCRIPTEN_KEEPALIVE int pfy_render(int temporal) {
    if (!g_ready || g_pipe.width() <= 0) return 0;
    TuningParams renderParams = g_params;
    renderParams.tensorSigma = g_tensorOn ? std::max(0.5f, g_params.tensorSigma) : 0.f;
    const bool painted = g_pipe.renderIfChanged(renderParams, g_cfg, temporal != 0);
    g_params.frame += 1.f;
    // The stroke counters normally arrive a frame late; a still is painted
    // once, so fetch its own numbers now.
    if (painted && !temporal) g_pipe.refreshStats();
    return painted ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void pfy_reset_temporal() { g_pipe.resetTemporal(); }

// The GL texture names the page draws: the painting and the source.
EMSCRIPTEN_KEEPALIVE unsigned pfy_output_texture() { return g_pipe.outputTexture(); }
EMSCRIPTEN_KEEPALIVE int pfy_width() { return g_pipe.width(); }
EMSCRIPTEN_KEEPALIVE int pfy_height() { return g_pipe.height(); }

// The finished painting as RGBA8, top row first, in a malloc'd buffer the
// page frees with _free.
EMSCRIPTEN_KEEPALIVE unsigned char* pfy_read_canvas() {
    std::vector<unsigned char> px = g_pipe.readCanvas();
    unsigned char* out = static_cast<unsigned char*>(std::malloc(px.size()));
    if (out) std::memcpy(out, px.data(), px.size());
    return out;
}

EMSCRIPTEN_KEEPALIVE const char* pfy_stats() {
    char buf[256];
    std::snprintf(buf, sizeof(buf),
                  "{\"strokes\":%u,\"drawn\":%u,\"meanPoints\":%.2f,\"renders\":%llu}",
                  g_pipe.lastStrokeCount(), g_pipe.lastDrawnCount(), g_pipe.lastMeanPoints(),
                  (unsigned long long)g_pipe.renderCount());
    g_text = buf;
    return g_text.c_str();
}

// Looks (.sbr) go through the same reader and writer as the desktop app, via
// a scratch file in the in-memory file system.
EMSCRIPTEN_KEEPALIVE const char* pfy_save_look() {
    const char* path = "/tmp/look.sbr";
    std::string err;
    if (!paramfile::save(path, g_params, g_cfg, &err, &g_style, styles::list()[size_t(g_styleIdx)].key))
        return "";
    FILE* f = std::fopen(path, "rb");
    g_text.clear();
    if (f) {
        char buf[4096];
        size_t n;
        while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) g_text.append(buf, n);
        std::fclose(f);
    }
    // Keep the browser-only smoothing switch independent from its retained
    // amount. Desktop readers ignore this ordinary paramfile comment.
    g_text.insert(0, g_tensorOn ? "# paintify-tensor-on=1\n" : "# paintify-tensor-on=0\n");
    return g_text.c_str();
}

// Returns "" on success, else the reason.
EMSCRIPTEN_KEEPALIVE const char* pfy_load_look(const char* text) {
    const char* path = "/tmp/look.sbr";
    FILE* f = std::fopen(path, "wb");
    if (!f) return "cannot write scratch file";
    std::fwrite(text, 1, std::strlen(text), f);
    std::fclose(f);
    std::string err, key;
    bool withStyle = false;
    StyleParams st = g_style;
    if (!paramfile::load(path, &g_params, &g_cfg, &err, &st, &key, &withStyle)) {
        g_text = err.empty() ? "could not read the look" : err;
        return g_text.c_str();
    }
    if (withStyle) {
        g_style = st;
        g_styleIdx = std::max(0, styles::indexOf(key));
    } else {
        g_cfg.layerSpecs.clear();
        g_styleIdx = 0;
        g_style = StyleParams{};
        styles::applyBrushTexture(0, g_style);
    }
    // Older looks have no web metadata, so retain their historical behavior.
    // New web looks can keep an amount while explicitly saving the switch off.
    const std::string contents(text);
    const std::string enabled = "# paintify-tensor-on=1";
    const std::string disabled = "# paintify-tensor-on=0";
    bool foundTensorSwitch = false;
    size_t lineStart = 0;
    while (lineStart < contents.size()) {
        const size_t lineEnd = contents.find('\n', lineStart);
        const size_t length = (lineEnd == std::string::npos ? contents.size() : lineEnd) - lineStart;
        const std::string line = contents.substr(lineStart, length);
        if (line == enabled) { g_tensorOn = true; foundTensorSwitch = true; break; }
        if (line == disabled) { g_tensorOn = false; foundTensorSwitch = true; break; }
        if (lineEnd == std::string::npos) break;
        lineStart = lineEnd + 1;
    }
    if (!foundTensorSwitch) g_tensorOn = g_params.tensorSigma > 0.f;
    if (g_tensorOn && g_params.tensorSigma <= 0.f) g_params.tensorSigma = 0.5f;
    g_pipe.setStyle(g_style);
    g_pipe.resetTemporal();
    g_text.clear();
    return g_text.c_str();
}

} // extern "C"
