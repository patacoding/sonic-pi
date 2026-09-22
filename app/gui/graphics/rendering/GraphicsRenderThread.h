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

    explicit GraphicsRenderThread(QObject* parent = nullptr);
    ~GraphicsRenderThread() override;

    // Set before start(). Logs what the driver actually gave us.
    void setVerbose(bool verbose) { m_verbose = verbose; }

    bool contextIsValid() const { return m_contextOk; }
    QString rendererName() const { return m_renderer; }

    // Ask the loop to finish and block until the thread has stopped.
    void shutdown();

protected:
    void run() override;

private:
    // KHR_debug style callback target, if the driver offers one.
    void installDebugLogger();

    std::unique_ptr<QOpenGLContext>   m_context;
    std::unique_ptr<QOffscreenSurface> m_surface;
    bool    m_verbose   = true;
    bool    m_contextOk = false;
    QString m_renderer;
    QString m_version;
};

} // namespace SonicPi
