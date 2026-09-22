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

#include <QDir>
#include <QFile>
#include <QOpenGLContext>
#include <QOpenGLFramebufferObject>
#include <QOpenGLFramebufferObjectFormat>
#include <QOpenGLBuffer>
#include <QOpenGLShaderProgram>
#include <QSet>

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

// Where the shader files live. GRAPHICS_SHADER_DIR is set by CMake to the
// source-tree copy; the user copy takes priority so the shipped files are never
// edited in place.
#ifndef GRAPHICS_SHADER_DIR
#define GRAPHICS_SHADER_DIR ""
#endif

// Live renderers, so a reload triggered from the GUI can reach them.
//
// A registry rather than a global shader object: GL shader programs belong to a
// context, so there is nothing shareable between renderers, and an explicit
// registry avoids introducing a singleton for the sake of one menu action.
QSet<GraphicsRenderer*>& liveRenderers()
{
    static QSet<GraphicsRenderer*> set;
    return set;
}
} // namespace

GraphicsRenderer::~GraphicsRenderer()
{
    // Destroying a shader program or framebuffer needs the context that created
    // it to be current. The caller releases the context after this object is
    // gone, so by then it is safe. Contract, not an assertion:
    //   GraphicsRenderer must be destroyed while its context is current.
    liveRenderers().remove(this);
    destroy();
}

void GraphicsRenderer::destroy()
{
    // Destroyed before the context goes away: QOpenGLVertexArrayObject's
    // destructor needs that context to be current, which is the same contract
    // the framebuffer and program rely on.
    m_vbo.reset();
    m_vao.reset();
    m_program.reset();
    m_fbo.reset();
    m_size = QSize();
}

