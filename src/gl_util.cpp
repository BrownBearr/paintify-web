#include "gl_util.h"

#include <cstdio>
#include <cstring>
#include <sys/stat.h>
#include <filesystem>
#ifdef _WIN32
#include <windows.h>
#endif
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

namespace glu {

static std::string readFile(const std::string& path, bool* ok) {
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) { *ok = false; return std::string(); }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    std::string s(static_cast<size_t>(n < 0 ? 0 : n), ' ');
    size_t got = fread(&s[0], 1, s.size(), f);
    s.resize(got);
    fclose(f);
    *ok = true;
    return s;
}

static int64_t fileMTime(const std::string& path) {
#ifdef _WIN32
    struct _stat64 st;
    if (_stat64(path.c_str(), &st) != 0) return 0;
#else
    struct stat st;
    if (stat(path.c_str(), &st) != 0) return 0;
#endif
    return static_cast<int64_t>(st.st_mtime);
}

static std::filesystem::path exeDirectory() {
#ifdef _WIN32
    char exe[MAX_PATH] = {};
    if (GetModuleFileNameA(nullptr, exe, MAX_PATH)) return std::filesystem::path(exe).parent_path();
#elif defined(__APPLE__)
    char exe[4096] = {};
    uint32_t size = sizeof(exe);
    if (_NSGetExecutablePath(exe, &size) == 0) {
        std::error_code ec;
        const auto real = std::filesystem::canonical(exe, ec);
        return (ec ? std::filesystem::path(exe) : real).parent_path();
    }
#endif
    return {};
}

std::string resourceDir(const char* name) {
    namespace fs = std::filesystem;
    const fs::path exeDir = exeDirectory();
    if (exeDir.empty()) return {};
    std::error_code ec;
#ifdef __APPLE__
    // Paintify.app/Contents/MacOS/paintify -> Paintify.app/Contents/Resources
    const fs::path bundled = exeDir.parent_path() / "Resources" / name;
    if (fs::exists(bundled, ec)) return bundled.string();
#endif
    const fs::path beside = exeDir / name;
    if (fs::exists(beside, ec)) return beside.string();
    return {};
}

// Portable releases keep shaders beside the executable. The source-tree
// fallback keeps development hot reload available before packaging.
static std::string shaderDir() {
    const auto exeDir = exeDirectory();
    if (!exeDir.empty()) {
        const auto source = std::filesystem::path(SBR_ROOT_DIR) / "shaders";
        // In a CMake build tree F5 reads the editable source shaders. On macOS
        // the executable sits three levels into Paintify.app.
        auto dir = exeDir;
        for (int up = 0; up < 4 && !dir.empty(); ++up, dir = dir.parent_path()) {
            if (std::filesystem::exists(dir / "CMakeCache.txt") &&
                std::filesystem::exists(source)) return source.string() + "/";
        }
        const std::string portable = resourceDir("shaders");
        if (!portable.empty()) return portable + "/";
    }
    return std::string(SBR_ROOT_DIR) + "/shaders/";
}

// common.glsl is included by every stage, so it is tracked as a dependency of
// every program rather than of the one file that names it.
static const char* kSharedInclude = "common.glsl";

std::string loadShaderSource(const std::string& path, std::string* err) {
    bool ok = false;
    std::string src = readFile(shaderDir() + path, &ok);
    if (!ok) { if (err) *err += "cannot open " + path; return std::string(); }

    // Single-level include splice. Deliberately not recursive: common.glsl is
    // the only include, and keeping it flat keeps #line numbering trivial.
    std::string out;
    out.reserve(src.size() + 8192);
    size_t pos = 0;
    int lineNo = 1;
    while (pos <= src.size()) {
        size_t eol = src.find('\n', pos);
        bool last = (eol == std::string::npos);
        if (last) eol = src.size();
        std::string line = src.substr(pos, eol - pos);

        size_t inc = line.find("#include");
        size_t firstNonWs = line.find_first_not_of(" \t");
        if (inc != std::string::npos && firstNonWs == inc) {
            size_t a = line.find('"', inc);
            size_t b = (a == std::string::npos) ? std::string::npos : line.find('"', a + 1);
            if (a != std::string::npos && b != std::string::npos) {
                std::string incName = line.substr(a + 1, b - a - 1);
                bool iok = false;
                std::string incSrc = readFile(shaderDir() + incName, &iok);
                if (!iok) { if (err) *err += "cannot open include " + incName; return std::string(); }
                out += "#line 1\n";
                out += incSrc;
                if (!incSrc.empty() && incSrc[incSrc.size() - 1] != '\n') out += "\n";
                out += "#line " + std::to_string(lineNo + 1) + "\n";
                pos = eol + 1;
                ++lineNo;
                if (last) break;
                continue;
            }
        }
        out += line;
        out += '\n';
        pos = eol + 1;
        ++lineNo;
        if (last) break;
    }
    return out;
}

static GLuint compile(GLenum type, const std::string& src, std::string* err) {
    GLuint s = glCreateShader(type);
    const char* p = src.c_str();
    glShaderSource(s, 1, &p, nullptr);
    glCompileShader(s);
    GLint ok = 0;
    glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        GLint len = 0;
        glGetShaderiv(s, GL_INFO_LOG_LENGTH, &len);
        std::string log(static_cast<size_t>(len > 0 ? len : 1), ' ');
        glGetShaderInfoLog(s, len, nullptr, &log[0]);
        if (err) *err += log;
        glDeleteShader(s);
        return 0;
    }
    return s;
}

