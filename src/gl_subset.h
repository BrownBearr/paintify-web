#pragma once
// The slice of OpenGL 4.6 that Paintify uses, for platforms with no usable
// GL 4.6 driver underneath: macOS (implemented on Metal, src/mac/gl_metal.mm)
// and the browser (implemented on WebGPU, web/gl_webgpu.js).
//
// The renderer (pipeline.cpp) and the program loader (gl_util.cpp) are shared
// with the Windows build line for line; only what sits underneath them differs.
//
// Semantics follow GL where Paintify depends on them:
//  - commands execute in submission order, and a write is visible to every
//    later command (both backends track hazards themselves, so the barrier
//    calls are no-ops);
//  - glUniform* and glNamedBufferSubData on a uniform buffer take effect for
//    the *next* dispatch only, as in GL -- values are captured per dispatch;
//  - any read back to the CPU waits for the GPU, as glGetTextureImage does;
//  - texel row 0 of a texture is window row 0 of a framebuffer it is attached
//    to (the shader translators flip clip-space y to keep this true).
//
// Everything not listed here is simply not implemented.

#include <cstddef>
#include <cstdint>

typedef unsigned int GLenum;
typedef unsigned char GLboolean;
typedef unsigned int GLbitfield;
typedef int GLint;
typedef int GLsizei;
typedef unsigned int GLuint;
typedef float GLfloat;
typedef char GLchar;
typedef unsigned char GLubyte;
typedef std::ptrdiff_t GLsizeiptr;
typedef std::ptrdiff_t GLintptr;
typedef uint64_t GLuint64;

#ifndef APIENTRY
#define APIENTRY
#endif

#define GL_FALSE 0
#define GL_TRUE 1
#define GL_NONE 0

// object targets
#define GL_TEXTURE_2D 0x0DE1
#define GL_TEXTURE_2D_ARRAY 0x8C1A
#define GL_ARRAY_BUFFER 0x8892
#define GL_UNIFORM_BUFFER 0x8A11
#define GL_SHADER_STORAGE_BUFFER 0x90D2
#define GL_COPY_READ_BUFFER 0x8F36
#define GL_COPY_WRITE_BUFFER 0x8F37
#define GL_DRAW_INDIRECT_BUFFER 0x8F3F
#define GL_FRAMEBUFFER 0x8D40
#define GL_READ_FRAMEBUFFER 0x8CA8
#define GL_DRAW_FRAMEBUFFER 0x8CA9
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_COLOR_ATTACHMENT1 0x8CE1

// buffer usage (accepted, ignored)
#define GL_STATIC_DRAW 0x88E4
#define GL_DYNAMIC_DRAW 0x88E8
#define GL_DYNAMIC_READ 0x88E9
#define GL_DYNAMIC_COPY 0x88EA
#define GL_STREAM_DRAW 0x88E0

// formats and types
#define GL_RED 0x1903
#define GL_RG 0x8227
#define GL_RGB 0x1907
#define GL_RGBA 0x1908
#define GL_RED_INTEGER 0x8D94
#define GL_RGBA8 0x8058
#define GL_RGBA16F 0x881A
#define GL_RG16F 0x822F
#define GL_R16F 0x822D
#define GL_R32UI 0x8236
#define GL_UNSIGNED_BYTE 0x1401
#define GL_UNSIGNED_INT 0x1405
#define GL_FLOAT 0x1406
#define GL_HALF_FLOAT 0x140B

// sampler state
#define GL_TEXTURE_MIN_FILTER 0x2801
#define GL_TEXTURE_MAG_FILTER 0x2800
#define GL_TEXTURE_WRAP_S 0x2802
#define GL_TEXTURE_WRAP_T 0x2803
#define GL_NEAREST 0x2600
#define GL_LINEAR 0x2601
#define GL_NEAREST_MIPMAP_NEAREST 0x2700
#define GL_LINEAR_MIPMAP_NEAREST 0x2701
#define GL_NEAREST_MIPMAP_LINEAR 0x2702
#define GL_LINEAR_MIPMAP_LINEAR 0x2703
#define GL_REPEAT 0x2901
#define GL_CLAMP_TO_EDGE 0x812F

