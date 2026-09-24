//--
// This file is part of Sonic Pi: http://sonic-pi.net
// Full project source: https://github.com/sonic-pi-net/sonic-pi
// License: https://github.com/sonic-pi-net/sonic-pi/blob/main/LICENSE.md
//
// Copyright 2026 by Sam Aaron (http://sam.aaron.name).
// All rights reserved.
//
// Permission is granted for use, copying, modification, and
// distribution of modified versions of this work as long as this
// notice is included.
//++

#include "GraphicsRenderer.h"
#include "GraphicsLog.h"
#include "GraphicsSettings.h"
#include "GraphicsTarget.h"

// The `#include` expander. Header-only, GL-free and widget-free, so the rules it implements are
// tested on their own in tools/settings-probe/shader-include-check.cpp rather than through a build of
// this application (docs/dev-discipline.md 4.1).
#include "graphics/ShaderInclude.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QOpenGLContext>
#include <QOpenGLExtraFunctions>
#include <QOpenGLFramebufferObject>
#include <QOpenGLFramebufferObjectFormat>
#include <QOpenGLBuffer>
#include <QOpenGLShaderProgram>
#include <QStringList>
#include <QVector2D>
#include <QVector3D>
#include <QVector4D>

#include <cmath>

namespace SonicPi
{

namespace
{
// A colour read back from an 8-bit attachment will not equal the float that was
// written to it, so compare with a tolerance rather than for equality. 2/255
// covers the rounding without being loose enough to hide a wrong colour.
constexpr int kChannelTolerance = 2;

int toByte(float v)
{
    return int(std::lround(double(v) * 255.0));
}

// GRAPHICS_SHADER_DIR is defined by CMake for every target in this directory, so the same fallback
// definition is repeated here only for the case where this file is compiled without it. The shader
// PATHS themselves are owned by GraphicsSettings, which is what resolveShaderPath() delegates to.
#ifndef GRAPHICS_SHADER_DIR
#define GRAPHICS_SHADER_DIR ""
#endif

// The self-test's own shaders, compiled into the binary rather than read from disk.
//
// WHY, because this is a deliberate departure from how the real shader is loaded:
//
// The pipeline self-check has to answer one question reliably - "does this build draw
// the pixels it thinks it draws" - and it can only answer it if the pattern it draws is
// the pattern it compares against. Loaded from the user's shader directory, it is not:
// the first anchors.frag the user edits changes the picture and every anchor mismatches,
// producing
//
//     [ERROR] shader output FAILED at one or more anchors
//
// on every start of a perfectly healthy build. That is worse than a missing check,
// because a false ERROR teaches its reader to ignore ERRORs.
//
// Two further reasons this belongs in the binary:
//
//   * It is a FIXTURE, not a shader anyone is meant to edit. The editable one is
//     default.frag; that is the point of the shader directory.
//   * The expected colours in the anchor table below are a contract with this source. A
//     file on disk can be edited, deleted, or left behind by an older build, so the two
//     halves of one contract could disagree - which is the class of bug this whole feature
//     kept running into.
//
// The shipped copies stay in app/gui/graphics/shaders/ as documentation, and because the
// first run copies them into the user's directory for editing. Nothing reads them for the
// self-check any more.
const char* kSelfTestVertexShader = R"(
#version 330 core
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_uv;
out vec2 v_uv;
void main()
{
    v_uv = a_uv;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
)";

const char* kSelfTestFragmentShader = R"(
#version 330 core

// Quadrant test pattern. This is a self-test, not a picture: it exists so the offscreen
// pipeline can be proved to draw the right pixels in the right places, because "it ran
// without crashing" is not evidence that anything correct was rendered.
//
// The regions and their colours are a contract with verifyShaderOutput() below, which
// reads these five points back and compares them channel by channel.
//
//   uv (0,0) bottom-left   red     (255,   0,   0)
//   uv (1,0) bottom-right  green   (  0, 255,   0)
//   uv (0,1) top-left      blue    (  0,   0, 255)
//   uv (1,1) top-right     yellow  (255, 255,   0)
//   centre                 white   (255, 255, 255)
//
// The uv origin is bottom-left because that is OpenGL's, which is why (0,0) is red
// rather than the more habitual top-left.
//
// Yellow is the odd one out: red + green. That is not an oversight. It makes the
// top-right corner the one point where both horizontal and vertical position are
// confirmed at once, so a pattern that is one axis out cannot pass by accident.
//
// Branchless quadrant select: c0 when neither selector is set, c3 when both are.
in vec2 v_uv;
layout(location = 0) out vec4 FragColor;

vec3 pick(float sx, float sy, vec3 c0, vec3 c1, vec3 c2, vec3 c3)
{
    return mix(mix(c0, c1, sx), mix(c2, c3, sx), sy);
}

void main()
{
    const vec3 kRed    = vec3(1.0, 0.0, 0.0);
    const vec3 kGreen  = vec3(0.0, 1.0, 0.0);
    const vec3 kBlue   = vec3(0.0, 0.0, 1.0);
    const vec3 kYellow = vec3(1.0, 1.0, 0.0);

    // step() rather than a branch: uniform control flow, and no driver-dependent
    // behaviour.
    float sx = step(0.5, v_uv.x);
    float sy = step(0.5, v_uv.y);

    vec3 colour = pick(sx, sy, kRed, kGreen, kBlue, kYellow);

    // White centre patch. A region rather than a single pixel, so the anchor does not
    // depend on exactly which fragment the rasteriser lands on.
    float inCentre = step(0.4375, v_uv.x) * step(v_uv.x, 0.5625)
                   * step(0.4375, v_uv.y) * step(v_uv.y, 0.5625);
    colour = mix(colour, vec3(1.0), inCentre);

    FragColor = vec4(colour, 1.0);
}
)";

// There is no registry of live renderers any more.
//
// One existed so a GUI-initiated reload could reach every renderer. That could not
// work - a shader belongs to a context and a context belongs to a thread - so the
// only consumer is gone and the registry with it. See the note further down where
// reloadAll() used to be.
} // namespace

GraphicsRenderer::~GraphicsRenderer()
{
    // Destroying a shader program or framebuffer needs the context that created
    // it to be current. The caller releases the context after this object is
    // gone, so by then it is safe. Contract, not an assertion:
    //   GraphicsRenderer must be destroyed while its context is current.
    destroy();
}

void GraphicsRenderer::destroy()
{
    // Destroyed before the context goes away: QOpenGLVertexArrayObject's destructor
    // needs that context to be current, which is the same contract the program
    // relies on. No framebuffer here any more - that belongs to GraphicsTarget.
    m_vbo.reset();
    m_vao.reset();
    m_program.reset();
}

