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

#pragma once

#include "GraphicsRenderer.h"

#include <QThread>
#include <QString>
// Returned by value below, so this one cannot be a forward declaration.
#include <QSurfaceFormat>

#include <memory>

class QOffscreenSurface;
class QOpenGLContext;

namespace SonicPi
{

// The Graphics renderer's own thread and its own OpenGL context.
//
// Why a separate context rather than the GUI's: the render loop must not be
// blocked by GUI work, and a shader compile can take 100ms to 1s. The context
// is paired with a QOffscreenSurface so this thread needs no window of its own.
//
// Threading contract: the context is created *inside* run(), and is current on
// this thread only. Nothing outside this thread may make it current, and the
// context must be released before the thread stops. All GL entry points must be
// obtained while the context is current - QOpenGLFunctions fatal-errors
// otherwise.
class GraphicsRenderThread : public QThread
{
    Q_OBJECT

public:
    // The surface format every Graphics context must use. The Qt default is
    // OpenGL 2.0 with no profile, which silently denies the FBO and the
    // `#version 330 core` shaders this feature is built on, so it is requested
    // explicitly. Shared between this thread and the display window so their
    // contexts end up shareable.
    static QSurfaceFormat requestedFormat();

    // NOTE on starting this: do not block the caller on it.
    //
    // Creating a GL context pulls in the GPU driver, which is not cheap - on
    // this machine it measured around four seconds. Running it on the startup
    // critical path delayed audio device setup far enough that Spider's
    // five-second promise timed out in load_synthdefs, and Sonic Pi failed to
    // boot. Connect to contextReady() instead, or start it from a worker.
    //
    // contextReady() is emitted from the render thread once the context exists
    // (or has failed), so the result can be reported without waiting.

    explicit GraphicsRenderThread(QObject* parent = nullptr);
    ~GraphicsRenderThread() override;

    // Set before start(). Logs what the driver actually gave us.
    void setVerbose(bool verbose) { m_verbose = verbose; }

    bool contextIsValid() const { return m_contextOk; }
    QString rendererName() const { return m_renderer; }

    // Result of the Phase 0.2 framebuffer readback check. False if the check did
    // not run, so a caller cannot mistake "not attempted" for "passed".
    bool renderVerified() const { return m_renderVerified; }

    // Ask the loop to finish and block until the thread has stopped.
    void shutdown();

signals:
    // Emitted from the render thread once the context succeeds or fails. Lets a
    // caller report the outcome without blocking on start(), which matters
    // because context creation is slow enough to break Sonic Pi's boot if it
    // runs on the critical path.
    void contextReady(bool ok);

protected:
    void run() override;

private:
    // KHR_debug style callback target, if the driver offers one.
    void installDebugLogger();

    std::unique_ptr<QOpenGLContext>   m_context;
    std::unique_ptr<QOffscreenSurface> m_surface;
    // Declared after the context so it is destroyed before it - the framebuffer
    // needs a current context to tear down. run() also resets it explicitly
    // before releasing the context, so this ordering is belt and braces.
    std::unique_ptr<GraphicsRenderer> m_gfxRenderer;
    bool    m_verbose   = true;
    bool    m_contextOk = false;
    bool    m_renderVerified = false;
    // The GL_RENDERER string. Distinct from m_gfxRenderer, which is the object
    // that draws.
    QString m_renderer;
    QString m_version;
};

} // namespace SonicPi