// image access
#define GL_READ_ONLY 0x88B8
#define GL_WRITE_ONLY 0x88B9
#define GL_READ_WRITE 0x88BA

// barriers (no-ops)
#define GL_VERTEX_ATTRIB_ARRAY_BARRIER_BIT 0x00000001
#define GL_UNIFORM_BARRIER_BIT 0x00000004
#define GL_TEXTURE_FETCH_BARRIER_BIT 0x00000008
#define GL_SHADER_IMAGE_ACCESS_BARRIER_BIT 0x00000020
#define GL_COMMAND_BARRIER_BIT 0x00000040
#define GL_TEXTURE_UPDATE_BARRIER_BIT 0x00000100
#define GL_BUFFER_UPDATE_BARRIER_BIT 0x00000200
#define GL_FRAMEBUFFER_BARRIER_BIT 0x00000400
#define GL_SHADER_STORAGE_BARRIER_BIT 0x00002000
#define GL_ALL_BARRIER_BITS 0xFFFFFFFF

// capabilities
#define GL_BLEND 0x0BE2
#define GL_DEPTH_TEST 0x0B71
#define GL_SCISSOR_TEST 0x0C11
#define GL_SCISSOR_BOX 0x0C10
#define GL_VIEWPORT 0x0BA2
#define GL_DEBUG_OUTPUT 0x92E0
#define GL_DEBUG_OUTPUT_SYNCHRONOUS 0x8242

// blending
#define GL_ZERO 0
#define GL_ONE 1
#define GL_SRC_ALPHA 0x0302
#define GL_ONE_MINUS_SRC_ALPHA 0x0303

// drawing
#define GL_TRIANGLES 0x0004
#define GL_TRIANGLE_STRIP 0x0005
#define GL_COLOR_BUFFER_BIT 0x00004000

// shaders and programs
#define GL_FRAGMENT_SHADER 0x8B30
#define GL_VERTEX_SHADER 0x8B31
#define GL_COMPUTE_SHADER 0x91B9
#define GL_COMPILE_STATUS 0x8B81
#define GL_LINK_STATUS 0x8B82
#define GL_INFO_LOG_LENGTH 0x8B84

// queries
#define GL_TIME_ELAPSED 0x88BF
#define GL_TIMESTAMP 0x8E28
#define GL_QUERY_RESULT 0x8866
#define GL_QUERY_RESULT_AVAILABLE 0x8867

// strings
#define GL_VENDOR 0x1F00
#define GL_RENDERER 0x1F01
#define GL_VERSION 0x1F02