bool GraphicsRenderer::initialize()
{
    if (!QOpenGLContext::currentContext())
    {
        GraphicsLog::error(QStringLiteral("renderer: no current context at initialize"));
        return false;
    }

    if (!createQuadGeometry())
        return false;

    // A shader that will not compile is reported but not fatal, and now it is not a blank output
    // either: at startup there is no previous program to keep, so the choice is a built-in fallback
    // shader or nothing at all. The fallback draws something unmistakably not the user's shader, so
    // "my edit broke it" is visible rather than looking like the feature stopped working.
    if (!loadShaders())
    {
        GraphicsLog::warn(QStringLiteral("renderer: the shader on disk did not build at startup; "
                                         "installing the built-in fallback"));
        if (!installFallbackShader())
        {
            GraphicsLog::error(QStringLiteral("renderer: no usable shader at all; the output will be "
                                              "a flat clear colour until the shader compiles"));
            return false;
        }
    }

    return true;
}

bool GraphicsRenderer::createQuadGeometry()
{
    // Vertex array object, then the quad's interleaved position+uv buffer.
    //
    // The VAO is needed even when a shader derives its own coordinates: a
    // core-profile context requires one bound for any draw call, and without it
    // glDrawArrays raises GL_INVALID_OPERATION (0x502).
    m_vao = std::make_unique<QOpenGLVertexArrayObject>();
    if (!m_vao->create() || !m_vao->isCreated())
    {
        GraphicsLog::error(QStringLiteral("renderer: could not create a vertex array object"));
        m_vao.reset();
        return false;
    }
    m_vao->bind();

    // Full-screen quad: two triangles, six vertices, interleaved x,y,u,v.
    //
    // The order matters and is the bottom-left, bottom-right, top-right then
    // bottom-left, top-right, top-left winding.
    //
    //   (-1,-1) uv(0,0)  bottom-left
    //   ( 1,-1) uv(1,0)  bottom-right
    //   ( 1, 1) uv(1,1)  top-right
    //   (-1, 1) uv(0,1)  top-left
    //
    // (0,0) at the bottom-left because that is OpenGL's origin; the readback in
    // verifyShaderOutput reads with the same sense on purpose.
    static const float kQuad[] = {
        -1.0f, -1.0f, 0.0f, 0.0f,
         1.0f, -1.0f, 1.0f, 0.0f,
         1.0f,  1.0f, 1.0f, 1.0f,
        -1.0f, -1.0f, 0.0f, 0.0f,
         1.0f,  1.0f, 1.0f, 1.0f,
        -1.0f,  1.0f, 0.0f, 1.0f,
    };

    m_vbo = std::make_unique<QOpenGLBuffer>(QOpenGLBuffer::VertexBuffer);
    if (!m_vbo->create() || !m_vbo->bind())
    {
        GraphicsLog::error(QStringLiteral("renderer: could not create the vertex buffer"));
        m_vbo.reset();
        return false;
    }
    m_vbo->setUsagePattern(QOpenGLBuffer::StaticDraw);
    m_vbo->allocate(kQuad, int(sizeof(kQuad)));

    return true;
}

QString GraphicsRenderer::resolveShaderPath(const QString& fileName) const
{
    // Delegated, not implemented here.
    //
    // The resolution rule - user copy first, shipped copy second - is shared with the shader editor,
    // which writes the file this reads. Two implementations would eventually disagree, and the
    // symptom would be an editor editing a file that is not the one being rendered: indistinguishable
    // from "my changes do nothing". One owner, in GraphicsSettings.
    const QString path = GraphicsSettings::shaderPath(fileName);
    if (path.isEmpty())
    {
        GraphicsLog::error(QStringLiteral("renderer: shader '%1' not found. Looked in:\n  %2\n  %3")
                               .arg(fileName,
                                    GraphicsSettings::writableShaderPath(fileName),
                                    QStringLiteral(GRAPHICS_SHADER_DIR) + QLatin1Char('/') + fileName));
    }
    return path;
}

bool GraphicsRenderer::readExpandedShader(const QString& path, QString* text, QString* error) const
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly))
    {
        *error = QObject::tr("Could not read %1: %2").arg(path, file.errorString());
        return false;
    }
    const QString source = QString::fromUtf8(file.readAll());

    // A name inside a directive resolves by exactly the same rule as the shader itself - the user's
    // copy first, then the shipped one - because a library is edited in the same way and lives in the
    // same place. A second search path here would eventually disagree with the first, and the symptom
    // would be an edit to a library that has no effect.
    const auto resolve = [](const QString& name, const QString&) -> ShaderInclude::Source {
        ShaderInclude::Source found;
        const QString resolved = GraphicsSettings::shaderPath(name);
        if (resolved.isEmpty())
            return found;   // found == false: the expander reports what it could not find
        QFile included(resolved);
        if (!included.open(QIODevice::ReadOnly))
            return found;
        found.found = true;
        found.path = resolved;
        found.text = QString::fromUtf8(included.readAll());
        return found;
    };

    const ShaderInclude::Result expanded = ShaderInclude::expand(source, path, resolve);
    if (!expanded.ok)
    {
        *error = expanded.error;
        return false;
    }

    // One line per shader that has includes, saying what came in and how much of it. Silence when a
    // shader has none: the common case is a shader with no libraries, and a line per reload about
    // nothing is how a log stops being read. The counts are there because "did the whole library
    // arrive?" is otherwise unanswerable without opening the file.
    if (!expanded.included.isEmpty())
    {
        QStringList parts;
        parts.reserve(expanded.included.size());
        for (const ShaderInclude::Included& included : expanded.included)
            parts << QStringLiteral("%1 (%2 lines)").arg(included.path).arg(included.lines);
        GraphicsLog::info(QStringLiteral("shader: %1 includes  %2")
                              .arg(path, parts.join(QStringLiteral("  "))));
    }

    *text = expanded.text;
    return true;
}

