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
#include "GraphicsSettings.h"

#include <QElapsedTimer>
#include <QOffscreenSurface>
#include <QOpenGLContext>
#include <QOpenGLFunctions>
#include <QOpenGLExtraFunctions>
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

    // Run below normal priority, deliberately.
    //
    // Graphics is an optional feature of this application, not part of it: the
    // audio engine is the thing that must not stutter, and this thread is a pure
    // competitor for CPU with no realtime requirement of its own. A shader frame
    // can always be shown a frame late; an audio buffer underrun cannot. Lowering
    // the priority is what makes the operating system resolve that conflict the
    // right way, without either side needing to cooperate.
    //
    // Set here rather than at the start() call site so it cannot be forgotten
    // there. Note this does NOT start the thread: starting happens in main.cpp
    // after contextReady() is connected, and starting it here would re-introduce
    // the race that once broke Sonic Pi's boot.
    setPriority(QThread::LowestPriority);
}

GraphicsRenderThread::~GraphicsRenderThread()
{
    shutdown();
}

void GraphicsRenderThread::shutdown()
{
    // Order matters: set the flag first so a loop that is about to check it sees
    // the request, then wake the pacer so it does not sit out the rest of a frame
    // interval, then interrupt as a third signal for anything else waiting.
    m_loopRunning.store(false, std::memory_order_relaxed);
    m_paceWait.wakeAll();

    if (!isRunning())
        return;

    requestInterruption();
    if (!wait(5000))
    {
        GraphicsLog::warn(QStringLiteral("render thread did not stop within 5s"));
    }
}

GraphicsFrameStats GraphicsRenderThread::frameStats() const
{
    GraphicsFrameStats s;
    s.frames       = m_frames.load(std::memory_order_relaxed);
    s.fps          = m_fps.load(std::memory_order_relaxed);
    s.lastFrameMs  = m_lastFrameMs.load(std::memory_order_relaxed);
    s.worstFrameMs = m_worstFrameMs.load(std::memory_order_relaxed);
    s.loopRunning  = m_loopRunning.load(std::memory_order_relaxed);
    s.hung         = m_hung.load(std::memory_order_relaxed);
    return s;
}

bool GraphicsRenderThread::requestShaderReload()
{
    if (!m_loopRunning.load(std::memory_order_relaxed))
    {
        GraphicsLog::warn(QStringLiteral("reload requested but the render loop is not running"));
        return false;
    }
    m_reloadRequested.store(true, std::memory_order_relaxed);
    // Timestamped on request, so the delay before the loop picks it up is
    // measurable rather than a matter of impression. "Reload is unreliable and
    // sometimes takes seconds" is only diagnosable if both ends are timed.
    GraphicsLog::info(QStringLiteral("reload: requested"));
    return true;
}

void GraphicsRenderThread::setRenderTargetSize(const QSize& sizeInDevicePixels)
{
    // Reject nonsense where it enters, so the render loop never has to defend
    // itself against a zero or negative size and cannot be made to allocate an
    // invalid framebuffer by a caller that got its arithmetic wrong.
    if (!sizeInDevicePixels.isValid() || sizeInDevicePixels.isEmpty())
    {
        GraphicsLog::warn(QStringLiteral("ignoring render target size request %1x%2")
                              .arg(sizeInDevicePixels.width())
                              .arg(sizeInDevicePixels.height()));
        return;
    }

    // Written in an order that cannot be observed half-applied: the width doubles
    // as the validity flag, so it is published last. A reader that sees the width
    // is guaranteed to see the matching height.
    m_requestedHeight.store(sizeInDevicePixels.height(), std::memory_order_relaxed);
    m_requestedWidth.store(sizeInDevicePixels.width(), std::memory_order_release);
}

QSize GraphicsRenderThread::renderTargetSize() const
{
    return QSize(m_actualWidth.load(std::memory_order_relaxed),
                 m_actualHeight.load(std::memory_order_relaxed));
}