bool GraphicsRenderer::initialize(const QSize& size)
{
    if (!QOpenGLContext::currentContext())
    {
        GraphicsLog::error(QStringLiteral("renderer: no current context at initialize"));
        return false;
    }
    if (!size.isValid() || size.isEmpty())
    {
        GraphicsLog::error(QStringLiteral("renderer: refusing to create a framebuffer of size %1x%2")
                               .arg(size.width())
                               .arg(size.height()));
        return false;
    }

    QOpenGLFramebufferObjectFormat fmt;
    fmt.setAttachment(QOpenGLFramebufferObject::CombinedDepthStencil);
    // The attachment is the texture the display window will later share, so it
    // is a plain 2D colour texture rather than a multisampled one: multisampled
    // attachments would need a resolve blit before anything else could read them.
    fmt.setSamples(0);

    m_fbo = std::make_unique<QOpenGLFramebufferObject>(size, fmt);
    if (!m_fbo || !m_fbo->isValid())
    {
        GraphicsLog::error(QStringLiteral("renderer: framebuffer object is not valid"));
        m_fbo.reset();
        return false;
    }

    m_size = size;
    liveRenderers().insert(this);

    if (!createQuadGeometry())
        return false;

    GraphicsLog::info(QStringLiteral("framebuffer ready: %1x%2, texture id %3")
                          .arg(size.width())
                          .arg(size.height())
                          .arg(m_fbo->texture()));

    // A shader that will not compile is reported but not fatal: render() falls
    // back to a flat clear, so the output still shows something identifiable.
    if (!loadShaders())
        GraphicsLog::warn(QStringLiteral("renderer: no usable shader; falling back to a flat clear"));

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

bool GraphicsRenderer::initializeWithoutFramebuffer()
{
    if (!QOpenGLContext::currentContext())
    {
        GraphicsLog::error(QStringLiteral("renderer: no current context at initialize"));
        return false;
    }

    // No framebuffer, so nothing registers with the reload registry: a reload only
    // needs to reach renderers whose context a GUI action cannot make current
    // itself, and this one is driven from the GUI thread.
    if (!createQuadGeometry())
        return false;

    if (!loadShaders())
    {
        GraphicsLog::warn(QStringLiteral("renderer: no usable shader; falling back to a flat clear"));
        return false;
    }

    return true;
}

QString GraphicsRenderer::resolveShaderPath(const QString& fileName) const
{
    QString home = qEnvironmentVariable("SONIC_PI_HOME");
    if (home.isEmpty())
        home = qEnvironmentVariable("USERPROFILE");
    if (home.isEmpty())
        home = QDir::homePath();

    // User copy first: this is the one to edit, and editing it cannot dirty the
    // source tree.
    const QString userDir = home + QStringLiteral("/.sonic-pi/graphics/shaders");
    const QString userPath = userDir + QLatin1Char('/') + fileName;
    if (QFile::exists(userPath))
        return userPath;

    // Fall back to the copy shipped with the source, so a fresh checkout works
    // without a copying step.
    const QString shipped = QStringLiteral(GRAPHICS_SHADER_DIR) + QLatin1Char('/') + fileName;
    if (QFile::exists(shipped))
        return shipped;

    GraphicsLog::error(QStringLiteral("renderer: shader '%1' not found. Looked in:\n  %2\n  %3")
                           .arg(fileName, userPath, shipped));
    return QString();
}

std::unique_ptr<QOpenGLShaderProgram> GraphicsRenderer::buildProgram(const QString& vertexFile,
                                                                     const QString& fragmentFile)
{
    const QString vert = resolveShaderPath(vertexFile);
    const QString frag = resolveShaderPath(fragmentFile);
    if (vert.isEmpty() || frag.isEmpty())
        return nullptr;

    auto program = std::make_unique<QOpenGLShaderProgram>();

    if (!program->addShaderFromSourceFile(QOpenGLShader::Vertex, vert))
    {
        GraphicsLog::error(QStringLiteral("renderer: vertex shader failed to compile (%1)\n%2")
                               .arg(vert, program->log()));
        return nullptr;
    }
    if (!program->addShaderFromSourceFile(QOpenGLShader::Fragment, frag))
    {
        GraphicsLog::error(QStringLiteral("renderer: fragment shader failed to compile (%1)\n%2")
                               .arg(frag, program->log()));
        return nullptr;
    }
    if (!program->link())
    {
        GraphicsLog::error(QStringLiteral("renderer: shader program failed to link\n%1")
                               .arg(program->log()));
        return nullptr;
    }

    return program;
}

bool GraphicsRenderer::loadShaders()
{
    const QString vertexFile = QStringLiteral("passthrough.vert");
    const QString fragmentFile = QStringLiteral("default.frag");

    auto program = buildProgram(vertexFile, fragmentFile);
    if (!program)
        return false;

    // Only replace the working program once the new one is proven good, so a
    // failed edit leaves the previous picture on screen.
    m_program = std::move(program);
    m_vertexPath = resolveShaderPath(vertexFile);
    m_fragmentPath = resolveShaderPath(fragmentFile);

    GraphicsLog::info(QStringLiteral("shader: loaded\n  vertex   : %1\n  fragment : %2")
                          .arg(m_vertexPath, m_fragmentPath));

    cacheUniformLocations();
    return true;
}

void GraphicsRenderer::cacheUniformLocations()
{
    m_uniforms = Uniforms();
    m_reportedNoUniforms = false;

    if (!m_program || !m_program->isLinked())
        return;

    // The program must be bound for uniform queries. Callers reach here either
    // straight from a successful link (the program is bound as part of linking)
    // or from loadShaders(), so binding explicitly is the safe form.
    m_program->bind();
    m_uniforms.time       = m_program->uniformLocation("iTime");
    m_uniforms.timeDelta  = m_program->uniformLocation("iTimeDelta");
    m_uniforms.frame      = m_program->uniformLocation("iFrame");
    m_uniforms.resolution = m_program->uniformLocation("iResolution");
    m_program->release();

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

void GraphicsRenderer::applyUniforms(const GraphicsFrame& frame)
{
    if (!m_program || !m_program->isLinked())
        return;

    // A shader that declares none of these is perfectly valid - the ramp the
    // default shader draws is static - so this is reported once, as information,
    // and not repeated every frame. It is worth saying out loud because "my
    // uniform has no effect" is otherwise indistinguishable from "my shader
    // declared it but nothing is setting it".
    if (m_uniforms.time < 0 && m_uniforms.timeDelta < 0 && m_uniforms.frame < 0
        && m_uniforms.resolution < 0)
    {
        if (!m_reportedNoUniforms)
        {
            m_reportedNoUniforms = true;
            GraphicsLog::info(QStringLiteral("shader declares none of iTime/iTimeDelta/iFrame/iResolution; "
                                             "the frame values are not being used"));
        }
        return;
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

int GraphicsRenderer::reloadAll()
{
    // Copy first: reloadShaders() does not add or remove renderers, but iterating
    // a container that a callee could in principle touch is a habit worth keeping.
    const QList<GraphicsRenderer*> renderers = liveRenderers().values();

    int ok = 0;
    for (GraphicsRenderer* r : renderers)
    {
        QOpenGLContext* ctx = QOpenGLContext::currentContext();
        QSurface* surface = ctx ? ctx->surface() : nullptr;
        if (!surface)
        {
            GraphicsLog::warn(QStringLiteral("reload: a renderer has no current surface; skipped"));
            continue;
        }
        if (ctx->makeCurrent(surface) && r->reloadShaders())
            ++ok;
        ctx->doneCurrent();
    }

    if (renderers.isEmpty())
        GraphicsLog::info(QStringLiteral("reload: no live renderer to reload"));
    else
        GraphicsLog::info(QStringLiteral("reload: %1 of %2 renderer(s) reloaded")
                              .arg(ok).arg(renderers.size()));
    return ok;
}

bool GraphicsRenderer::render(const GraphicsFrame& frame)
{
    if (!m_fbo || !m_fbo->isValid())
    {
        GraphicsLog::error(QStringLiteral("renderer: render requested with no framebuffer"));
        return false;
    }

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    QOpenGLFunctions* f = ctx ? ctx->functions() : nullptr;
    if (!f)
    {
        GraphicsLog::error(QStringLiteral("renderer: render requested with no current context"));
        return false;
    }

    m_fbo->bind();
    // The framebuffer is the whole pass, and the whole pass is what gets drawn.
    const bool ok = renderToBoundFramebuffer(m_size, QRect(QPoint(0, 0), m_size), frame);
    m_fbo->release();
    return ok;
}

bool GraphicsRenderer::renderToBoundFramebuffer(const QSize& passSize, const QRect& destinationRect,
                                                const GraphicsFrame& frame)
{
    if (!passSize.isValid() || passSize.isEmpty())
    {
        GraphicsLog::error(QStringLiteral("renderer: refusing to draw into a %1x%2 pass")
                               .arg(passSize.width())
                               .arg(passSize.height()));
        return false;
    }

    if (destinationRect.isEmpty())
    {
        // Nothing visible - the window is smaller than a pixel, or the crop
        // rectangle came out empty. Not an error worth reporting every frame, and
        // drawing nothing is the correct response.
        return true;
    }

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    QOpenGLFunctions* f = ctx ? ctx->functions() : nullptr;
    if (!f)
    {
        GraphicsLog::error(QStringLiteral("renderer: draw requested with no current context"));
        return false;
    }

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
    // glViewport's arguments are in framebuffer pixels with the origin at the
    // BOTTOM-left, matching GL's convention. The rectangle handed in is in
    // top-left-origin surface coordinates, which is what Qt and every caller
    // reason in, so the y is converted here - once, in the one place that talks to
    // GL - rather than leaving each caller to remember it.
    const int glY = passSize.height() - (destinationRect.y() + destinationRect.height());
    f->glViewport(destinationRect.x(), glY, destinationRect.width(), destinationRect.height());

    // Reported once per distinct viewport, so a crop that lands somewhere
    // unexpected is visible in the log rather than only on screen. Throttled
    // because this runs every frame and only the change is interesting.
    GraphicsLog::throttled(GraphicsLog::Level::Info,
                           QStringLiteral("draw: pass %1x%2, viewport %3,%4 %5x%6 (top-left y %7)")
                               .arg(passSize.width()).arg(passSize.height())
                               .arg(destinationRect.x()).arg(glY)
                               .arg(destinationRect.width()).arg(destinationRect.height())
                               .arg(destinationRect.y()),
                           2000);

    // Clear first so anything the shader does not cover is a known colour rather
    // than whatever was in the buffer before.
    f->glClearColor(kClearR, kClearG, kClearB, kClearA);
    f->glClear(GL_COLOR_BUFFER_BIT);

    if (m_program && m_program->isLinked())
    {
        m_program->bind();

        // Uniforms go in after binding the program and before the draw call, which
        // is the only order that works: they are part of the program's state, not
        // the framebuffer's.
        applyUniforms(frame);

        // Attribute locations are hardcoded in passthrough.vert via
        // layout(location = ...), so the same numbers are used here. Bound and
        // enabled per frame rather than once at setup: the cost is negligible
        // and it cannot drift out of sync with the VAO state.
        if (m_vbo && m_vao)
        {
            m_vao->bind();
            m_vbo->bind();

            m_program->enableAttributeArray(0);
            m_program->setAttributeBuffer(0, GL_FLOAT, 0, 2, 4 * sizeof(float));
            m_program->enableAttributeArray(1);
            m_program->setAttributeBuffer(1, GL_FLOAT, 2 * sizeof(float), 2, 4 * sizeof(float));

            // Six vertices: two triangles forming the full-screen quad.
            f->glDrawArrays(GL_TRIANGLES, 0, 6);

            m_program->disableAttributeArray(0);
            m_program->disableAttributeArray(1);
            m_vbo->release();
            m_vao->release();
        }

        m_program->release();
    }

    const GLenum err = f->glGetError();
    if (err != GL_NO_ERROR)
    {
        GraphicsLog::error(QStringLiteral("renderer: GL error 0x%1 after draw").arg(err, 0, 16));
        return false;
    }
    return true;
}

bool GraphicsRenderer::readPixels(QSize* sizeOut, std::unique_ptr<unsigned char[]>* pixelsOut)
{
    if (!m_fbo || !m_fbo->isValid())
    {
        GraphicsLog::error(QStringLiteral("renderer: readback requested with no framebuffer"));
        return false;
    }

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    QOpenGLFunctions* f = ctx ? ctx->functions() : nullptr;
    if (!f)
    {
        GraphicsLog::error(QStringLiteral("renderer: readback requested with no current context"));
        return false;
    }

    const int w = m_size.width();
    const int h = m_size.height();
    const size_t bytes = size_t(w) * size_t(h) * 4;
    auto buffer = std::make_unique<unsigned char[]>(bytes);

    // Bind first: glReadPixels reads from the currently bound framebuffer.
    m_fbo->bind();
    f->glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, buffer.get());
    m_fbo->release();

    const GLenum err = f->glGetError();
    if (err != GL_NO_ERROR)
    {
        GraphicsLog::error(QStringLiteral("renderer: glReadPixels reported GL error 0x%1")
                               .arg(err, 0, 16));
        return false;
    }

    if (sizeOut)
        *sizeOut = m_size;
    if (pixelsOut)
        *pixelsOut = std::move(buffer);
    return true;
}

bool GraphicsRenderer::channelClose(unsigned char actual, float expected) const
{
    return std::abs(int(actual) - toByte(expected)) <= kChannelTolerance;
}

bool GraphicsRenderer::verifyShaderOutput()
{
    if (!m_fbo || !m_fbo->isValid())
    {
        GraphicsLog::error(QStringLiteral("renderer: verify requested with no framebuffer"));
        return false;
    }

    // Draw the test pattern rather than the current default shader. The check is
    // of the pipeline - buffer, attributes, projection, framebuffer, readback -
    // and needs a known image to compare against, which default.frag deliberately
    // is not.
    auto anchors = buildProgram(QStringLiteral("passthrough.vert"), QStringLiteral("anchors.frag"));
    if (!anchors)
    {
        GraphicsLog::error(QStringLiteral("renderer: could not build the verification shader"));
        return false;
    }
    std::unique_ptr<QOpenGLShaderProgram> saved = std::move(m_program);
    m_program = std::move(anchors);

    // Restore the default program however this returns, so a failed verification
    // does not leave the test pattern on screen.
    struct Restore
    {
        std::unique_ptr<QOpenGLShaderProgram>* slot;
        std::unique_ptr<QOpenGLShaderProgram>* saved;
        ~Restore() { *slot = std::move(*saved); }
    } restore{ &m_program, &saved };

    // A fixed frame, deliberately: the verification pattern must not vary with
    // wall-clock time, or its expected pixel values would not be constants and the
    // check could not be written down. A shader that animates is free to ignore
    // these values, and a test pattern that animated would be untestable.
    if (!render(GraphicsFrame()))
        return false;

    QSize readSize;
    std::unique_ptr<unsigned char[]> pixels;
    if (!readPixels(&readSize, &pixels))
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