GraphicsCompileResult GraphicsRenderer::buildProgram(const QString& vertexFile,
                                                     const QString& fragmentFile)
{
    GraphicsCompileResult result;
    result.fragmentPath = resolveShaderPath(fragmentFile);

    const QString vert = resolveShaderPath(vertexFile);
    const QString frag = result.fragmentPath;
    if (vert.isEmpty() || frag.isEmpty())
    {
        // A missing file is a failure like any other, and says so in the same channel as a compiler
        // error: the user needs one place where "the shader did not build" is explained, and "the
        // file is not there" must not be a silent variant of it.
        result.log = QObject::tr("Shader file not found.\n  vertex:   %1\n  fragment: %2\n\n"
                                 "Looked in the user shader directory and the shipped copy.")
                         .arg(vert.isEmpty() ? QStringLiteral("(missing)") : vert,
                              frag.isEmpty() ? QStringLiteral("(missing)") : frag);
        return result;
    }

    // Read and expand BEFORE Qt sees anything, because what the driver must compile is the file with
    // its libraries inlined - not the file on disk. Source code rather than a file name, which is the
    // only difference this makes to Qt; the shader text is then handled exactly as before
    // (tools/settings-probe/gl-line-directive-probe.cpp compiles the same way, which is why its
    // measurements apply here).
    QString vertSource;
    QString fragSource;
    if (!readExpandedShader(vert, &vertSource, &result.log))
    {
        GraphicsLog::error(QStringLiteral("renderer: could not prepare the vertex shader %1\n%2")
                               .arg(vert, result.log));
        return result;
    }
    if (!readExpandedShader(frag, &fragSource, &result.log))
    {
        // An include that cannot be resolved is a failure of the same kind as a syntax error, so it
        // travels the same way: named, explained, and without touching the running program. The
        // directories are appended here rather than in the expander because the expander has no
        // search path of its own - it is handed a resolver - and a user who cannot find a file needs
        // to see where it was looked for.
        result.log = QObject::tr("%1\n\nLooked in:\n  %2\n  %3")
                         .arg(result.log,
                              GraphicsSettings::shaderDirectoryPath(),
                              QStringLiteral(GRAPHICS_SHADER_DIR) + QLatin1Char('/'));
        GraphicsLog::error(
            QStringLiteral("renderer: could not expand the includes in %1\n%2").arg(frag, result.log));
        return result;
    }

    auto program = std::make_unique<QOpenGLShaderProgram>();

    if (!program->addShaderFromSourceCode(QOpenGLShader::Vertex, vertSource))
    {
        result.log = program->log();
        GraphicsLog::error(QStringLiteral("renderer: vertex shader failed to compile (%1)\n%2")
                               .arg(vert, result.log));
        return result;
    }
    if (!program->addShaderFromSourceCode(QOpenGLShader::Fragment, fragSource))
    {
        result.log = program->log();
        GraphicsLog::error(QStringLiteral("renderer: fragment shader failed to compile (%1)\n%2")
                               .arg(frag, result.log));
        return result;
    }
    if (!program->link())
    {
        result.log = program->log();
        GraphicsLog::error(QStringLiteral("renderer: shader program failed to link\n%1")
                               .arg(result.log));
        return result;
    }

    result.program = std::move(program);
    return result;
}

std::unique_ptr<QOpenGLShaderProgram> GraphicsRenderer::buildSelfTestProgram()
{
    auto program = std::make_unique<QOpenGLShaderProgram>();

    if (!program->addShaderFromSourceCode(QOpenGLShader::Vertex, kSelfTestVertexShader))
    {
        GraphicsLog::error(QStringLiteral("renderer: the self-test vertex shader failed to compile\n%1")
                               .arg(program->log()));
        return nullptr;
    }
    if (!program->addShaderFromSourceCode(QOpenGLShader::Fragment, kSelfTestFragmentShader))
    {
        GraphicsLog::error(QStringLiteral("renderer: the self-test fragment shader failed to compile\n%1")
                               .arg(program->log()));
        return nullptr;
    }
    if (!program->link())
    {
        GraphicsLog::error(QStringLiteral("renderer: the self-test shader program failed to link\n%1")
                               .arg(program->log()));
        return nullptr;
    }

    return program;
}

GraphicsCompileResult GraphicsRenderer::compileReplacement()
{
    const QString vertexFile = QStringLiteral("passthrough.vert");
    const QString fragmentFile = QStringLiteral("default.frag");

    GraphicsCompileResult result = buildProgram(vertexFile, fragmentFile);
    if (!result.ok())
    {
        // Names the file and states that the previous program survives, so a compile failure cannot
        // be mistaken for a reload that never arrived. The same explanation goes to the user through
        // the returned log; this is the record.
        GraphicsLog::error(QStringLiteral("shader load FAILED; keeping the previous program. "
                                          "fragment file was: %1")
                               .arg(result.fragmentPath));
        return result;
    }

    // The file's size and modification time.
    //
    // So a reload that read a stale copy is distinguishable from one that read the current bytes:
    // compare these against the file on disk. Two rounds of explaining "editing has no effect" would
    // have been settled by these two numbers.
    const QFileInfo fragInfo(result.fragmentPath);
    GraphicsLog::info(QStringLiteral("shader: compiled  fragment=%1  bytes=%2  mtime=%3")
                          .arg(result.fragmentPath)
                          .arg(fragInfo.size())
                          .arg(fragInfo.lastModified().toString(QStringLiteral("HH:mm:ss.zzz"))));

    return result;
}

void GraphicsRenderer::adoptProgram(std::unique_ptr<QOpenGLShaderProgram> program)
{
    if (!program)
        return;

    // The swap and the uniform re-query happen together, because a program and the
    // locations that belong to it must never be out of step - the failure that made
    // the picture freeze while every log line said the reload had succeeded.
    m_program = std::move(program);
    m_vertexPath = resolveShaderPath(QStringLiteral("passthrough.vert"));
    m_fragmentPath = resolveShaderPath(QStringLiteral("default.frag"));
    cacheUniformLocations();
}

bool GraphicsRenderer::loadShaders()
{
    GraphicsCompileResult result = compileReplacement();
    if (!result.ok())
        return false;

    adoptProgram(std::move(result.program));
    return true;
}

// A last-resort shader, compiled from a literal.
//
// Used when the shader on disk will not build AT STARTUP, which is the one case where "keep the
// previous program" has no previous program to keep: the renderer would otherwise be left with no
// program, and the application would start to a blank output with nothing but a log line to explain
// it. A recognisable gradient is better than a blank: it says "something is drawing, and it is not
// your shader" without needing to be read about first.
//
// Deliberately not the default.frag from the source tree. That file is user-editable state, and the
// whole point of this fallback is to be the thing that cannot fail.
static const char* kFallbackFragmentShader = R"(
#version 330 core
uniform float iTime;
uniform vec2  iResolution;
in vec2 v_uv;
layout(location = 0) out vec4 FragColor;
void main()
{
    // A slow diagonal gradient, unmistakably not a user's shader.
    float g = fract(v_uv.x * 0.5 + v_uv.y * 0.5 + iTime * 0.1);
    FragColor = vec4(g, 0.25 + 0.25 * sin(iTime), 1.0 - g, 1.0);
}
)";