bool Program::build() {
    lastError.clear();
    std::vector<GLuint> stages;
    for (size_t i = 0; i < paths.size(); ++i) {
        GLenum type = GL_COMPUTE_SHADER;
        if (paths.size() == 2) type = (i == 0) ? GL_VERTEX_SHADER : GL_FRAGMENT_SHADER;
#ifdef __EMSCRIPTEN__
        // The web build translates every shader to WGSL ahead of time
        // (web/tools/build_shaders.mjs); the WebGPU layer looks it up by name.
        std::string src = paths[i];
#else
        std::string src = loadShaderSource(paths[i], &lastError);
#endif
        if (src.empty()) {
            lastError = paths[i] + ": " + lastError;
            for (size_t k = 0; k < stages.size(); ++k) glDeleteShader(stages[k]);
            return false;
        }
        GLuint s = compile(type, src, &lastError);
        if (!s) {
            lastError = paths[i] + ":\n" + lastError;
            for (size_t k = 0; k < stages.size(); ++k) glDeleteShader(stages[k]);
            return false;
        }
        stages.push_back(s);
    }

    GLuint prog = glCreateProgram();
    for (size_t i = 0; i < stages.size(); ++i) glAttachShader(prog, stages[i]);
    glLinkProgram(prog);
    for (size_t i = 0; i < stages.size(); ++i) {
        glDetachShader(prog, stages[i]);
        glDeleteShader(stages[i]);
    }

    GLint ok = 0;
    glGetProgramiv(prog, GL_LINK_STATUS, &ok);
    if (!ok) {
        GLint len = 0;
        glGetProgramiv(prog, GL_INFO_LOG_LENGTH, &len);
        std::string log(static_cast<size_t>(len > 0 ? len : 1), ' ');
        glGetProgramInfoLog(prog, len, nullptr, &log[0]);
        lastError = paths[0] + " link:\n" + log;
        glDeleteProgram(prog);
        return false;
    }

    if (id) glDeleteProgram(id);
    id = prog;
    mtimes.clear();
    for (size_t i = 0; i < paths.size(); ++i) mtimes.push_back(fileMTime(shaderDir() + paths[i]));
    mtimes.push_back(fileMTime(shaderDir() + kSharedInclude));
    return true;
}

bool Program::loadCompute(const std::string& comp) {
    paths.clear();
    paths.push_back(comp);
    return build();
}

bool Program::loadRaster(const std::string& vert, const std::string& frag) {
    paths.clear();
    paths.push_back(vert);
    paths.push_back(frag);
    return build();
}

bool Program::sourcesChanged() const {
    if (mtimes.size() != paths.size() + 1) return true;
    for (size_t i = 0; i < paths.size(); ++i)
        if (fileMTime(shaderDir() + paths[i]) != mtimes[i]) return true;
    return fileMTime(shaderDir() + kSharedInclude) != mtimes[paths.size()];
}

bool Program::reloadIfChanged() {
    if (!sourcesChanged()) return false;
    return build();
}

void GpuTimer::init() {
    if (!q[0]) glGenQueries(2, q);
}
void GpuTimer::begin() {
    if (!q[0]) init();
    glBeginQuery(GL_TIME_ELAPSED, q[cur]);
    started = true;
}
void GpuTimer::end() {
    if (!started) return;
    glEndQuery(GL_TIME_ELAPSED);
    started = false;
    // Read the *other* query: it is a frame old and therefore already resolved,
    // so the timings never cost a pipeline stall.
    GLuint other = q[1 - cur];
    if (!issued[1 - cur]) { cur = 1 - cur; issued[cur] = true; return; }
    GLint avail = 0;
    glGetQueryObjectiv(other, GL_QUERY_RESULT_AVAILABLE, &avail);
    if (avail) {
        GLuint64 ns = 0;
        glGetQueryObjectui64v(other, GL_QUERY_RESULT, &ns);
        lastMs = static_cast<double>(ns) * 1e-6;
    }
    issued[cur] = true;
    cur = 1 - cur;
}

GLuint createTexture2D(int w, int h, GLenum internalFormat, bool mips) {
    GLuint t = 0;
    glCreateTextures(GL_TEXTURE_2D, 1, &t);
    int levels = 1;
    if (mips) {
        int m = (w > h ? w : h);
        while (m > 1) { m >>= 1; ++levels; }
    }
    glTextureStorage2D(t, levels, internalFormat, w, h);
    glTextureParameteri(t, GL_TEXTURE_MIN_FILTER, mips ? GL_LINEAR_MIPMAP_LINEAR : GL_LINEAR);
    glTextureParameteri(t, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTextureParameteri(t, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTextureParameteri(t, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    return t;
}

GLuint createBuffer(GLenum target, GLsizeiptr bytes, const void* data, GLenum usage) {
    GLuint b = 0;
    glGenBuffers(1, &b);
    glBindBuffer(target, b);
    glBufferData(target, bytes, data, usage);
    glBindBuffer(target, 0);
    return b;
}

#if !defined(__APPLE__) && !defined(__EMSCRIPTEN__)
static void APIENTRY debugCb(GLenum, GLenum type, GLuint, GLenum severity,
                             GLsizei, const GLchar* msg, const void*) {
    if (severity == GL_DEBUG_SEVERITY_NOTIFICATION) return;
    fprintf(stderr, "[GL%s] %s\n", type == GL_DEBUG_TYPE_ERROR ? " ERROR" : "", msg);
}

#endif

void enableDebugOutput() {
#if defined(__APPLE__) || defined(__EMSCRIPTEN__)
    // The Metal and WebGPU layers report their own errors.
#else
    if (!glDebugMessageCallback) return;
    glEnable(GL_DEBUG_OUTPUT);
    glEnable(GL_DEBUG_OUTPUT_SYNCHRONOUS);
    glDebugMessageCallback(debugCb, nullptr);
#endif
}

} // namespace glu
