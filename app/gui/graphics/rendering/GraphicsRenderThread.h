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
#include <QMutex>
#include <QWaitCondition>
// Returned by value below, so this one cannot be a forward declaration.
#include <QSurfaceFormat>

#include <atomic>
#include <memory>

class QOffscreenSurface;
class QOpenGLContext;

namespace SonicPi
{

// Measures the render loop's output rate gives the window something to display
// later, and is the evidence step 0.4 is judged on.
//
// Written only by the render thread and read from anywhere, so every field is
// atomic: a reader sees a consistent snapshot of counters rather than a torn
// one. It is deliberately plain atomics rather than a mutex - the readers are
// diagnostic (the window's status line, a log line) and must never be able to
// stall a frame.
struct GraphicsFrameStats
{
    quint64 frames        = 0;   // frames drawn since the loop started
    double  fps           = 0.0; // average over the last reporting window
    double  lastFrameMs   = 0.0; // CPU time of the most recent frame
    double  worstFrameMs  = 0.0; // largest frame time in the current window
    bool    loopRunning   = false;
    bool    hung          = false; // stopped by the driver-watchdog guard
};

// The Graphics renderer's own thread, its own OpenGL context, and its frame loop.
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
//
// Shader reload is a request, not a call. The context belongs to this thread, so
// a reloader on another thread cannot make it current; requestShaderReload()
// sets a flag that the loop picks up on its next iteration, where the context is
// current by construction.
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

    // Frame rate cap used when nothing else is configured.
    //
    // A cap, not a fixed rate: the loop paces to this and no faster. It exists so
    // the renderer cannot monopolise the machine - this is an optional feature
    // running beside an audio engine that must not stutter - and it is what makes
    // the CPU cost of graphics predictable regardless of how cheap a particular
    // shader happens to be. 60 is the design's V1 figure and the common display
    // refresh rate; 75 or 144 suit a display that runs faster.
    static constexpr int kDefaultFrameCapHz = 60;

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

    // The frame rate ceiling, in Hz. Zero or negative means "use the default".
    // Set before start(); changing it later would need the loop to re-read it, and
    // nothing needs that yet.
    void setTargetFps(int fps) { m_targetFps = fps; }

    bool contextIsValid() const { return m_contextOk; }
    QString rendererName() const { return m_renderer; }

    // Result of the Phase 0 framebuffer readback check. False if the check did
    // not run, so a caller cannot mistake "not attempted" for "passed".
    bool renderVerified() const { return m_renderVerified; }

    // A snapshot of the loop's counters. Safe from any thread.
    GraphicsFrameStats frameStats() const;

    // Ask for the shader files to be re-read. Applied at the top of the next
    // frame; returns immediately. Returns false if there is no running loop to
    // apply it, in which case nothing will happen.
    bool requestShaderReload();

    // Ask the loop to finish and block until the thread has stopped.
    //
    // Safe to call more than once and safe when the thread was never started.
    // The wait is bounded: a thread that will not stop is reported and left
    // running rather than hanging application shutdown.
    void shutdown();

signals:
    // Emitted from the render thread once the context succeeds or fails. Lets a
    // caller report the outcome without blocking on start(), which matters
    // because context creation is slow enough to break Sonic Pi's boot if it
    // runs on the critical path.
    void contextReady(bool ok);

    // Emitted from the render thread on every stats window. Queued to whoever
    // wants it, so nothing blocks the loop.
    void frameStatsUpdated();

protected:
    void run() override;

private:
    // KHR_debug style callback target, if the driver offers one.
    void installDebugLogger();

    // Re-read the shader files. Must be called with the context current.
    void applyShaderReload();

    std::unique_ptr<QOpenGLContext>   m_context;
    std::unique_ptr<QOffscreenSurface> m_surface;

    // Guards m_gfxRenderer against the reload request racing the loop.
    //
    // The loop holds it for the whole of a frame's draw, which is also what makes
    // the reload safe: a reload cannot land in the middle of a draw. Held for a
    // 16ms frame it adds no measurable contention, because the only other user is
    // a flag-setter that does not take it at all.
    mutable QMutex m_rendererMutex;

    // Declared after the context so it is destroyed before it - the framebuffer
    // needs a current context to tear down. run() also resets it explicitly
    // before releasing the context, so this ordering is belt and braces.
    std::unique_ptr<GraphicsRenderer> m_gfxRenderer;

    bool    m_verbose   = true;
    bool    m_contextOk = false;
    bool    m_renderVerified = false;
    // Frame rate ceiling. 0 means use kDefaultFrameCapHz.
    int     m_targetFps = 0;
    // The GL_RENDERER string. Distinct from m_gfxRenderer, which is the object
    // that draws.
    QString m_renderer;
    QString m_version;

    // Loop state. Written by the render thread, read by anyone.
    std::atomic<bool>      m_reloadRequested{false};
    std::atomic<quint64>   m_frames{0};
    std::atomic<double>    m_fps{0.0};
    std::atomic<double>    m_lastFrameMs{0.0};
    std::atomic<double>    m_worstFrameMs{0.0};
    std::atomic<bool>      m_loopRunning{false};
    // Set when the loop stopped because a frame hit the driver-watchdog limit
    // rather than because it was asked to. Distinct from "stopped", because the
    // two need different reporting.
    std::atomic<bool>      m_hung{false};

    // Used to sleep until the next frame deadline and to be woken immediately on
    // shutdown, so stopping never waits out a whole frame interval.
    QMutex         m_paceMutex;
    QWaitCondition m_paceWait;
};

} // namespace SonicPi