bool GraphicsRenderer::installFallbackShader()
{
    auto program = std::make_unique<QOpenGLShaderProgram>();

    // The vertex half comes from the shipped tree rather than a literal, because the quad's attribute
    // locations have to match the geometry this renderer already built - and that contract lives in
    // passthrough.vert. If even that is unreadable, there is nothing sensible left to do.
    //
    // Read and expanded through the same path as the normal load. Not because a fallback shader pair
    // is likely to have includes, but because "how a shader file is turned into source" must have one
    // answer: two would eventually differ, and this is the code path nobody exercises.
    const QString vert = resolveShaderPath(QStringLiteral("passthrough.vert"));
    QString vertSource;
    QString vertError;
    if (vert.isEmpty() || !readExpandedShader(vert, &vertSource, &vertError)
        || !program->addShaderFromSourceCode(QOpenGLShader::Vertex, vertSource))
    {
        GraphicsLog::error(QStringLiteral("renderer: the fallback shader could not be built either; "
                                          "the output will be a flat clear colour (%1)")
                               .arg(vertError.isEmpty() ? program->log() : vertError));
        return false;
    }
    if (!program->addShaderFromSourceCode(QOpenGLShader::Fragment, kFallbackFragmentShader)
        || !program->link())
    {
        GraphicsLog::error(QStringLiteral("renderer: the fallback fragment shader failed to link\n%1")
                               .arg(program->log()));
        return false;
    }

    adoptProgram(std::move(program));
    m_usingFallbackShader = true;
    GraphicsLog::warn(QStringLiteral("renderer: using the built-in fallback shader, because the "
                                     "shader on disk does not compile. Fix it in the shader editor "
                                     "and compile again; the output is not blank in the meantime"));
    return true;
}

void GraphicsRenderer::cacheUniformLocations()
{
    m_uniforms = queryUniforms(m_program.get());
    buildDynamicUniforms();

    m_reportedNoUniforms = false;
    const bool any = m_uniforms.time >= 0 || m_uniforms.timeDelta >= 0
                     || m_uniforms.frame >= 0 || m_uniforms.resolution >= 0;
    if (any)
    {
        GraphicsLog::info(QStringLiteral("shader uniforms: iTime=%1 iTimeDelta=%2 iFrame=%3 iResolution=%4 "
                                         "(-1 means the shader does not declare it)")
                              .arg(m_uniforms.time)
                              .arg(m_uniforms.timeDelta)
                              .arg(m_uniforms.frame)
                              .arg(m_uniforms.resolution));
    }
}

// Ask the driver what this program declares, and keep the answers OSC can address.
//
// Built fresh on every successful link, because uniform locations belong to the program that was
// current when they were queried and a reload replaces the program. Also cleared here: a name that
// the new program no longer declares must not be applied to a stale location.
void GraphicsRenderer::buildDynamicUniforms()
{
    m_dynamicUniforms.clear();
    m_unmatchedNames.clear();
    m_reportedMismatches.clear();
    m_reportedBuiltins.clear();

    if (!m_program || !m_program->isLinked())
        return;

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    QOpenGLFunctions* f = ctx ? ctx->functions() : nullptr;
    if (!f)
        return;

    m_program->bind();

    GLint active = 0;
    GLint maxLength = 0;
    f->glGetProgramiv(m_program->programId(), GL_ACTIVE_UNIFORMS, &active);
    f->glGetProgramiv(m_program->programId(), GL_ACTIVE_UNIFORM_MAX_LENGTH, &maxLength);
    if (active <= 0 || maxLength <= 0)
    {
        m_program->release();
        return;
    }

    QVector<char> name(int(maxLength) + 1, '\0');
    QStringList addressable;

    for (GLint i = 0; i < active; ++i)
    {
        GLsizei written = 0;
        GLint size = 0;
        GLenum type = 0;
        f->glGetActiveUniform(m_program->programId(), GLuint(i), maxLength, &written, &size, &type,
                              name.data());

        const QString uniformName = QString::fromLatin1(name.constData(), written);

        DynamicUniform entry;
        entry.location = m_program->uniformLocation(uniformName);
        entry.glType = unsigned(type);
        entry.size = int(size);
        entry.target = GraphicsOsc::targetFromGlUniform(unsigned(type), int(size), uniformName);

        m_dynamicUniforms.insert(uniformName, entry);

        if (entry.target.supported())
        {
            addressable << QStringLiteral("%1 (%2 x%3)")
                               .arg(uniformName,
                                    QLatin1String(GraphicsOsc::describe(entry.target.kind)))
                               .arg(entry.target.count);
        }
    }

    m_program->release();

    // One line per link. This is the list a user needs when a name "does not work": it is the
    // driver's answer to what the shader actually declares, which is not the same as what its
    // source says (declared-but-unused uniforms are absent).
    if (addressable.isEmpty())
    {
        GraphicsLog::info(QStringLiteral("shader declares no OSC-addressable uniforms "
                                         "(%1 active in total); osc \"/graphics/uniform\" values "
                                         "will have nowhere to go")
                              .arg(active));
    }
    else
    {
        GraphicsLog::info(QStringLiteral("shader uniforms addressable by OSC (%1 of %2 active): %3")
                              .arg(addressable.size())
                              .arg(active)
                              .arg(addressable.join(QStringLiteral(", "))));
    }
}

