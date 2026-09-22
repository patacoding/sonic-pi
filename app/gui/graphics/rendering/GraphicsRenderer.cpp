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

#include <QOpenGLContext>
#include <QOpenGLFramebufferObject>
#include <QOpenGLFramebufferObjectFormat>

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

bool channelClose(unsigned char actual, float expected)
{
    return std::abs(int(actual) - toByte(expected)) <= kChannelTolerance;
}
} // namespace

GraphicsRenderer::~GraphicsRenderer()
{
    // QOpenGLFramebufferObject's destructor needs the context that created it to
    // be current. The render thread releases the context after this object is
    // gone, so by then it is safe; asserting here would false-positive during
    // teardown, so the contract is documented instead:
    //   GraphicsRenderer must be destroyed while its context is current.
    m_fbo.reset();
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
    // is created as a plain 2D colour texture rather than a multisampled one:
    // multisampled attachments would need a resolve blit before anything else
    // could read them.
    fmt.setSamples(0);

    m_fbo = std::make_unique<QOpenGLFramebufferObject>(size, fmt);
    if (!m_fbo || !m_fbo->isValid())
    {
        GraphicsLog::error(QStringLiteral("renderer: framebuffer object is not valid"));
        m_fbo.reset();
        return false;
    }

    m_size = size;
    GraphicsLog::info(QStringLiteral("framebuffer ready: %1x%2, texture id %3")
                          .arg(size.width())
                          .arg(size.height())
                          .arg(m_fbo->texture()));
    return true;
}

bool GraphicsRenderer::readPixels(QSize* sizeOut, std::unique_ptr<unsigned char[]>* pixelsOut)
{
    if (!m_fbo || !m_fbo->isValid())
    {
        GraphicsLog::error(QStringLiteral("renderer: readback requested with no framebuffer"));
        return false;
    }

    QOpenGLFunctions* f = QOpenGLContext::currentContext()
                              ? QOpenGLContext::currentContext()->functions()
                              : nullptr;
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

bool GraphicsRenderer::colourMatches(const unsigned char* rgba) const
{
    return channelClose(rgba[0], kClearR) && channelClose(rgba[1], kClearG)
           && channelClose(rgba[2], kClearB) && channelClose(rgba[3], kClearA);
}

bool GraphicsRenderer::verifyClearColour()
{
    if (!m_fbo || !m_fbo->isValid())
    {
        GraphicsLog::error(QStringLiteral("renderer: verify requested with no framebuffer"));
        return false;
    }

    QOpenGLContext* ctx = QOpenGLContext::currentContext();
    QOpenGLFunctions* f = ctx ? ctx->functions() : nullptr;
    if (!f)
    {
        GraphicsLog::error(QStringLiteral("renderer: verify requested with no current context"));
        return false;
    }

    m_fbo->bind();
    f->glClearColor(kClearR, kClearG, kClearB, kClearA);
    f->glClear(GL_COLOR_BUFFER_BIT);
    m_fbo->release();

    QSize readSize;
    std::unique_ptr<unsigned char[]> pixels;
    if (!readPixels(&readSize, &pixels))
        return false;

    // The clear is a uniform colour, so checking a few points is enough to catch
    // "nothing was drawn" and "the wrong thing was bound". Corner-to-corner plus
    // the centre, rather than every pixel.
    const int w = readSize.width();
    const int h = readSize.height();
    const struct { int x; int y; const char* label; } points[] = {
        { 0,        0,        "bottom-left" },
        { w - 1,    0,        "bottom-right" },
        { 0,        h - 1,    "top-left" },
        { w - 1,    h - 1,    "top-right" },
        { w / 2,    h / 2,    "centre" },
    };

    bool allOk = true;
    for (const auto& p : points)
    {
        const size_t offset = (size_t(p.y) * size_t(w) + size_t(p.x)) * 4;
        const unsigned char* px = pixels.get() + offset;
        const bool ok = colourMatches(px);
        allOk = allOk && ok;

        GraphicsLog::info(QStringLiteral("  %1 (%2,%3) = rgba(%4,%5,%6,%7) %8")
                              .arg(QString::fromLatin1(p.label))
                              .arg(p.x)
                              .arg(p.y)
                              .arg(px[0])
                              .arg(px[1])
                              .arg(px[2])
                              .arg(px[3])
                              .arg(ok ? QStringLiteral("ok") : QStringLiteral("MISMATCH")));
    }

    const QString expected = QStringLiteral("expected rgba(%1,%2,%3,%4) +/-%5")
                                 .arg(toByte(kClearR))
                                 .arg(toByte(kClearG))
                                 .arg(toByte(kClearB))
                                 .arg(toByte(kClearA))
                                 .arg(kChannelTolerance);

    if (allOk)
    {
        GraphicsLog::info(QStringLiteral("readback verified: %1x%2, %3")
                              .arg(w).arg(h).arg(expected));
    }
    else
    {
        GraphicsLog::error(QStringLiteral("readback FAILED: %1").arg(expected));
    }
    return allOk;
}

} // namespace SonicPi