bool GraphicsRenderThread::applyRenderTargetSizeRequest()
{
    const int w = m_requestedWidth.load(std::memory_order_acquire);
    const int h = m_requestedHeight.load(std::memory_order_relaxed);
    if (w < 0 || h <= 0)
        return false; // nothing requested yet

    if (w == m_actualWidth.load(std::memory_order_relaxed)
        && h == m_actualHeight.load(std::memory_order_relaxed))
        return false; // already the right size

    // Rebuild here, on this thread, because the framebuffers belong to this
    // thread's context. This is also what makes the resize race a non-issue: the old
    // targets are destroyed and new ones created between frames, with the renderer
    // mutex held, so no frame can be in flight against a half-replaced target.
    QMutexLocker lock(&m_rendererMutex);

    // Withdraw the published frame first. The textures are about to be destroyed, and
    // a consumer still holding one of their names would sample a deleted texture -
    // which on some drivers renders nothing and on others faults.
    if (m_sharedFrame)
        m_sharedFrame->clear();
    m_readyIndex = -1;

    const QSize wanted(w, h);

    // The renderer is created once and kept across rebuilds: it owns the program and
    // the geometry, which do not depend on the target size. Recreating it here - as
    // an earlier version did - would recompile the shader on every resize, and would
    // be the first step back towards two of everything.
    if (!m_gfxRenderer)
    {
        m_gfxRenderer = std::make_unique<GraphicsRenderer>();
        if (!m_gfxRenderer->initialize())
        {
            GraphicsLog::error(QStringLiteral("renderer: could not be initialised"));
            m_gfxRenderer.reset();
            return false;
        }
    }

    for (int i = 0; i < kTargetCount; ++i)
    {
        m_targets[i] = std::make_unique<GraphicsTarget>();
        if (!m_targets[i]->create(wanted))
        {
            GraphicsLog::error(QStringLiteral("render target: could not create %1 of %2 at %3x%4; "
                                              "frames will be skipped until the size changes again")
                                   .arg(i + 1).arg(kTargetCount).arg(w).arg(h));
            for (int j = 0; j < kTargetCount; ++j)
                m_targets[j].reset();
            return false;
        }
    }

    m_actualWidth.store(w, std::memory_order_relaxed);
    m_actualHeight.store(h, std::memory_order_relaxed);
    GraphicsLog::info(QStringLiteral("render targets: %1 buffers at %2x%3 (double buffered)")
                          .arg(kTargetCount).arg(w).arg(h));
    return true;
}

