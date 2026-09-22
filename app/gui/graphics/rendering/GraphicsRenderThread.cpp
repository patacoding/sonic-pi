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

#include "GraphicsRenderThread.h"
#include "GraphicsLog.h"

#include <QOffscreenSurface>
#include <QOpenGLContext>
#include <QOpenGLFunctions>
#include <QSurfaceFormat>

namespace SonicPi
{

namespace
{
QString glString(QOpenGLFunctions* f, unsigned name)
{
    const auto* s = f->glGetString(name);
    return s ? QString::fromLatin1(reinterpret_cast<const char*>(s)) : QStringLiteral("(null)");
}
} // namespace

QSurfaceFormat GraphicsRenderThread::requestedFormat()
{
    QSurfaceFormat fmt;
    // Explicitly 3.3 Core. See the header: the Qt default is 2.0 with no
    // profile, which would deny both the FBO and `#version 330 core`.
    fmt.setVersion(3, 3);
    fmt.setProfile(QSurfaceFormat::CoreProfile);
    fmt.setRenderableType(QSurfaceFormat::OpenGL);
    fmt.setDepthBufferSize(0);      // 2D fullscreen shader work needs no depth
    fmt.setStencilBufferSize(0);
    fmt.setSwapInterval(1);         // let vsync pace us rather than a busy loop
    return fmt;
}

GraphicsRenderThread::GraphicsRenderThread(QObject* parent)
    : QThread(parent)
{
    setObjectName(QStringLiteral("GraphicsRenderThread"));
}

GraphicsRenderThread::~GraphicsRenderThread()
{
    shutdown();
}

void GraphicsRenderThread::shutdown()
{
    if (!isRunning())
        return;
    requestInterruption();
    if (!wait(5000))
    {
        GraphicsLog::warn(QStringLiteral("render thread did not stop within 5s"));
    }
}

void GraphicsRenderThread::installDebugLogger()
{
    if (!m_context->hasExtension(QByteArrayLiteral("GL_KHR_debug")))
    {
        GraphicsLog::info(QStringLiteral("  debug output : GL_KHR_debug not offered"));
        return;
    }

    QOpenGLFunctions* f = m_context->functions();
    if (!f)
        return;

    using DebugCallback = void (*)(unsigned, unsigned, unsigned, unsigned,
                                   int, const char*, const void*);
    auto callback = [](unsigned /*source*/, unsigned type, unsigned /*id*/,
                       unsigned severity, int /*length*/, const char* message,
                       const void* /*userParam*/) {
        // Notifications are the driver's perf hints and are far too chatty to
        // keep; anything at Low or above is worth knowing about.
        constexpr unsigned kDebugSeverityNotification = 0x826B;
        constexpr unsigned kDebugTypeError            = 0x824C;
        if (severity == kDebugSeverityNotification)
            return;
        const bool isError = (type == kDebugTypeError);
        GraphicsLog::write(isError ? GraphicsLog::Level::Error : GraphicsLog::Level::Info, QStringLiteral("  GL %1: %2")
                   .arg(isError ? QStringLiteral("ERROR") : QStringLiteral("message"),
                        QString::fromLatin1(message ? message : "(null)")));
    };

    auto glDebugMessageCallback =
        reinterpret_cast<void (*)(DebugCallback, const void*)>(
            m_context->getProcAddress("glDebugMessageCallback"));
    if (!glDebugMessageCallback)
    {
        GraphicsLog::warn(QStringLiteral("  debug output : GL_KHR_debug present but no callback entry point"));
        return;
    }

    glDebugMessageCallback(callback, nullptr);
    // GL_DEBUG_OUTPUT_SYNCHRONOUS == 0x8242: report on the offending call rather
    // than asynchronously, so messages line up with the code that caused them.
    f->glEnable(0x8242);
    GraphicsLog::info(QStringLiteral("  debug output : GL_KHR_debug installed"));
}

void GraphicsRenderThread::run()
{
    const QSurfaceFormat fmt = requestedFormat();

    m_context = std::make_unique<QOpenGLContext>();
    m_context->setFormat(fmt);
    if (!m_context->create())
    {
        GraphicsLog::error(QStringLiteral("could not create the OpenGL context"));
        return;
    }

    m_surface = std::make_unique<QOffscreenSurface>();
    m_surface->setFormat(fmt);
    m_surface->create();
    if (!m_surface->isValid())
    {
        GraphicsLog::error(QStringLiteral("could not create the offscreen surface"));
        return;
    }

    // QOpenGLFunctions must only be obtained while the context is current;
    // doing it earlier is a fatal error in Qt.
    if (!m_context->makeCurrent(m_surface.get()))
    {
        GraphicsLog::error(QStringLiteral("could not make the context current"));
        return;
    }

    {
        QOpenGLFunctions* f = m_context->functions();
        if (f)
        {
            m_renderer = glString(f, GL_RENDERER);
            m_version  = glString(f, GL_VERSION);
            m_contextOk = true;

            if (m_verbose)
            {
                GraphicsLog::info(QStringLiteral("context ready"));
                GraphicsLog::info(QStringLiteral("  vendor   : ") + glString(f, GL_VENDOR));
                GraphicsLog::info(QStringLiteral("  renderer : ") + m_renderer);
                GraphicsLog::info(QStringLiteral("  version  : ") + m_version);
                GraphicsLog::info(QStringLiteral("  glsl     : ") + glString(f, GL_SHADING_LANGUAGE_VERSION));
                GraphicsLog::info(QStringLiteral("  profile  : ")
                       + (m_context->format().profile() == QSurfaceFormat::CoreProfile
                              ? QStringLiteral("Core")
                              : QStringLiteral("non-Core")));
            }
        }
        else
        {
            GraphicsLog::error(QStringLiteral("context has no QOpenGLFunctions"));
        }
    }

    installDebugLogger();

    // ---- Phase 0.2 onward hooks in here --------------------------------
    // Step 0.1 stops at "the context exists and reports itself". The render
    // loop, the FBO and the readback check land in the following steps so each
    // can be verified on its own.
    // --------------------------------------------------------------------

    m_context->doneCurrent();
}

} // namespace SonicPi
