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
#include "GraphicsSharedFrame.h"
#include "GraphicsTarget.h"

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

    // Where this thread publishes the frame it has just drawn, for the output
    // window to display.
    //
    // Handed in rather than owned, because the same slot has to reach the window,
    // which lives on the GUI thread. Must be set before start(): the loop publishes
    // from its first frame, and a slot set later would silently drop early frames.
    //
    // Null is legal and means "publish nowhere" - the loop then runs without a
    // consumer, which is the case when no window will ever be shown.
    void setSharedFrameSlot(GraphicsSharedFrameSlot* slot) { m_sharedFrame = slot; }


    // The size the render target should be, in pixels.
    //
    // Set once from the user's configured output resolution. It is not driven by
    // the output window: the window crops this image rather than defining it, so
    // resizing the window must not change what is rendered or what an external
    // consumer receives.
    //
    // Kept as a request rather than a direct assignment because the framebuffer
    // belongs to this thread's context and only this thread may make that context
    // current. Nothing here allocates or touches GL, so it is safe to call from any
    // thread at any time; the render thread applies it at the top of its next
    // frame.
    //
    // A request that differs from the current size is not applied until that
    // frame, so callers should not expect the change to have happened on return.
    void setRenderTargetSize(const QSize& sizeInPixels);

    // The size currently being rendered into. May differ from the last requested
    // size until the render thread has applied it.
    QSize renderTargetSize() const;

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

    // Apply a pending setRenderTargetSize() request, rebuilding the framebuffer at
    // the top of a frame. Returns true if the target was rebuilt. Must be called
    // with the context current.
    bool applyRenderTargetSizeRequest();

    std::unique_ptr<QOpenGLContext>   m_context;
    std::unique_ptr<QOffscreenSurface> m_surface;

    // Guards the renderer and the targets against the reload request racing the
    // loop.
    //
    // The loop holds it for the whole of a frame's draw, which is what makes a
    // reload safe: a reload cannot land in the middle of a draw. It does NOT
    // protect the texture a consumer samples - see the double-buffer note below.
    mutable QMutex m_rendererMutex;

    // The shader program and geometry. One, not two: only the render TARGET is
    // duplicated for double buffering, so there is one program, one set of uniform
    // locations, and one compile per reload.
    //
    // Declared after the context so it is destroyed before it - GL objects need a
    // current context to tear down. run() also resets explicitly before releasing the
    // context, so this ordering is belt and braces.
    std::unique_ptr<GraphicsRenderer> m_gfxRenderer;

    // The two render targets, alternating.
    //
    // Two textures rather than one because "show the last complete frame" requires
    // there to BE a last complete frame: with a single texture the consumer samples
    // the same memory the producer is writing, and there is nothing to fall back to.
    // The producer writes whichever target is NOT currently published, so the one a
    // consumer is reading is never written until the next publish.
    static constexpr int kTargetCount = 2;
    std::unique_ptr<GraphicsTarget> m_targets[kTargetCount];
    // Index of the target currently published for consumers, or -1 before the first
    // frame. Written only by this thread.
    int m_readyIndex = -1;

    // Completion fences, one per target.
    //
    // Placed after a target's draw and published with it, so a consumer can wait for
    // the frame to be finished before sampling. This is the access protection the
    // design lacked: without it a consumer reads memory whose draw has been issued
    // but not completed, which shows up as flicker between a finished and a partial
    // image.
    //
    // Owned by the producer's context and deleted by it.
    //
    // Deletion is deferred by one frame, which is not tidiness but correctness: a
    // consumer reads a fence handle from the slot and then waits on it, so deleting
    // a fence it may still hold is undefined behaviour. m_retiredFence holds the
    // previous frame's fence so it is only freed once a consumer cannot still be
    // holding it.
    GLsync m_targetFence[kTargetCount] = { nullptr, nullptr };
    GLsync m_retiredFence[kTargetCount] = { nullptr, nullptr };

    // How many times waiting for the consumer to release a target hit its 500ms bound.
    //
    // NOT by itself a fault: a window mode change blocks the GUI thread for about
    // 500ms on Windows, during which the consumer genuinely cannot release the target.
    // The producer draws anyway and recovers within a frame. A count that keeps growing
    // is the interesting case - that means a consumer is persistently not reading.
    quint64 m_waitTimeouts = 0;

    // How many times glClientWaitSync returned GL_WAIT_FAILED, which is a different
    // thing entirely: the fence cannot be waited on from this context at all (wrong
    // share group, or already deleted). Expected to stay at zero.
    quint64 m_waitFailures = 0;

    bool    m_verbose   = true;
    bool    m_contextOk = false;
    bool    m_renderVerified = false;
    // Frame rate ceiling. 0 means use kDefaultFrameCapHz.
    int     m_targetFps = 0;

    // Not owned. See setSharedFrameSlot().
    GraphicsSharedFrameSlot* m_sharedFrame = nullptr;
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

    // The requested and the actual render target size. Kept as plain ints in
    // atomics rather than a QSize because QSize is not lock-free to read
    // concurrently; -1 means "nothing requested yet".
    std::atomic<int>       m_requestedWidth{-1};
    std::atomic<int>       m_requestedHeight{-1};
    std::atomic<int>       m_actualWidth{0};
    std::atomic<int>       m_actualHeight{0};

    // Used to sleep until the next frame deadline and to be woken immediately on
    // shutdown, so stopping never waits out a whole frame interval.
    QMutex         m_paceMutex;
    QWaitCondition m_paceWait;
};

} // namespace SonicPi