void GraphicsRenderThread::applyShaderReload()
{
    GraphicsLog::info(QStringLiteral("reload: applying on the render thread"));

    QElapsedTimer t;
    t.start();

    // Compile WITHOUT holding the render lock.
    //
    // Compilation is the slow part - hundreds of milliseconds - and holding the lock
    // across it stalled the render loop for that whole time. That is what made reload
    // feel unresponsive: clicking during the stall did nothing visible, and whether a
    // click appeared to work depended on where in the stall it landed.
    //
    // So the two halves are split. Compiling needs the context current and nothing
    // else; only installing the result touches state the loop reads. The lock is then
    // held for a pointer swap, which is as close to free as makes no difference.
    //
    // The context is current by construction here - this runs on the render thread -
    // which is exactly what compiling requires and what a caller on another thread
    // cannot provide.
    std::unique_ptr<QOpenGLShaderProgram> replacement;
    {
        // A short lock just to read m_gfxRenderer safely. Not held across the compile.
        QMutexLocker lock(&m_rendererMutex);
        if (!m_gfxRenderer)
        {
            GraphicsLog::warn(QStringLiteral("reload: no renderer to reload"));
            return;
        }
        replacement = m_gfxRenderer->compileReplacement();
    }

    if (!replacement)
    {
        GraphicsLog::info(QStringLiteral("reload: FAILED after %1ms; the previous shader is still in use")
                              .arg(t.elapsed()));
        return;
    }

    // Install it. Held only for the swap, so the loop is not stalled by the compile.
    {
        QMutexLocker lock(&m_rendererMutex);
        if (m_gfxRenderer)
            m_gfxRenderer->adoptProgram(std::move(replacement));
    }

    GraphicsLog::info(QStringLiteral("reload: applied after %1ms").arg(t.elapsed()));
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

    // Join Qt's global share group, explicitly.
    //
    // AA_ShareOpenGLContexts makes Qt create a global share context; it does NOT
    // make a manually created context a member of it. Qt's own documentation is
    // blunt about this ("you can create a new context which shares with the global
    // one"), and the implementation confirms it: QOpenGLContextPrivate::adopt()
    // sets shareGroup from shareContext alone, and drops shareContext entirely if
    // the platform could not create the context as sharing.
    //
    // Measured before this was added: the window's context reported "matches Qt's
    // global group" while this one reported "DIFFERENT from Qt's global group", so
    // the two could not see each other's textures - which is the whole point of the
    // render thread's framebuffer.
    //
    // Set before create(), because the share relationship is fixed at creation.
    // Left unset when there is no global share context, which is a legitimate state
    // (the attribute may be ignored on some platforms); the log below reports which
    // happened rather than leaving it to be discovered later.
    if (QOpenGLContext* global = QOpenGLContext::globalShareContext())
        m_context->setShareContext(global);

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

                // Reported because texture sharing between this context and the
                // output window depends on it, and the failure mode is silent:
                // without a share group everything still runs, the window simply
                // cannot see this context's textures. Printing the group makes
                // "sharing is on" a fact in the log rather than an assumption.
                QOpenGLContext* group = QOpenGLContext::globalShareContext();
                GraphicsLog::info(QStringLiteral("  share group : %1")
                       .arg(!group ? QStringLiteral("NONE (AG has no global share context)")
                                   : (m_context->shareGroup() == group->shareGroup()
                                          ? QStringLiteral("matches Qt's global group")
                                          : QStringLiteral("DIFFERENT from Qt's global group"))));
            }
        }
        else
        {
            GraphicsLog::error(QStringLiteral("context has no QOpenGLFunctions"));
        }
    }

    installDebugLogger();

    // ---- Phase 0.2/0.3: framebuffer, shader, readback verification --------
    // Offscreen rendering has nothing to look at, so "it did not crash" proves
    // nothing. A frame is drawn with the file-loaded shader and its pixels are
    // read back and compared against the pattern that shader is supposed to
    // produce.
    //
    // The pattern comes from anchors.frag, not default.frag: the check is of the
    // pipeline, so it must not depend on - or constrain - whatever picture the
    // default shader happens to draw. The anchors and their expected colours are
    // documented in app/gui/graphics/shaders/anchors.frag.
    //
    // The render target is the user's configured output resolution, fixed for the
    // life of the loop.
    //
    // Fixed rather than derived from the window, by design: the window is a viewer
    // that crops this image, so its size and position affect only what part of the
    // output is on screen. Nothing the user does to the window changes the
    // resolution rendered, and therefore nothing changes what an external consumer
    // such as Spout receives. It also means the loop does not have to wait for a
    // window to exist before it can render.
    //
    // Applied through the same request path a resize would use, so there is one
    // way for the target to change rather than two.
    setRenderTargetSize(GraphicsSettings::outputSize());

    if (!applyRenderTargetSizeRequest())
    {
        GraphicsLog::error(QStringLiteral("render target: could not allocate the configured output size"));
    }

    // Verify once, against one of the targets that was just allocated, so the
    // self-check exercises the same kind of framebuffer the loop will draw into
    // rather than some other size.
    {
        QMutexLocker lock(&m_rendererMutex);
        if (m_gfxRenderer && m_targets[0])
            m_renderVerified = m_gfxRenderer->verifyShaderOutput(*m_targets[0]);
        else
            GraphicsLog::warn(QStringLiteral("no render target; skipping the readback check"));
    }
    // ---------------------------------------------------------------------

    // Tell any listener the context is usable. Emitted from this thread; a queued
    // connection is what a GUI-side receiver needs.
    emit contextReady(m_contextOk);

    // ---- Phase 0.4: the frame loop ----------------------------------------
    //
    // Paced to kFrameIntervalNs by sleeping until the next frame's deadline, then
    // spinning out the last fraction of a millisecond.
    //
    // Both halves of that are load-bearing, and both were found by measurement
    // rather than assumed:
    //
    //   Sleeping is not precise enough on its own. Windows' default timer
    //   granularity is about 15.6ms, and QThread::usleep rounds a request up to
    //   the next timer tick. Asking for 16ms therefore returned in 15.6ms or
    //   31.2ms depending on where the request landed. Measured over 600 frames
    //   the loop ran at ~57fps and then fell to exactly 32fps once whatever had
    //   raised the system timer resolution stopped doing so - 600 frames took 12
    //   seconds instead of 10. The frame itself costs ~0.1ms, so all of that was
    //   sleep error.
    //
    //   So the sleep only has to get close; the last kSpinWindowMs is spun on
    //   QThread::yieldCurrentThread(), which is precise. Spinning the whole
    //   interval would burn a core for no benefit, and sleeping the whole
    //   interval cannot hit the target at all.
    //
    // There is no vsync to lean on here: an offscreen surface has no presentation
    // engine, so the swap interval requested in requestedFormat() does nothing.
    // That is not a limitation for Phase 0 - nothing is being displayed - but it
    // is worth knowing before reading these numbers as if a display were
    // involved.
    //
    // A non-monotonic QElapsedTimer reading is treated as a clock change rather
    // than a negative sleep: QElapsedTimer is monotonic, so this is defensive,
    // but a negative wait would throw.
    constexpr qint64 kSpinWindowMs = 2;

    m_loopRunning.store(true, std::memory_order_relaxed);

    QElapsedTimer frameTimer;
    QElapsedTimer reportTimer;
    frameTimer.start();
    reportTimer.start();

    // A self-check hook. The loop is otherwise unbounded, which makes it awkward
    // to test automatically; with a limit set it stops itself after N frames and
    // the caller can assert on the stats. Unset in normal use.
    const int frameLimit = qEnvironmentVariableIntValue("SONIC_PI_GRAPHICS_FRAME_LIMIT");

    // How long a frame may take before it is treated as a hang rather than a slow
    // frame. Windows' display driver watchdog resets the GPU (TDR) after roughly
    // two seconds of a stalled command stream, and a reset takes every GL context
    // in the process with it. Stopping first turns "the driver died and took the
    // application's graphics with it" into a reportable error.
    constexpr double kFrameHangSeconds = 2.0;

    // The frame interval to pace to, from the user's configured cap.
    //
    // A cap rather than a fixed rate: the loop aims at this and no faster. The
    // cap exists so that the renderer cannot monopolise the machine, because this
    // is an optional feature running alongside an audio engine that must not
    // stutter - see the priority note in the constructor.
    const int capHz = m_targetFps > 0 ? m_targetFps : kDefaultFrameCapHz;
    const qint64 intervalNs = 1000000000LL / capHz;

    // The spin window scales with the interval rather than being a fixed 2ms.
    //
    // Sleep alone cannot hit a sub-millisecond deadline: Windows' timer
    // granularity is about 1ms, and a request is rounded up to the next tick. So
    // the last part of the wait is spun. That part has to stay a small fraction of
    // the interval - a fixed 2ms against a 6.9ms interval (144Hz) throws away most
    // of the frame, and the spin would dominate.
    const qint64 spinWindowNs = qMin(qint64(2000000), intervalNs / 8);

    GraphicsLog::info(QStringLiteral("render loop: started, cap %1Hz, interval %2ns, spin %3us, "
                                     "priority=lowest")
                          .arg(capHz)
                          .arg(intervalNs)
                          .arg(spinWindowNs / 1000));

    quint64 windowFrames = 0;
    double  windowWorstMs = 0.0;
    // How long this loop spent waiting for the consumer to release a target, over the
    // last report window. This is the whole cost of the handoff, and the design says it
    // should be in the microseconds: the fence being waited on was placed a frame
    // earlier, so it has almost always signalled already. A value approaching the frame
    // interval means the consumer is the bottleneck, which is a fact worth reporting
    // rather than a state worth hiding behind a skipped frame.
    qint64  windowWaitUs = 0;
    qint64  windowWaitWorstUs = 0;
    quint64 totalFrames = 0;
    qint64  nextDeadlineNs = frameTimer.nsecsElapsed();

    // The shader's clock is anchored to a fixed instant and read as a difference
    // from it on every frame, rather than accumulated frame by frame.
    //
    // This is the difference between an animation that is still correct after an
    // hour and one that is not. Accumulating a float delta loses precision as the
    // total grows, so a long-running shader starts to stutter even though every
    // individual delta was right - the classic ShaderToy time-drift bug. Anchoring
    // costs nothing and cannot drift.
    const qint64 clockStartNs = frameTimer.nsecsElapsed();
    qint64 lastFrameStartNs = clockStartNs;

    while (m_loopRunning.load(std::memory_order_relaxed) && !isInterruptionRequested())
    {
        const qint64 frameStartNs = frameTimer.nsecsElapsed();

        if (m_reloadRequested.exchange(false, std::memory_order_relaxed))
            applyShaderReload();

        // Applied at the top of the frame, before anything is drawn, so a resize
        // can never land between the clear and the draw. This is the only place
        // the target changes size.
        applyRenderTargetSizeRequest();

        GraphicsFrame frame;
        frame.timeSeconds = double(frameStartNs - clockStartNs) / 1.0e9;
        // Zero on the first frame: there is no previous frame to measure against,
        // and inventing one would be a value a shader could act on.
        frame.deltaSeconds = (totalFrames == 0)
                                 ? 0.0
                                 : double(frameStartNs - lastFrameStartNs) / 1.0e9;
        frame.frameIndex = totalFrames;
        lastFrameStartNs = frameStartNs;

        // Target selection and the one wait in the whole handoff.
        //
        // The rule is one sentence: write whichever target the consumer is not
        // reading. The published index is exactly that target, so the choice is the
        // other one - no flag, no bookkeeping, no way for the two sides to disagree
        // about which texture is which.
        //
        // Then wait for the consumer to have finished with it last time. This is the
        // ONLY place the producer blocks, and it is deliberately a block rather than a
        // skip: a producer that can keep going faster than the consumer can only be
        // rendering something trivially cheap, and letting it run ahead would mean
        // overwriting a texture the consumer is still reading - which is the flicker,
        // not a performance win. Waiting here costs nothing in practice because the
        // fence being waited on was placed a whole frame earlier.
        //
        // Measured, not assumed: the wait is accumulated and reported as `last wait` in
        // the per-second line. It should sit in the microseconds; if it does not, the
        // consumer is genuinely the bottleneck and that is worth seeing.
        const int back = (m_readyIndex == 0) ? 1 : 0;

        if (m_gfxRenderer && m_targets[back])
        {
            GraphicsTarget& target = *m_targets[back];

            QOpenGLExtraFunctions* f = m_context ? m_context->extraFunctions() : nullptr;

            QElapsedTimer wait;
            wait.start();
            if (m_sharedFrame && f)
            {
                GraphicsTargetFence& tf = m_sharedFrame->targetFence(back);

                // Wait for every consumer that has ever read this target.
                //
                // The loop is the only thing multiple consumers change: the producer
                // waits for all of them instead of one. It does not wait LONGER in any
                // meaningful sense - it makes N immediate returns, because all N fences
                // were placed a whole frame ago and have already signalled. See the note
                // on GraphicsTargetFence for the arithmetic and the measurements.
                for (int c = 0; c < GraphicsConsumer::Count; ++c)
                {
                    GLsync consumerFence = tf.consumerFence[c].exchange(nullptr,
                                                                       std::memory_order_acq_rel);
                    if (!consumerFence)
                        continue;   // this consumer has never read this target

                    // A generous bound rather than an infinite one: if a consumer's
                    // context has died, blocking here would take the render loop with it,
                    // and the loop is what keeps the audio engine's thread budget intact.
                    //
                    // Hitting the bound is NOT by itself a fault, and the two return
                    // values must not be conflated because they mean opposite things:
                    //
                    //   GL_TIMEOUT_EXPIRED - that consumer is busy. The producer draws
                    //     anyway, and continuity is worth more than the guarantee. This is
                    //     expected during a window mode change: measured on Windows,
                    //     entering fullscreen blocks the GUI thread for about 500ms, so the
                    //     consumer genuinely does not release the target for that long.
                    //     Recovered within one frame afterwards, with stale at 0.
                    //
                    //   GL_WAIT_FAILED - the fence is not usable from this context at all.
                    //     That is a real bug (a fence from a context outside the share
                    //     group, or one already deleted), and it returns at once rather
                    //     than waiting, so it must not be reported as a timeout.
                    constexpr GLuint64 kWaitNs = 500 * 1000 * 1000;   // 500ms
                    const GLenum r = f->glClientWaitSync(consumerFence,
                                                         GL_SYNC_FLUSH_COMMANDS_BIT,
                                                         kWaitNs);
                    if (r == GL_TIMEOUT_EXPIRED)
                    {
                        ++m_waitTimeouts;
                        GraphicsLog::warn(QStringLiteral("render loop: consumer %1 did not release target %2 "
                                                         "within 500ms; drawing anyway (recovered)")
                                              .arg(c).arg(back));
                    }
                    else if (r == GL_WAIT_FAILED)
                    {
                        ++m_waitFailures;
                        GraphicsLog::error(QStringLiteral("render loop: glClientWaitSync FAILED on target %1 "
                                                          "consumer %2 (0x%3); the fence is not usable from this "
                                                          "context").arg(back).arg(c).arg(r, 0, 16));
                    }
                    // Safe to delete: it has signalled, or we have given up on it and
                    // will never look at it again.
                    f->glDeleteSync(consumerFence);
                }
            }
            const qint64 waitUs = wait.nsecsElapsed() / 1000;
            windowWaitUs += waitUs;
            windowWaitWorstUs = qMax(windowWaitWorstUs, waitUs);

            // Report the size the shader will actually be given, not a second copy
            // of it, so iResolution cannot disagree with the target being drawn
            // into.
            frame.resolution = target.size();
            if (m_gfxRenderer->renderInto(target, frame))
            {
                if (f)
                {
                    // Retire the fence from TWO frames ago, not the one from the
                    // previous frame.
                    //
                    // A consumer reads the fence handle out of the slot and then waits
                    // on it. Deleting a fence that a consumer may still be holding is
                    // undefined behaviour, and the symptom is exactly the flicker being
                    // chased here. Deferring deletion by one further frame means the
                    // fence being retired was published two frames ago, by which time
                    // any consumer has long since either waited on it or moved to a
                    // newer frame.
                    if (m_retiredFence[back])
                    {
                        f->glDeleteSync(m_retiredFence[back]);
                        m_retiredFence[back] = nullptr;
                    }
                    m_retiredFence[back] = m_targetFence[back];
                    m_targetFence[back] = nullptr;

                    m_targetFence[back] = f->glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);

                    // Flush so the fence is actually submitted. Without this the
                    // command may sit in the driver's queue and the fence never
                    // signals, which would make every consumer wait out its timeout.
                    f->glFlush();
                }

                // Publish for consumers. Only after the draw, and the published index
                // is what tells a consumer which target is now the readable one - and
                // therefore which one the next frame must NOT use.
                m_readyIndex = back;
                if (m_sharedFrame)
                    m_sharedFrame->publish(target.texture(), target.size(),
                                           frame.frameIndex, m_targetFence[back], back);
            }
        }

        const double frameMs = double(frameTimer.nsecsElapsed() - frameStartNs) / 1.0e6;
        m_lastFrameMs.store(frameMs, std::memory_order_relaxed);
        if (frameMs > windowWorstMs)
            windowWorstMs = frameMs;
        ++windowFrames;
        ++totalFrames;
        m_frames.store(totalFrames, std::memory_order_relaxed);

        // Report once a second. Per frame would be the 7790-readbacks mistake all
        // over again, only in log form - and every entry also crosses to the GUI
        // thread through the log sink.
        if (reportTimer.elapsed() >= 1000)
        {
            const double secs = double(reportTimer.elapsed()) / 1000.0;
            const double fps = double(windowFrames) / secs;
            m_fps.store(fps, std::memory_order_relaxed);
            m_worstFrameMs.store(windowWorstMs, std::memory_order_relaxed);

            GraphicsLog::info(QStringLiteral("render loop: %1 frames in %2s = %3 fps, last %4ms, worst %5ms, "
                                             "consumer wait avg %6us worst %7us, slow-reader %8, wait-failed %9, "
                                             "iTime %10s, iFrame %11")
                                  .arg(windowFrames)
                                  .arg(secs, 0, 'f', 2)
                                  .arg(fps, 0, 'f', 1)
                                  .arg(frameMs, 0, 'f', 2)
                                  .arg(windowWorstMs, 0, 'f', 2)
                                  .arg(windowFrames ? windowWaitUs / qint64(windowFrames) : 0)
                                  .arg(windowWaitWorstUs)
                                  .arg(m_waitTimeouts)
                                  .arg(m_waitFailures)
                                  .arg(frame.timeSeconds, 0, 'f', 3)
                                  .arg(frame.frameIndex));
            emit frameStatsUpdated();

            windowFrames = 0;
            windowWorstMs = 0.0;
            windowWaitUs = 0;
            windowWaitWorstUs = 0;
            reportTimer.restart();
        }

        if (frameLimit > 0 && totalFrames >= quint64(frameLimit))
        {
            GraphicsLog::info(QStringLiteral("render loop: frame limit %1 reached, stopping")
                                  .arg(frameLimit));
            break;
        }

        // Guard against a frame that never finishes.
        //
        // A shader with a runaway loop does not merely run slowly: on Windows the
        // display driver watchdog resets the GPU after roughly two seconds of a
        // stalled command stream, and that reset destroys every GL context in the
        // process. Stopping before that turns an unrecoverable driver reset into a
        // reported error that leaves the rest of the application alone. The check
        // happens after the frame returns, so it catches "the frame eventually
        // took too long" - which is the observable half of the problem.
        if (frameMs > kFrameHangSeconds * 1000.0)
        {
            GraphicsLog::error(QStringLiteral("render loop: a frame took %1ms, at or beyond the %2s "
                                              "display-driver watchdog limit; stopping the loop to avoid "
                                              "a GPU reset that would take the whole process's GL contexts")
                                   .arg(frameMs, 0, 'f', 1)
                                   .arg(kFrameHangSeconds, 0, 'f', 1));
            m_hung.store(true, std::memory_order_relaxed);
            break;
        }

        const qint64 nowNs = frameTimer.nsecsElapsed();

        // Deadline for the next frame, advanced from the previous deadline rather
        // than from "now" so a frame that overruns does not push every later frame
        // back by the overrun.
        nextDeadlineNs += intervalNs;
        if (nextDeadlineNs < nowNs)
        {
            // Behind by more than a whole frame: drop the missed deadlines rather
            // than trying to catch up, which would otherwise spiral.
            nextDeadlineNs = nowNs;
        }

        const qint64 spinStartNs = nextDeadlineNs - spinWindowNs;
        const qint64 sleepNs = spinStartNs - nowNs;
        if (sleepNs > 0)
        {
            QMutexLocker lock(&m_paceMutex);
            // Woken early by shutdown(); the loop condition is re-checked anyway.
            m_paceWait.wait(&m_paceMutex, static_cast<unsigned long>(sleepNs / 1000000 + 1));
        }

        while (m_loopRunning.load(std::memory_order_relaxed)
               && frameTimer.nsecsElapsed() < nextDeadlineNs)
        {
            QThread::yieldCurrentThread();
        }
    }

    m_loopRunning.store(false, std::memory_order_relaxed);
    GraphicsLog::info(QStringLiteral("render loop: stopped after %1 frames").arg(totalFrames));

    // Tear the GL objects down while the context is still current.
    //
    // Consumers are told first: the textures are about to be destroyed, and a
    // consumer holding a stale name would sample a deleted texture.
    {
        QMutexLocker lock(&m_rendererMutex);
        if (m_sharedFrame)
            m_sharedFrame->clear();

        // Fences belong to this context, so they go before it is released.
        //
        // Only this thread's own completion fences are deleted. The fences a consumer
        // leaves behind belong to the consumer's context and are that side's to delete;
        // reaching for them from here would be deleting an object this context does not
        // own.
        QOpenGLExtraFunctions* ex = m_context ? m_context->extraFunctions() : nullptr;
        if (ex)
        {
            for (int i = 0; i < kTargetCount; ++i)
            {
                if (m_targetFence[i])  { ex->glDeleteSync(m_targetFence[i]);  m_targetFence[i] = nullptr; }
                if (m_retiredFence[i]) { ex->glDeleteSync(m_retiredFence[i]); m_retiredFence[i] = nullptr; }
            }
        }

        for (int i = 0; i < kTargetCount; ++i)
            m_targets[i].reset();
        m_gfxRenderer.reset();
    }

    m_context->doneCurrent();
}

} // namespace SonicPi