void GraphicsRenderer::applyDynamicUniforms(const GraphicsFrame& frame)
{
    if (!frame.dynamic || frame.dynamic->isEmpty() || m_dynamicUniforms.isEmpty())
        return;

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    QOpenGLFunctions* f = ctx ? ctx->functions() : nullptr;
    if (!f)
        return;

    QSet<QString> stillUnmatched;

    for (const GraphicsUniformValue& value : *frame.dynamic)
    {
        // The four built-ins are the loop's to set. Refused rather than allowed, because a value
        // overwritten every frame by the renderer would look like "my OSC control does nothing" -
        // and allowed would also mean a race between the two writers, frame by frame.
        if (value.name == QLatin1String("iTime") || value.name == QLatin1String("iTimeDelta")
            || value.name == QLatin1String("iFrame") || value.name == QLatin1String("iResolution"))
        {
            if (!m_reportedBuiltins.contains(value.name))
            {
                m_reportedBuiltins.insert(value.name);
                GraphicsLog::info(QStringLiteral("graphics osc: %1 is set by the frame loop, not by "
                                                 "OSC; the value is ignored")
                                      .arg(value.name));
            }
            continue;
        }

        const auto it = m_dynamicUniforms.constFind(value.name);
        if (it == m_dynamicUniforms.constEnd())
        {
            // Not declared, or declared and optimised away. Normal while the user is still writing
            // one side of the pair, so it is collected and summarised rather than reported here.
            stillUnmatched.insert(value.name);
            continue;
        }

        const DynamicUniform& uniform = it.value();

        // The store keeps the values as they arrived; whether they suit this uniform is the same
        // question the probe answers for a decoded message, so it is the same function - one copy
        // of the rule, already exercised with real bytes.
        //
        // "integral" has two sources because a value that has been through the store has been
        // through a float view: it says whether the arguments arrived as integers, so a whole float
        // (1.0) is added back here as an integer-valued argument. Without this, a value the decoder
        // accepts for an int uniform would be refused on the way to the shader.
        const bool integral = value.integral || GraphicsOsc::allValuesIntegral(value.floats);

        const GraphicsOsc::Verdict verdict =
            GraphicsOsc::verdictFor(integral, value.count(), uniform.target);

        if (verdict != GraphicsOsc::Verdict::Accept)
        {
            if (!m_reportedMismatches.contains(value.name))
            {
                m_reportedMismatches.insert(value.name);
                GraphicsLog::info(QStringLiteral("graphics osc: %1 takes %2 x%3, but %4 value(s) "
                                                 "arrived - %5; the message is ignored")
                                      .arg(value.name,
                                           QLatin1String(GraphicsOsc::describe(uniform.target.kind)))
                                      .arg(uniform.target.count)
                                      .arg(value.count())
                                      .arg(QLatin1String(GraphicsOsc::describe(verdict))));
            }
            continue;
        }

        applyUniformValue(f, uniform, value);
    }

    // The summary. Printed only when the set of unmatched names is non-empty, at most once per
    // interval, and never as a warning: an unmatched name is not a fault.
    if (stillUnmatched != m_unmatchedNames)
    {
        m_unmatchedNames = stillUnmatched;
        m_unmatchedTimer.restart();
        if (!stillUnmatched.isEmpty())
            reportUnmatchedNames();
    }
    else if (!stillUnmatched.isEmpty() && m_unmatchedTimer.elapsed() >= kUnmatchedReportIntervalMs)
    {
        m_unmatchedTimer.restart();
        reportUnmatchedNames();
    }
}

void GraphicsRenderer::reportUnmatchedNames()
{
    QStringList names = m_unmatchedNames.values();
    names.sort();

    QStringList declared = m_dynamicUniforms.keys();
    declared.sort();

    GraphicsLog::info(QStringLiteral("graphics osc: %1 name(s) have no matching uniform (%2). "
                                     "This shader declares: %3")
                          .arg(names.size())
                          .arg(names.join(QStringLiteral(", ")),
                               declared.isEmpty() ? QStringLiteral("nothing OSC-addressable")
                                                  : declared.join(QStringLiteral(", "))));
}

void GraphicsRenderer::applyUniformValue(QOpenGLFunctions* f, const DynamicUniform& uniform,
                                         const GraphicsUniformValue& value)
{
    if (uniform.location < 0)
        return;

    // Floats go through Qt's wrappers; integer vectors have no Qt equivalent and go straight to GL.
    // Both are the same call underneath, and this keeps the conversions in one place rather than
    // scattered through the loop above.
    if (uniform.target.kind == GraphicsOsc::TargetKind::Float)
    {
        switch (uniform.target.count)
        {
        case 1: m_program->setUniformValue(uniform.location, value.floats.value(0)); break;
        case 2: m_program->setUniformValue(uniform.location,
                                           QVector2D(value.floats.value(0), value.floats.value(1))); break;
        case 3: m_program->setUniformValue(uniform.location,
                                           QVector3D(value.floats.value(0), value.floats.value(1),
                                                     value.floats.value(2))); break;
        case 4: m_program->setUniformValue(uniform.location,
                                           QVector4D(value.floats.value(0), value.floats.value(1),
                                                     value.floats.value(2), value.floats.value(3))); break;
        default: break;
        }
        return;
    }

    switch (uniform.target.count)
    {
    case 1: f->glUniform1i(uniform.location, value.ints.value(0)); break;
    case 2: f->glUniform2iv(uniform.location, 1, value.ints.constData()); break;
    case 3: f->glUniform3iv(uniform.location, 1, value.ints.constData()); break;
    case 4: f->glUniform4iv(uniform.location, 1, value.ints.constData()); break;
    default: break;
    }
}

GraphicsRenderer::Uniforms GraphicsRenderer::queryUniforms(QOpenGLShaderProgram* program)
{
    Uniforms u;
    if (!program || !program->isLinked())
        return u;

    // The program must be bound for uniform queries. Binding here is what lets this
    // be called for a program that is NOT the renderer's own, without going near
    // m_uniforms.
    program->bind();
    u.time       = program->uniformLocation("iTime");
    u.timeDelta  = program->uniformLocation("iTimeDelta");
    u.frame      = program->uniformLocation("iFrame");
    u.resolution = program->uniformLocation("iResolution");
    program->release();
    return u;
}

void GraphicsRenderer::applyUniforms(const GraphicsFrame& frame)
{
    if (!m_program || !m_program->isLinked())
        return;

    // A shader that declares none of these is perfectly valid - the ramp the
    // default shader draws is static - so this is reported once, as information,
    // and not repeated every frame. It is worth saying out loud because "my
    // uniform has no effect" is otherwise indistinguishable from "my shader
    // declared it but nothing is setting it".
    const bool anyBuiltin = m_uniforms.time >= 0 || m_uniforms.timeDelta >= 0
                            || m_uniforms.frame >= 0 || m_uniforms.resolution >= 0;

    if (!anyBuiltin && !m_reportedNoUniforms)
    {
        m_reportedNoUniforms = true;
        GraphicsLog::info(QStringLiteral("shader declares none of iTime/iTimeDelta/iFrame/iResolution; "
                                         "the frame values are not being used"));
    }

    // Uniform1f takes a float, and the shader's uniform is a float, so the
    // conversion from the double the clock produces happens here. That is the
    // right place for it: the loss of precision is unavoidable at the shader
    // boundary, but the value being narrowed was computed from a monotonic clock
    // difference rather than accumulated, so it does not compound.
    if (m_uniforms.time >= 0)
        m_program->setUniformValue(m_uniforms.time, float(frame.timeSeconds));
    if (m_uniforms.timeDelta >= 0)
        m_program->setUniformValue(m_uniforms.timeDelta, float(frame.deltaSeconds));
    if (m_uniforms.frame >= 0)
        m_program->setUniformValue(m_uniforms.frame, int(frame.frameIndex));
    if (m_uniforms.resolution >= 0)
        m_program->setUniformValue(m_uniforms.resolution,
                                   QVector2D(float(frame.resolution.width()),
                                             float(frame.resolution.height())));

    // After the built-ins, so an OSC name can never take one of them away - and outside the
    // "no built-ins declared" case above, which is a perfectly ordinary shader for the OSC path:
    // a shader driven only by OSC declares none of the four.
    applyDynamicUniforms(frame);
}