#ifdef __EMSCRIPTEN__
extern "C" {   // implemented in JavaScript (web/gl_webgpu.js)
#endif

#pragma once
// The slice of OpenGL 4.6 that Paintify uses, for platforms with no usable
// GL 4.6 driver underneath: macOS (implemented on Metal, src/mac/gl_metal.mm)
// and the browser (implemented on WebGPU, web/gl_webgpu.js).
//
// The renderer (pipeline.cpp) and the program loader (gl_util.cpp) are shared
// with the Windows build line for line; only what sits underneath them differs.
//
// Semantics follow GL where Paintify depends on them:
//  - commands execute in submission order, and a write is visible to every
//    later command (both backends track hazards themselves, so the barrier
//    calls are no-ops);
//  - glUniform* and glNamedBufferSubData on a uniform buffer take effect for
//    the *next* dispatch only, as in GL -- values are captured per dispatch;
//  - any read back to the CPU waits for the GPU, as glGetTextureImage does;
//  - texel row 0 of a texture is window row 0 of a framebuffer it is attached
//    to (the shader translators flip clip-space y to keep this true).
//
// Everything not listed here is simply not implemented.

#include <cstddef>
#include <cstdint>

typedef unsigned int GLenum;
typedef unsigned char GLboolean;
typedef unsigned int GLbitfield;
typedef int GLint;
typedef int GLsizei;
typedef unsigned int GLuint;
typedef float GLfloat;
typedef char GLchar;
typedef unsigned char GLubyte;
typedef std::ptrdiff_t GLsizeiptr;
typedef std::ptrdiff_t GLintptr;
typedef uint64_t GLuint64;

#ifndef APIENTRY
#define APIENTRY
#endif

#define GL_FALSE 0
#define GL_TRUE 1
#define GL_NONE 0

// object targets
#define GL_TEXTURE_2D 0x0DE1
#define GL_TEXTURE_2D_ARRAY 0x8C1A
#define GL_ARRAY_BUFFER 0x8892
#define GL_UNIFORM_BUFFER 0x8A11
#define GL_SHADER_STORAGE_BUFFER 0x90D2
#define GL_COPY_READ_BUFFER 0x8F36
#define GL_COPY_WRITE_BUFFER 0x8F37
#define GL_DRAW_INDIRECT_BUFFER 0x8F3F
#define GL_FRAMEBUFFER 0x8D40
#define GL_READ_FRAMEBUFFER 0x8CA8
#define GL_DRAW_FRAMEBUFFER 0x8CA9
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_COLOR_ATTACHMENT1 0x8CE1

// buffer usage (accepted, ignored)
#define GL_STATIC_DRAW 0x88E4
#define GL_DYNAMIC_DRAW 0x88E8
#define GL_DYNAMIC_READ 0x88E9
#define GL_DYNAMIC_COPY 0x88EA
#define GL_STREAM_DRAW 0x88E0

// formats and types
#define GL_RED 0x1903
#define GL_RG 0x8227
#define GL_RGB 0x1907
#define GL_RGBA 0x1908
#define GL_RED_INTEGER 0x8D94
#define GL_RGBA8 0x8058
#define GL_RGBA16F 0x881A
#define GL_RG16F 0x822F
#define GL_R16F 0x822D
#define GL_R32UI 0x8236
#define GL_UNSIGNED_BYTE 0x1401
#define GL_UNSIGNED_INT 0x1405
#define GL_FLOAT 0x1406
#define GL_HALF_FLOAT 0x140B

// sampler state
#define GL_TEXTURE_MIN_FILTER 0x2801
#define GL_TEXTURE_MAG_FILTER 0x2800
#define GL_TEXTURE_WRAP_S 0x2802
#define GL_TEXTURE_WRAP_T 0x2803
#define GL_NEAREST 0x2600
#define GL_LINEAR 0x2601
#define GL_NEAREST_MIPMAP_NEAREST 0x2700
#define GL_LINEAR_MIPMAP_NEAREST 0x2701
#define GL_NEAREST_MIPMAP_LINEAR 0x2702
#define GL_LINEAR_MIPMAP_LINEAR 0x2703
#define GL_REPEAT 0x2901
#define GL_CLAMP_TO_EDGE 0x812F

// image access
#define GL_READ_ONLY 0x88B8
#define GL_WRITE_ONLY 0x88B9
#define GL_READ_WRITE 0x88BA

// barriers (no-ops)
#define GL_VERTEX_ATTRIB_ARRAY_BARRIER_BIT 0x00000001
#define GL_UNIFORM_BARRIER_BIT 0x00000004
#define GL_TEXTURE_FETCH_BARRIER_BIT 0x00000008
#define GL_SHADER_IMAGE_ACCESS_BARRIER_BIT 0x00000020
#define GL_COMMAND_BARRIER_BIT 0x00000040
#define GL_TEXTURE_UPDATE_BARRIER_BIT 0x00000100
#define GL_BUFFER_UPDATE_BARRIER_BIT 0x00000200
#define GL_FRAMEBUFFER_BARRIER_BIT 0x00000400
#define GL_SHADER_STORAGE_BARRIER_BIT 0x00002000
#define GL_ALL_BARRIER_BITS 0xFFFFFFFF

// capabilities
#define GL_BLEND 0x0BE2
#define GL_DEPTH_TEST 0x0B71
#define GL_SCISSOR_TEST 0x0C11
#define GL_SCISSOR_BOX 0x0C10
#define GL_VIEWPORT 0x0BA2
#define GL_DEBUG_OUTPUT 0x92E0
#define GL_DEBUG_OUTPUT_SYNCHRONOUS 0x8242

// blending
#define GL_ZERO 0
#define GL_ONE 1
#define GL_SRC_ALPHA 0x0302
#define GL_ONE_MINUS_SRC_ALPHA 0x0303

// drawing
#define GL_TRIANGLES 0x0004
#define GL_TRIANGLE_STRIP 0x0005
#define GL_COLOR_BUFFER_BIT 0x00004000

// shaders and programs
#define GL_FRAGMENT_SHADER 0x8B30
#define GL_VERTEX_SHADER 0x8B31
#define GL_COMPUTE_SHADER 0x91B9
#define GL_COMPILE_STATUS 0x8B81
#define GL_LINK_STATUS 0x8B82
#define GL_INFO_LOG_LENGTH 0x8B84

// queries
#define GL_TIME_ELAPSED 0x88BF
#define GL_TIMESTAMP 0x8E28
#define GL_QUERY_RESULT 0x8866
#define GL_QUERY_RESULT_AVAILABLE 0x8867

// strings
#define GL_VENDOR 0x1F00
#define GL_RENDERER 0x1F01
#define GL_VERSION 0x1F02

// --- context ---------------------------------------------------------------
const GLubyte* glGetString(GLenum name);
void glEnable(GLenum cap);
void glDisable(GLenum cap);
GLboolean glIsEnabled(GLenum cap);
void glGetIntegerv(GLenum pname, GLint* data);
void glViewport(GLint x, GLint y, GLsizei w, GLsizei h);
void glScissor(GLint x, GLint y, GLsizei w, GLsizei h);
void glClearColor(GLfloat r, GLfloat g, GLfloat b, GLfloat a);
void glClear(GLbitfield mask);
void glFinish();
void glMemoryBarrier(GLbitfield barriers);
void glTextureBarrier();
void glBlendFunci(GLuint buf, GLenum src, GLenum dst);

// --- textures --------------------------------------------------------------
void glCreateTextures(GLenum target, GLsizei n, GLuint* textures);
void glGenTextures(GLsizei n, GLuint* textures);
void glDeleteTextures(GLsizei n, const GLuint* textures);
void glBindTexture(GLenum target, GLuint texture);
void glTextureStorage2D(GLuint tex, GLsizei levels, GLenum ifmt, GLsizei w, GLsizei h);
void glTextureStorage3D(GLuint tex, GLsizei levels, GLenum ifmt, GLsizei w, GLsizei h, GLsizei d);
void glTexImage2D(GLenum target, GLint level, GLint ifmt, GLsizei w, GLsizei h, GLint border,
                  GLenum format, GLenum type, const void* pixels);
void glTextureSubImage2D(GLuint tex, GLint level, GLint x, GLint y, GLsizei w, GLsizei h,
                         GLenum format, GLenum type, const void* pixels);
void glTextureSubImage3D(GLuint tex, GLint level, GLint x, GLint y, GLint z, GLsizei w,
                         GLsizei h, GLsizei d, GLenum format, GLenum type, const void* pixels);
void glTextureParameteri(GLuint tex, GLenum pname, GLint param);
void glTexParameteri(GLenum target, GLenum pname, GLint param);
void glGenerateTextureMipmap(GLuint tex);
void glGenerateMipmap(GLenum target);
void glBindTextureUnit(GLuint unit, GLuint tex);
void glBindImageTexture(GLuint unit, GLuint tex, GLint level, GLboolean layered, GLint layer,
                        GLenum access, GLenum format);
void glClearTexImage(GLuint tex, GLint level, GLenum format, GLenum type, const void* data);
void glCopyImageSubData(GLuint src, GLenum srcTarget, GLint srcLevel, GLint srcX, GLint srcY,
                        GLint srcZ, GLuint dst, GLenum dstTarget, GLint dstLevel, GLint dstX,
                        GLint dstY, GLint dstZ, GLsizei w, GLsizei h, GLsizei d);
void glGetTextureImage(GLuint tex, GLint level, GLenum format, GLenum type, GLsizei bufSize,
                       void* pixels);

// --- buffers ---------------------------------------------------------------
void glGenBuffers(GLsizei n, GLuint* buffers);
void glDeleteBuffers(GLsizei n, const GLuint* buffers);
void glBindBuffer(GLenum target, GLuint buffer);
void glBindBufferBase(GLenum target, GLuint index, GLuint buffer);
void glBufferData(GLenum target, GLsizeiptr size, const void* data, GLenum usage);
void glNamedBufferSubData(GLuint buf, GLintptr offset, GLsizeiptr size, const void* data);
void glGetNamedBufferSubData(GLuint buf, GLintptr offset, GLsizeiptr size, void* data);
void glClearNamedBufferData(GLuint buf, GLenum ifmt, GLenum format, GLenum type, const void* data);
void glClearNamedBufferSubData(GLuint buf, GLenum ifmt, GLintptr offset, GLsizeiptr size,
                               GLenum format, GLenum type, const void* data);
void glCopyNamedBufferSubData(GLuint src, GLuint dst, GLintptr srcOffset, GLintptr dstOffset,
                              GLsizeiptr size);

// --- framebuffers ----------------------------------------------------------
void glCreateFramebuffers(GLsizei n, GLuint* fbos);
void glDeleteFramebuffers(GLsizei n, const GLuint* fbos);
void glBindFramebuffer(GLenum target, GLuint fbo);
void glNamedFramebufferTexture(GLuint fbo, GLenum attachment, GLuint tex, GLint level);
void glNamedFramebufferDrawBuffers(GLuint fbo, GLsizei n, const GLenum* bufs);
void glBlitNamedFramebuffer(GLuint readFbo, GLuint drawFbo, GLint sx0, GLint sy0, GLint sx1,
                            GLint sy1, GLint dx0, GLint dy0, GLint dx1, GLint dy1,
                            GLbitfield mask, GLenum filter);

// --- vertex arrays (accepted; the stroke pass pulls its vertices itself) ---
void glGenVertexArrays(GLsizei n, GLuint* arrays);
void glDeleteVertexArrays(GLsizei n, const GLuint* arrays);
void glBindVertexArray(GLuint array);

// --- shaders and programs --------------------------------------------------
GLuint glCreateShader(GLenum type);
void glShaderSource(GLuint shader, GLsizei count, const GLchar* const* strings, const GLint* lengths);
void glCompileShader(GLuint shader);
void glGetShaderiv(GLuint shader, GLenum pname, GLint* params);
void glGetShaderInfoLog(GLuint shader, GLsizei maxLength, GLsizei* length, GLchar* log);
void glDeleteShader(GLuint shader);
GLuint glCreateProgram();
void glAttachShader(GLuint program, GLuint shader);
void glDetachShader(GLuint program, GLuint shader);
void glLinkProgram(GLuint program);
void glGetProgramiv(GLuint program, GLenum pname, GLint* params);
void glGetProgramInfoLog(GLuint program, GLsizei maxLength, GLsizei* length, GLchar* log);
void glDeleteProgram(GLuint program);
void glUseProgram(GLuint program);
GLint glGetUniformLocation(GLuint program, const GLchar* name);
void glUniform1i(GLint location, GLint v);
void glUniform2i(GLint location, GLint v0, GLint v1);
void glUniform1ui(GLint location, GLuint v);
void glUniform1f(GLint location, GLfloat v);
void glUniform3f(GLint location, GLfloat v0, GLfloat v1, GLfloat v2);

// --- work ------------------------------------------------------------------
void glDispatchCompute(GLuint x, GLuint y, GLuint z);
void glDrawArraysIndirect(GLenum mode, const void* indirect);

// --- queries ---------------------------------------------------------------
void glGenQueries(GLsizei n, GLuint* ids);
void glDeleteQueries(GLsizei n, const GLuint* ids);
void glBeginQuery(GLenum target, GLuint id);
void glEndQuery(GLenum target);
void glQueryCounter(GLuint id, GLenum target);
void glGetQueryObjectiv(GLuint id, GLenum pname, GLint* params);
void glGetQueryObjectui64v(GLuint id, GLenum pname, GLuint64* params);

#ifdef __EMSCRIPTEN__
} // extern "C"
#endif
