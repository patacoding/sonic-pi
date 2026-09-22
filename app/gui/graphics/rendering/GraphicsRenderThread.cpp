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

    // Held for the whole recompile, which is the point: the shader program is
    // replaced while the loop cannot be drawing with it. This is also the only
    // place a lock is taken for a long operation, so it is where a stall would
    // show up - which is why it is timed.
    QElapsedTimer t;
    t.start();

    QMutexLocker lock(&m_rendererMutex);
    if (!m_gfxRenderer)
    {
        GraphicsLog::warn(QStringLiteral("reload: no renderer to reload"));
        return;
    }

    // The loop's context is current by construction here, which is exactly what
    // reloadShaders() requires and what a caller on another thread cannot provide.
    const bool ok = m_gfxRenderer->reloadShaders();

    GraphicsLog::info(QStringLiteral("reload: %1 after %2ms")
                          .arg(ok ? QStringLiteral("applied") : QStringLiteral("FAILED"))
                          .arg(t.elapsed()));
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

        {
            QMutexLocker lock(&m_rendererMutex);
            if (m_gfxRenderer && m_targets[0] && m_targets[1])
            {
                // Choose the target NOT currently published.
                //
                // This step is what makes double buffering double buffering, and
                // omitting it would silently reduce the whole scheme to a single
                // texture with all the tearing that implies. A consumer may be
                // sampling m_readyIndex right now, so that one is left alone and the
                // frame goes into the other; the published one only changes when this
                // frame is complete.
                const int back = (m_readyIndex == 0) ? 1 : 0;
                GraphicsTarget& target = *m_targets[back];

                // Report the size the shader will actually be given, not a second copy
                // of it, so iResolution cannot disagree with the target being drawn
                // into.
                frame.resolution = target.size();
                if (m_gfxRenderer->renderInto(target, frame))
                {
                    QOpenGLExtraFunctions* f = m_context ? m_context->extraFunctions() : nullptr;
                    if (f)
                    {
                        // Access protection, as Spout calls it.
                        //
                        // The fence marks the point in the GPU command stream where
                        // this frame is complete. A consumer waits on it before
                        // sampling, which is what stops it reading a draw that has been
                        // issued but not finished - the cause of the flicker between a
                        // finished image and a partial one.
                        //
                        // The target's previous fence is deleted here, immediately
                        // before the target is drawn into again: by this point the
                        // consumer has either waited on it or moved on to a newer
                        // frame, and nothing can still be waiting on a fence this old.
                        if (m_targetFence[back])
                        {
                            f->glDeleteSync(m_targetFence[back]);
                            m_targetFence[back] = nullptr;
                        }
                        m_targetFence[back] = f->glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);

                        // Flush so the fence is actually submitted. Without this the
                        // command may sit in the driver's queue and the fence never
                        // signals, which would make every consumer wait out its
                        // timeout.
                        f->glFlush();
                    }

                    // Publish for consumers. Only after the draw, and the published
                    // index is what tells a consumer whether there is anything new -
                    // it compares against the index it last used and repeats its
                    // previous frame if this has not moved.
                    m_readyIndex = back;
                    if (m_sharedFrame)
                        m_sharedFrame->publish(target.texture(), target.size(),
                                               frame.frameIndex, m_targetFence[back]);
                }
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
                                             "iTime %6s, iFrame %7")
                                  .arg(windowFrames)
                                  .arg(secs, 0, 'f', 2)
                                  .arg(fps, 0, 'f', 1)
                                  .arg(frameMs, 0, 'f', 2)
                                  .arg(windowWorstMs, 0, 'f', 2)
                                  .arg(frame.timeSeconds, 0, 'f', 3)
                                  .arg(frame.frameIndex));
            emit frameStatsUpdated();

            windowFrames = 0;
            windowWorstMs = 0.0;
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

        for (int i = 0; i < kTargetCount; ++i)
            m_targets[i].reset();
        m_gfxRenderer.reset();
    }

    m_context->doneCurrent();
}

} // namespace SonicPi