bool GraphicsRenderer::reloadShaders()
{
    if (!QOpenGLContext::currentContext())
    {
        GraphicsLog::error(QStringLiteral("renderer: reload requested with no current context"));
        return false;
    }
    // Deliberately not clearing m_program first: loadShaders() only swaps it in
    // on success, so the old one keeps rendering if the edit is broken.
    return loadShaders();
}

// reloadAll() used to live here: it walked the registry of framebuffer-owning
// renderers and recompiled each one, making each context current for the duration.
//
// It is gone deliberately, and the reason is worth keeping. It was called from the
// GUI thread, where the only context it could make current was the window's - not
// the render thread's, whose context belongs to another thread and must not be made
// current here at all. It also reached into an object the render thread owned
// without holding that thread's mutex, racing the 60 Hz loop.
//
// The result was a shader reload that worked unpredictably: it compiled against the
// wrong context, and whether it took effect depended on timing, so a user could
// click reload several times and see the picture change seconds later, or not at
// all.
//
// A shader belongs to the context it is used with and to the thread that owns that
// context, so the only correct place to compile it is that thread. The render
// thread applies reloads itself - GraphicsRenderThread::requestShaderReload() - and
// the GUI's menu action now only asks for one.

bool GraphicsRenderer::renderInto(GraphicsTarget& target, const GraphicsFrame& frame)
{

    if (!target.isValid())
    {
        GraphicsLog::error(QStringLiteral("renderer: render requested with no valid target"));
        return false;
    }

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    QOpenGLFunctions* f = ctx ? ctx->functions() : nullptr;
    if (!f)
    {
        GraphicsLog::error(QStringLiteral("renderer: render requested with no current context"));
        return false;
    }

    target.bind();

    // Set the viewport explicitly rather than assuming it.
    //
    // QOpenGLFramebufferObject::bind() binds the framebuffer and does NOT touch
    // glViewport - its only GL call is glBindFramebuffer - so the viewport is
    // whatever the surface last left behind. Before this was set, drawing into a
    // 640x360 attachment happened with the offscreen surface's 1894x1092 viewport
    // still in force: the quad was rasterised across the larger area and only the
    // part landing inside the attachment survived, cropping the image to its
    // bottom-left third and compressing every interpolated varying into the same
    // third of its range.
    //
    // A target is the whole pass, so the viewport is the whole target. The window's
    // crop lives in the window's own display shader, not here.
    const QSize size = target.size();
    f->glViewport(0, 0, size.width(), size.height());


    // Clear first so anything the shader does not cover is a known colour rather
    // than whatever was in the buffer before.
    f->glClearColor(kClearR, kClearG, kClearB, kClearA);
    f->glClear(GL_COLOR_BUFFER_BIT);

    // Start the GPU timer AFTER the clear, so the figure is the shader's cost rather than the
    // shader's cost plus a full-screen clear. Both are real costs of a frame, but only the first
    // is what a user comparing shaders at a resolution is asking about, and lumping them together
    // would make a cheap shader look expensive at 4K.
    const bool timing = beginGpuTiming();

    if (m_program && m_program->isLinked())
    {
        m_program->bind();
        // Uniforms go in after binding the program and before the draw call, which
        // is the only order that works: they are part of the program's state, not
        // the framebuffer's.
        applyUniforms(frame);
        drawQuadWithProgram(m_program.get());
        m_program->release();
    }

    // Stop before the error check and before anything else, so the query covers the draw and
    // nothing else that happens to be issued afterwards.
    if (timing)
        endGpuTiming();

    const GLenum err = f->glGetError();
    if (err != GL_NO_ERROR)
    {
        GraphicsLog::error(QStringLiteral("renderer: GL error 0x%1 after draw").arg(err, 0, 16));
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
// GPU timing
// ---------------------------------------------------------------------------------------------

void GraphicsRenderer::setUpGpuTimer()
{
    if (m_gpuTimerReady || m_glGetQueryObjectui64v)
        return;

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    QOpenGLFunctions* f = ctx ? ctx->functions() : nullptr;
    if (!ctx || !f)
        return;

    // GL 3.3 core, which this renderer asks for, does NOT include timer queries - they arrived
    // in 3.3 as ARB_timer_query and were folded into core in 4.3. So the extension is checked
    // rather than assumed, and the result is reported either way: a figure that silently is not
    // measured is worse than one that is absent, because nobody knows to distrust it.
    if (!ctx->hasExtension(QByteArrayLiteral("GL_ARB_timer_query")))
    {
        if (!m_gpuTimerUnavailableReported)
        {
            m_gpuTimerUnavailableReported = true;
            GraphicsLog::warn(QStringLiteral("renderer: GL_ARB_timer_query is not offered, so the "
                                             "GPU frame time cannot be measured; the overlay will "
                                             "show no GPU figure rather than a wrong one"));
        }
        return;
    }

    m_glGetQueryObjectui64v =
        reinterpret_cast<GetQueryObjectui64vFn>(ctx->getProcAddress("glGetQueryObjectui64v"));
    if (!m_glGetQueryObjectui64v)
    {
        if (!m_gpuTimerUnavailableReported)
        {
            m_gpuTimerUnavailableReported = true;
            GraphicsLog::warn(QStringLiteral("renderer: the extension is present but "
                                             "glGetQueryObjectui64v could not be resolved"));
        }
        return;
    }

    auto* extra = ctx->extraFunctions();
    if (!extra)
        return;

    // Clear any error left by earlier setup, so what is checked next can only come from here.
    while (f->glGetError() != GL_NO_ERROR) {}

    extra->glGenQueries(kQueryPoolSize, m_queries);
    const GLenum genErr = f->glGetError();


    // A query object is valid only if it is non-zero, so a driver that returned zeroes has not
    // given a pool and timing must stay off rather than proceed on invalid ids.
    for (GLuint q : m_queries)
    {
        if (q == 0)
        {
            GraphicsLog::warn(QStringLiteral("renderer: glGenQueries returned an invalid id; "
                                             "GPU timing disabled"));
            return;
        }
    }

    m_gpuTimerReady = true;
}

bool GraphicsRenderer::beginGpuTiming()
{
    if (!m_gpuTimerReady)
        setUpGpuTimer();
    if (!m_gpuTimerReady)
        return false;

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    auto* extra = ctx ? ctx->extraFunctions() : nullptr;
    if (!extra)
        return false;

    // The slot this frame will use, and the advance happens HERE rather than at the end.
    //
    // That ordering is a fix for a real bug, and the symptom was subtle: the pool rotated only
    // when a result was successfully harvested, so a slot whose result was not yet ready was
    // checked again on the very next frame and every frame after it, and the timer collected about
    // one sample a second instead of one per frame.
    //
    // Advancing unconditionally is what makes the pool a rotation rather than a retry.
    const int slot = m_querySlot;
    m_querySlot = (m_querySlot + 1) % kQueryPoolSize;

    // Harvest the previous use of THIS slot, which was kQueryPoolSize frames ago, and only once
    // EVERY slot has been through a begin/end pair.
    //
    // The guard is on "slots completed", not on "slots started", and getting that wrong was a real
    // bug rather than a detail: counting started slots reached the full pool one frame too early,
    // so the first harvest read an object that had never been begun - which is the one thing a
    // query object must not be asked, and it raises GL_INVALID_OPERATION. It happened exactly once
    // per process, which is why it looked like a startup noise rather than a logic error.
    const bool poolReady = (m_queryPoolUsed >= kQueryPoolSize);

    // Two further things here were settled by measurement rather than by reading the specification,
    // and both were wrong in the first version:
    //
    //   * A query object must not be asked anything before it has ever been begun. Requesting
    //     GL_QUERY_RESULT_AVAILABLE on a fresh object left it in a state where the FOLLOWING
    //     glBeginQuery on it failed with GL_INVALID_OPERATION.
    //
    //   * GL_QUERY_RESULT_AVAILABLE does not become true on this driver until something forces a
    //     full synchronisation. Measured with a pool rotation and real GL work between the markers:
    //     polling alone reported ready 0 times in 36 frames; glFlush made no difference; a glFinish
    //     before the read reported ready 12 times out of 12, with sensible values.
    //
    // The glFinish does not serialise anything meaningful, because it is called for a query issued
    // kQueryPoolSize frames ago whose work finished long before: reading this way measured the same
    // cost as reading any old result. It is what makes the result readable at all, and the
    // alternative - polling without it - reports nothing rather than reporting late.
    if (poolReady && m_queries[slot] != 0)
    {
        // Clear pending errors first, so nothing from an earlier call can be mistaken for a failure
        // here. This is the mistake the first version made when it blamed glBeginQuery for an error
        // that was already pending before the call.
        while (ctx->functions()->glGetError() != GL_NO_ERROR) {}

        ctx->functions()->glFinish();

        GLuint available = 0;
        extra->glGetQueryObjectuiv(m_queries[slot], GL_QUERY_RESULT_AVAILABLE, &available);
        if (available == GL_TRUE)
        {
            GLuint64 ns = 0;
            m_glGetQueryObjectui64v(m_queries[slot], GL_QUERY_RESULT, &ns);
            m_gpuFrameMs.store(double(ns) / 1.0e6, std::memory_order_relaxed);
        }
        else
        {
            // Nothing was measured for this frame, and -1 says so rather than 0: a shader that
            // costs nothing and a shader that was not measured must not look alike.
            m_gpuFrameMs.store(-1.0, std::memory_order_relaxed);
        }
    }

    extra->glBeginQuery(GL_TIME_ELAPSED, m_queries[slot]);
    m_queryActive = true;

    // Counted after the pair is complete, which is what makes m_queryPoolUsed mean "slots that have
    // a result to harvest" rather than "slots that have been touched".
    if (m_queryPoolUsed < kQueryPoolSize)
        ++m_queryPoolUsed;

    return true;
}

void GraphicsRenderer::endGpuTiming()
{
    if (!m_queryActive)
        return;

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    auto* extra = ctx ? ctx->extraFunctions() : nullptr;
    if (extra)
        extra->glEndQuery(GL_TIME_ELAPSED);
    m_queryActive = false;
}

void GraphicsRenderer::releaseGpuTimer()
{
    if (!m_gpuTimerReady)
        return;

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    auto* extra = ctx ? ctx->extraFunctions() : nullptr;
    if (extra)
        extra->glDeleteQueries(kQueryPoolSize, m_queries);
    for (GLuint& q : m_queries)
        q = 0;
    m_gpuTimerReady = false;
    m_queryPoolUsed = 0;
    m_queryActive = false;
    m_gpuFrameMs.store(-1.0, std::memory_order_relaxed);
}

QString GraphicsRenderer::gpuTimerDescription() const
{
    if (!m_gpuTimerReady)
        return QStringLiteral("unavailable");
    return QStringLiteral("GL_ARB_timer_query, %1-slot pool, read %1 frames late")
        .arg(kQueryPoolSize);
}


bool GraphicsRenderer::drawQuadWithProgram(QOpenGLShaderProgram* program)
{
    // Deliberately takes the program rather than reading m_program. The caller has
    // bound it and set its uniforms; this only issues the geometry. That is what
    // lets the verification draw its test pattern through the same code as the real
    // frame without either corrupting the other - the earlier arrangement, where
    // verification swapped m_program in and back out, left the renderer's uniform
    // locations pointing at the test program and froze the real shader.
    if (!program || !program->isLinked())
        return false;

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    QOpenGLFunctions* f = ctx ? ctx->functions() : nullptr;
    if (!f || !m_vao || !m_vbo)
        return false;

    // Attribute locations are hardcoded in passthrough.vert via
    // layout(location = ...), so the same numbers are used here. Bound and enabled
    // per frame rather than once at setup: the cost is negligible and it cannot
    // drift out of sync with the VAO state.
    m_vao->bind();
    m_vbo->bind();

    program->enableAttributeArray(0);
    program->setAttributeBuffer(0, GL_FLOAT, 0, 2, 4 * sizeof(float));
    program->enableAttributeArray(1);
    program->setAttributeBuffer(1, GL_FLOAT, 2 * sizeof(float), 2, 4 * sizeof(float));

    // Six vertices: two triangles forming the full-screen quad.
    f->glDrawArrays(GL_TRIANGLES, 0, 6);

    program->disableAttributeArray(0);
    program->disableAttributeArray(1);
    m_vbo->release();
    m_vao->release();
    return true;
}

bool GraphicsRenderer::readPixels(GraphicsTarget& target, QSize* sizeOut,
                                  std::unique_ptr<unsigned char[]>* pixelsOut)
{
    if (!target.isValid())
    {
        GraphicsLog::error(QStringLiteral("renderer: readback requested with no valid target"));
        return false;
    }

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    QOpenGLFunctions* f = ctx ? ctx->functions() : nullptr;
    if (!f)
    {
        GraphicsLog::error(QStringLiteral("renderer: readback requested with no current context"));
        return false;
    }

    const int w = target.size().width();
    const int h = target.size().height();
    const size_t bytes = size_t(w) * size_t(h) * 4;
    auto buffer = std::make_unique<unsigned char[]>(bytes);

    // Bind first: glReadPixels reads from the currently bound framebuffer.
    target.bind();
    f->glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, buffer.get());
    target.release();

    const GLenum err = f->glGetError();
    if (err != GL_NO_ERROR)
    {
        GraphicsLog::error(QStringLiteral("renderer: glReadPixels reported GL error 0x%1")
                               .arg(err, 0, 16));
        return false;
    }

    if (sizeOut)
        *sizeOut = target.size();
    if (pixelsOut)
        *pixelsOut = std::move(buffer);
    return true;
}

bool GraphicsRenderer::channelClose(unsigned char actual, float expected) const
{
    return std::abs(int(actual) - toByte(expected)) <= kChannelTolerance;
}

bool GraphicsRenderer::verifyShaderOutput(GraphicsTarget& target)
{
    if (!target.isValid())
    {
        GraphicsLog::error(QStringLiteral("renderer: verify requested with no valid target"));
        return false;
    }

    // Draw the test pattern rather than the current default shader. The check is
    // of the pipeline - buffer, attributes, projection, framebuffer, readback -
    // and needs a known image to compare against, which default.frag deliberately
    // is not.
    //
    // Built from source compiled into the binary, NOT from a file in the shader
    // directory. See kSelfTestFragmentShader: loaded from disk, an edit to the user's
    // copy changed the pattern and made every anchor mismatch, so a healthy build reported
    // a failure on every start.
    auto anchors = buildSelfTestProgram();
    if (!anchors)
    {
        GraphicsLog::error(QStringLiteral("renderer: could not build the verification shader"));
        return false;
    }

    // The test program is used WITHOUT being installed as m_program.
    //
    // An earlier version swapped it into m_program and restored it afterwards. That
    // was the source of a bug that cost real time: uniform locations belong to the
    // program that was current when they were queried, the test pattern declares no
    // uniforms, so the renderer was left holding a set of -1 locations and the real
    // shader silently stopped receiving iTime and iFrame. The picture froze while
    // every log line said the reload had worked.
    //
    // Drawing through drawQuadWithProgram() with a local program cannot do that: the
    // renderer's program and its cached locations are never touched at all.
    const Uniforms anchorUniforms = queryUniforms(anchors.get());
    Q_UNUSED(anchorUniforms);   // the pattern is static; it declares none by design
    if (!anchors->bind())
    {
        GraphicsLog::error(QStringLiteral("renderer: could not bind the verification program"));
        return false;
    }

    // The viewport and the clear come from the frame path, so this uses the same
    // geometry and the same background as a real frame - a test that set up its own
    // state could pass while the real path is broken.
    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    QOpenGLFunctions* f = ctx ? ctx->functions() : nullptr;
    if (!f)
        return false;

    target.bind();
    const QSize targetSize = target.size();
    f->glViewport(0, 0, targetSize.width(), targetSize.height());
    f->glClearColor(kClearR, kClearG, kClearB, kClearA);
    f->glClear(GL_COLOR_BUFFER_BIT);

    const bool drew = drawQuadWithProgram(anchors.get());
    anchors->release();
    if (!drew)
    {
        target.release();
        GraphicsLog::error(QStringLiteral("renderer: verification draw failed"));
        return false;
    }
    target.release();

    QSize readSize;
    std::unique_ptr<unsigned char[]> pixels;
    if (!readPixels(target, &readSize, &pixels))
        return false;

    const int w = readSize.width();
    const int h = readSize.height();

    // Anchor points matching anchors.frag.
    //
    // The y axis here is OpenGL's: row 0 is the BOTTOM of the image, because
    // that is where GL's origin is. So y=0 is "bottom" in shader terms and h-1
    // is "top". Reading these the habitually screen-like way round would compare
    // the wrong corners and either pass by luck or fail confusingly.
    struct Anchor
    {
        const char* label;
        int x;
        int y;
        float r, g, b;
    };
    // Sampled away from the exact corner so the shader's interior region is
    // what gets checked, not a boundary pixel.
    const int inset = 8;
    const Anchor anchorsTable[] = {
        { "bottom-left  (uv 0,0)", inset,     inset,     1.0f, 0.0f, 0.0f },
        { "bottom-right (uv 1,0)", w - inset, inset,     0.0f, 1.0f, 0.0f },
        { "top-left     (uv 0,1)", inset,     h - inset, 0.0f, 0.0f, 1.0f },
        { "top-right    (uv 1,1)", w - inset, h - inset, 1.0f, 1.0f, 0.0f },
        { "centre",                w / 2,     h / 2,     1.0f, 1.0f, 1.0f },
    };

    bool allOk = true;
    for (const auto& a : anchorsTable)
    {
        const size_t offset = (size_t(a.y) * size_t(w) + size_t(a.x)) * 4;
        const unsigned char* px = pixels.get() + offset;
        const bool ok = channelClose(px[0], a.r) && channelClose(px[1], a.g)
                        && channelClose(px[2], a.b);

        // Alpha is reported but not asserted: the test pattern is fully opaque,
        // so a wrong alpha here could only mean a wrong attachment format, and
        // including it in the log makes that visible without turning a
        // format difference into a pipeline failure.
        allOk = allOk && ok;

        GraphicsLog::info(QStringLiteral("  %1 (%2,%3) = rgb(%4,%5,%6) a=%7 want(%8,%9,%10) %11")
                              .arg(QString::fromLatin1(a.label))
                              .arg(a.x)
                              .arg(a.y)
                              .arg(px[0])
                              .arg(px[1])
                              .arg(px[2])
                              .arg(px[3])
                              .arg(toByte(a.r))
                              .arg(toByte(a.g))
                              .arg(toByte(a.b))
                              .arg(ok ? QStringLiteral("ok") : QStringLiteral("MISMATCH")));
    }

    if (allOk)
        GraphicsLog::info(QStringLiteral("shader output verified: %1x%2").arg(w).arg(h));
    else
        GraphicsLog::error(QStringLiteral("shader output FAILED at one or more anchors"));

    return allOk;
}

} // namespace SonicPi
