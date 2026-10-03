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
#include "GraphicsPacer.h"
#include "GraphicsSettings.h"
#include "GraphicsBufferTargets.h"

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
// How many reporting windows of read-back timing to throw away before believing the figure.
//
// Ten, not three. The window that begins the moment publishing is switched on carries the warm-up -
// pipeline creation, the first shared-surface hand-off, the first glBufferData of two 8 MB buffers - and
// the figure keeps falling for several seconds after that: a report taken three windows in said 8.40 ms a
// frame, while the same loop went on to average 113 fps over the whole minute with publishing ON against
// 124 fps with it OFF. A cost of 8.4 ms inside a loop that is finishing frames every 8.8 ms is not a
// thing that can be true; the honest reading is that the early windows are still settling. The steady
// figure is the one worth printing, so the measurement waits for it.
constexpr int kSpoutSettleWindows = 10;

// ...and it is printed again if it later moves by more than this, because "measured once, at the start"
// is how a number becomes a claim. A receiver appearing or going away changes what this costs.
constexpr double kSpoutRelogMs = 2.0;

// ...but a move has to LAST to be worth a line. The window averages on this machine swing between about
// 1.6 and 5.3 ms with nothing changing but the machine's mood, so "log when it moves by 2 ms" on its own
// would be a line a second - which is the thing this file refuses to do with frame rates, for the same
// reason: a log of per-second numbers stops being read. Half a minute of a different value is a change;
// one window of it is noise.
constexpr int kSpoutRelogWindows = 30;

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
    // the request, then interrupt as a second signal for anything else waiting.
    //
    // The pacing sleep is NOT woken any more, and does not need to be: it is now a sleep of at most one
    // frame interval (see GraphicsPacer), so the loop notices the flag within that - 6.9ms at 144Hz,
    // 16.7ms at 60Hz, against a shutdown that waits five seconds for the thread.
    m_loopRunning.store(false, std::memory_order_relaxed);

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

    s.consumerWaitAvgUs   = m_consumerWaitAvgUs.load(std::memory_order_relaxed);
    s.consumerWaitWorstUs = m_consumerWaitWorstUs.load(std::memory_order_relaxed);
    s.slowReaderCount     = m_waitTimeouts;
    s.waitFailedCount     = m_waitFailures;
    s.targetCount         = m_targetCount.load(std::memory_order_relaxed);
    s.frameCapHz          = m_frameCapHz.load(std::memory_order_relaxed);
    s.belowTarget         = m_belowTarget.load(std::memory_order_relaxed);

    // Spout: the figures the render thread counted, so a display does not have to ask the sender.
    s.spoutPublishing    = m_spoutPublishing.load(std::memory_order_relaxed);
    s.spoutSentPerSec    = m_spoutSentWindow.load(std::memory_order_relaxed);
    s.spoutDroppedPerSec = m_spoutDroppedWindow.load(std::memory_order_relaxed);
    s.spoutReadbackMs    = m_spoutReadbackMsAvg.load(std::memory_order_relaxed);
    // The active renderer, whichever buffer that is: its GPU figures are the ones the picture on screen
    // was produced by. Read from a pointer published atomically, and entries are never evicted, so this
    // cannot be a dangling one.
    if (GraphicsRenderer* active = m_activeRenderer.load(std::memory_order_relaxed))
    {
        s.gpuMs      = active->gpuFrameMs();
        s.gpuMsAvg   = active->gpuFrameAvgMs();
        s.gpuMsWorst = active->gpuFrameWorstMs();
    }
    return s;
}

void GraphicsRenderThread::setTargetFps(int fps)
{
    QMutexLocker lock(&m_rateMutex);
    if (m_targetFps == fps)
        return;
    m_targetFps = fps;
    // The flag, not the value, is what the loop watches. It reads both values under the same
    // lock when it sees the flag, so it can never apply a half-updated pair.
    m_rateChangePending.store(true, std::memory_order_release);
}

void GraphicsRenderThread::setDisplayRefreshHz(int hz)
{
    QMutexLocker lock(&m_rateMutex);
    if (m_displayRefreshHz == hz)
        return;
    m_displayRefreshHz = hz;
    m_rateChangePending.store(true, std::memory_order_release);
}

// The rate to pace to: what the user asked for, capped by what the display can show.
//
// One place, so the startup path and the menu path cannot derive it differently - and the
// display cap is the reason this is not simply the user's number. This thread renders
// offscreen, so nothing else throttles it to a display, and pacing above the refresh rate
// produces frames nobody can see while reporting a rate the user cannot observe. Measured
// before the cap existed: a 240Hz request was met - 240.3 fps, logged as healthy - on a
// 165Hz panel.
int GraphicsRenderThread::effectiveTargetHz() const
{
    QMutexLocker lock(&m_rateMutex);
    const int requested = m_targetFps > 0 ? m_targetFps : kDefaultFrameCapHz;
    const int display = m_displayRefreshHz;
    return (display > 0 && display < requested) ? display : requested;
}

bool GraphicsRenderThread::applyRateChange(int* capHz, qint64* intervalNs, qint64* spinWindowNs)
{
    if (!m_rateChangePending.exchange(false, std::memory_order_acquire))
        return false;

    const int wanted = effectiveTargetHz();
    if (wanted == *capHz)
        return false;

    *capHz = wanted;
    *intervalNs = 1000000000LL / *capHz;
    *spinWindowNs = qMin(qint64(2000000), *intervalNs / 8);
    m_frameCapHz.store(*capHz, std::memory_order_relaxed);
    return true;
}

bool GraphicsRenderThread::requestShaderCompile(const QString& shaderName)
{
    if (!m_loopRunning.load(std::memory_order_relaxed))
    {
        GraphicsLog::warn(QStringLiteral("compile requested but the render loop is not running"));
        return false;
    }

    // Empty means "the buffer on screen", which is what a plain reload is. Stored rather than resolved
    // here, because the answer can change before the loop gets to it - and the loop's answer is the one
    // that belongs with the frame it applies to.
    {
        QMutexLocker lock(&m_bufferMutex);
        m_requestedShaderName = shaderName;
    }
    m_reloadRequested.store(true, std::memory_order_relaxed);

    // Timestamped on request, so the delay before the loop picks it up is
    // measurable rather than a matter of impression. "Reload is unreliable and
    // sometimes takes seconds" is only diagnosable if both ends are timed.
    GraphicsLog::info(QStringLiteral("compile: requested by the GUI%1")
                          .arg(shaderName.isEmpty() ? QString()
                                                    : QStringLiteral(" for buffer '%1'").arg(shaderName)));
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

    // The startup renderer: geometry, then the buffer's shader, then - if there is nothing to show and
    // this is the session's first renderer - the built-in fallback rather than a blank output. Later
    // buffers never take that route: by then there IS something on screen worth keeping, and a compile
    // request that fails leaves it alone (see applyShaderCompile).
    GraphicsRenderer* renderer = createRenderer(shaderName());
    if (!renderer)
    {
        GraphicsLog::error(QStringLiteral("renderer: could not be initialised"));
        return false;
    }

    if (!renderer->hasProgram())
    {
        const bool firstRenderer = m_renderers.size() == 1;
        if (!renderer->initialize(firstRenderer))
        {
            GraphicsLog::error(QStringLiteral("renderer: could not be initialised"));
            m_renderers.clear();
            return false;
        }
    }

    m_activeRenderer.store(renderer, std::memory_order_relaxed);

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
    m_targetCount.store(kTargetCount, std::memory_order_relaxed);
    GraphicsLog::info(QStringLiteral("render targets: %1 buffers at %2x%3 (double buffered)")
                          .arg(kTargetCount).arg(w).arg(h));


    // The front/back pair a multi-pass buffer needs, held persistently from here on: created at the
    // output size, replaced when the size changes (create() destroys the previous pair first), and
    // reported once so the log shows what it made. Deliberately NOT drawn into yet - the per-frame
    // A -> B -> C -> D -> Image ordering that uses it is the next step, so what the screen shows is
    // unchanged. See GraphicsBufferTargets.h and docs/graphics-desktop-multipass-plan.md 13/14.
    // The passes of a document, each compiled into its own renderer - the thing the frame ordering will
    // drive (GraphicsPassPrograms.h). Taken from the first document on disk that has one; a shader
    // directory with only top-level .frag files has no documents, in which case this does nothing and
    // the log says (none) - which is the current state of every home on this machine, so behaviour is
    // unchanged until a document directory exists.
    {
        const QList<GraphicsDocument> documents =
            scanGraphicsDocuments(GraphicsSettings::shaderDirectoryPath());
        for (const GraphicsDocument& document : documents) {
            if (document.singlePass)
                continue;   // a single-pass .frag stays on the existing candidate/active path
            // The document's channels, once, where the document is known: the per-frame loop must not read a
            // file, and the assignment cannot change mid-frame.
            // Missing file means the DEFAULT assignment (channel i reads Buffer i), not None: a document
            // that says nothing about channels must keep behaving as it did before channels were
            // configurable. Present-but-silent about one channel means None for that one, because then the
            // user did express an opinion.
            // Kept for the frame loop: the channels are PER PASS now (Shadertoy binds them under each render
            // pass), so the loop asks for the pass it is about to draw instead of reading one set up front.
            m_passDocument = document;
            // Recorded here as well as in applyPassDocumentRequest: this is the document the passes belong
            // to, so a later request naming it is a rebuild rather than a switch, and the first click on its
            // tab does not recompile five shaders that were just compiled.
            m_activePassDocument = document.name;
            // Its channels, read where the document becomes the one being rendered - the same place the
            // switch reads them, so a session's first frame and a later switch cannot disagree.
            refreshChannelSources();

            // The channel textures belonged to the document being left, and their destruction needs the
            // context this thread holds.
            releaseChannelTextures();

            m_passPrograms = std::make_unique<GraphicsPassPrograms>();
            if (!m_passPrograms->create(document, QString())) {
                GraphicsLog::error(QStringLiteral("pass programs: document '%1' compiled nothing")
                                       .arg(document.name));
                m_passPrograms.reset();
            }
            break;   // one document for now: which one is on screen is the next step
        }
        if (!m_passPrograms)
            GraphicsLog::info(QStringLiteral("pass programs: no multi-pass document to compile"));
    }
    // One front/back pair per pass - Image and Buffer A-D - so a pass can be sampled while another is
    // being written, which is what the ordering step needs. Five pairs is ten textures at the output
    // size: the fixed cost of Shadertoy's shape, reported below rather than estimated.
    for (int i = 0; i < kPassCount; ++i) {
        m_bufferTargets[i] = std::make_unique<GraphicsBufferTargets>();
        if (!m_bufferTargets[i]->create(wanted)) {
            GraphicsLog::error(QStringLiteral("buffer targets: pass %1 of %2 could not get a ping-pong "
                                              "pair at %3x%4; multi-pass cannot run until the size "
                                              "changes again")
                                   .arg(i + 1).arg(kPassCount).arg(w).arg(h));
            for (int j = 0; j < kPassCount; ++j)
                m_bufferTargets[j].reset();
            break;
        }
        GraphicsLog::info(QStringLiteral("buffer targets: pass %1 of %2: %3")
                              .arg(i + 1).arg(kPassCount).arg(m_bufferTargets[i]->describe()));
    }

    // What the multi-pass pipeline will read: the documents on disk. A directory holding image.frag
    // is one document; a top-level .frag stays a single-pass document, exactly as before. Reported
    // once, where the size is set up - deliberately not per frame.
    {
        const QList<GraphicsDocument> documents =
            scanGraphicsDocuments(GraphicsSettings::shaderDirectoryPath());
        QStringList names;
        for (const GraphicsDocument& document : documents)
            names << (document.singlePass ? document.name + QStringLiteral(" (single pass)") : document.name);
        GraphicsLog::info(QStringLiteral("graphics documents: %1 found: %2")
                              .arg(documents.size())
                              .arg(names.isEmpty() ? QStringLiteral("(none)") : names.join(QStringLiteral(", "))));
    }

    // The order the multi-pass pipeline will run in, said once here so the vocabulary in GraphicsPasses.h
    // is visible in the log rather than only in the code. One array decides it for everything that cares:
    // the pipeline, the channel rules, and (later) the editor showing it to a person.
    {
        QStringList order;
        for (int i = 0; i < kDrawOrderCount; ++i)
            order << graphicsPassLabel(kDrawOrder[i]);
        GraphicsLog::info(QStringLiteral("pass order: %1 (Common is text, prepended to each, not a pass)")
                              .arg(order.join(QStringLiteral(" -> "))));
    }
    // Spout publishing follows the output size: the read-back buffers are the target's size, and the
    // sender is created at a size. A receiver will therefore see the sender disappear and come back when
    // the user changes the output resolution - stated, because from a receiver's side that looks like a
    // fault.
    if (m_spoutPublishing.load(std::memory_order_relaxed))
    {
        setUpSpoutReadback();

        QMutexLocker spoutLock(&m_spoutMutex);
        if (m_spoutPublisher)
        {
            GraphicsLog::info(QStringLiteral("spout: output size changed to %1x%2; restarting the sender")
                                  .arg(w).arg(h));
            m_spoutPublisher->stop();
            m_spoutPublisher.reset();
        }
        m_spoutRequestWanted.store(true, std::memory_order_relaxed);
        m_spoutRequestPending.store(true, std::memory_order_release);
    }

    return true;
}

void GraphicsRenderThread::setActiveShaderName(const QString& name)
{
    // A name is not just a label: it decides which fragment file is compiled, so an empty one would ask
    // for a file called ".frag". Falling back keeps the failure to a missing default shader, which is
    // reported, rather than to a name nobody can read.
    const QString wanted = name.isEmpty() ? GraphicsSettings::defaultShaderName() : name;

    {
        QMutexLocker lock(&m_bufferMutex);
        m_activeShaderName = wanted;
        m_requestedShaderName = wanted;
    }

    // Recorded, worded for what it is: this is the buffer the session STARTS on - the picture changes
    // only when a compile puts another buffer on screen (requestShaderCompile).
    //
    // A DOCUMENT IS NOT A MISSING FILE. The stored name may be a document - a directory holding image.frag -
    // and then there is no `<name>.frag` by design: the passes are compiled from the directory. Asking for
    // the single-file path anyway produced a warning on every start of a document session ("'<name>' has no
    // file yet"), which reads as a fault and is not one. That is exactly the noise a log must not carry.
    const QString directory =
        QDir(GraphicsSettings::shaderDirectoryPath()).filePath(wanted);
    if (QFileInfo::exists(QDir(directory).filePath(graphicsDocumentImageFileName())))
    {
        GraphicsLog::info(QStringLiteral("buffer: starting on the document '%1' (%2)")
                              .arg(wanted, directory));
        return;
    }

    const QString path = GraphicsSettings::shaderPath(GraphicsSettings::fragmentFileName(wanted));
    if (path.isEmpty())
        GraphicsLog::warn(QStringLiteral("buffer: starting on '%1', which has no file yet (looked in %2)")
                              .arg(wanted, GraphicsSettings::shaderDirectoryPath()));
    else
        GraphicsLog::info(QStringLiteral("buffer: starting on '%1' (%2)").arg(wanted, path));
}

QString GraphicsRenderThread::shaderName() const
{
    QMutexLocker lock(&m_bufferMutex);
    return m_activeShaderName;
}

bool GraphicsRenderThread::requestShaderForget(const QString& shaderName)
{
    if (shaderName.isEmpty())
        return false;
    if (!m_loopRunning.load(std::memory_order_relaxed))
    {
        GraphicsLog::warn(QStringLiteral("forget requested but the render loop is not running"));
        return false;
    }

    {
        QMutexLocker lock(&m_bufferMutex);
        m_forgetShaderName = shaderName;
    }
    m_forgetRequested.store(true, std::memory_order_release);
    return true;
}

bool GraphicsRenderThread::requestPassDocument(const QString& documentName, bool rebuild)
{
    if (!m_loopRunning.load(std::memory_order_relaxed))
    {
        GraphicsLog::warn(QStringLiteral("document switch requested but the render loop is not running"));
        return false;
    }

    // Stored rather than resolved here: the answer can change before the loop gets to it, and the loop's
    // answer is the one that belongs with the frame it applies to.
    {
        QMutexLocker lock(&m_bufferMutex);
        m_requestedPassDocument = documentName;
        m_requestedPassDocumentRebuild = rebuild;
    }
    m_passDocumentRequested.store(true, std::memory_order_relaxed);

    GraphicsLog::info(QStringLiteral("pass document: requested '%1'%2")
                          .arg(documentName,
                               rebuild ? QStringLiteral(" (rebuild: the files changed)")
                                       : QString()));
    return true;
}

GLuint GraphicsRenderThread::textureForChannel(const GraphicsChannelSource& source)
{
    if (source.kind == GraphicsChannelSource::None)
        return 0;

    if (source.kind == GraphicsChannelSource::Buffer)
    {
        const int index = source.bufferIndex;
        if (index < 0 || index >= kPassCount || !m_bufferTargets[index])
            return 0;
        GraphicsTarget* readSide = m_bufferTargets[index]->read();
        return (readSide && readSide->isValid()) ? readSide->texture() : 0;
    }

    if (source.path.isEmpty())
        return 0;

    // Two caches, because the two kinds build differently: an image becomes one texture, a cross image becomes
    // six faces of a cube. Keyed by path, so changing a dropdown back and forth costs nothing after the first
    // load, and a path that fails to load is simply absent - the channel reads black, which is the same thing
    // an absent buffer means.
    QHash<QString, std::shared_ptr<QOpenGLTexture>>& cache =
        (source.kind == GraphicsChannelSource::Cubemap) ? m_channelCubemaps : m_channelTextures;
    auto found = cache.find(source.path);
    if (found != cache.end())
        return found->get() ? found->get()->textureId() : 0;

    const QImage image(source.path);
    if (image.isNull())
    {
        GraphicsLog::error(QStringLiteral("channel: could not read the image %1").arg(source.path));
        cache.insert(source.path, nullptr);
        return 0;
    }

    if (source.kind == GraphicsChannelSource::Cubemap)
    {
        GraphicsCubemapFace faces[6];
        if (!graphicsCubemapCrossFaces(image.size(), faces))
        {
            GraphicsLog::error(QStringLiteral("channel: %1 is not a 4x3 cross image (it is %2x%3); the "
                                              "channel reads black")
                                   .arg(source.path).arg(image.width()).arg(image.height()));
            cache.insert(source.path, nullptr);
            return 0;
        }
        const int faceW = image.width() / 4;
        const int faceH = image.height() / 3;
        auto cube = std::make_shared<QOpenGLTexture>(QOpenGLTexture::TargetCubeMap);
        cube->setFormat(QOpenGLTexture::RGBA8_UNorm);
        cube->setSize(faceW, faceH);
        cube->setMipLevels(1);
        cube->allocateStorage();
        for (int face = 0; face < 6; ++face)
        {
            const QImage tile = image.copy(faces[face].x, faces[face].y, faceW, faceH)
                                    .convertToFormat(QImage::Format_RGBA8888);
            cube->setData(0, 0, QOpenGLTexture::CubeMapFace(int(QOpenGLTexture::CubeMapPositiveX) + face),
                          QOpenGLTexture::RGBA, QOpenGLTexture::UInt8, tile.constBits());
        }
        const GLuint id = cube->textureId();
        cache.insert(source.path, std::move(cube));
        GraphicsLog::info(QStringLiteral("channel: cubemap %1 loaded as a 4x3 cross, faces %2x%3")
                              .arg(source.path).arg(faceW).arg(faceH));
        return id;
    }

    auto texture = std::make_shared<QOpenGLTexture>(image.mirrored(),
                                                    QOpenGLTexture::GenerateMipMaps);
    texture->setWrapMode(QOpenGLTexture::ClampToEdge);
    texture->setMinificationFilter(QOpenGLTexture::LinearMipMapLinear);
    texture->setMagnificationFilter(QOpenGLTexture::Linear);
    const GLuint id = texture->textureId();
    cache.insert(source.path, std::move(texture));
    GraphicsLog::info(QStringLiteral("channel: image %1 loaded (%2x%3)")
                          .arg(source.path).arg(image.width()).arg(image.height()));
    return id;
}

void GraphicsRenderThread::releaseChannelTextures()
{
    // Their destruction needs the context current, so this is only ever called from the render thread.
    m_channelTextures.clear();
    m_channelCubemaps.clear();
}

void GraphicsRenderThread::refreshChannelSources()
{
    const QString path = graphicsDocumentChannelsPath(m_passDocument);
    m_channelFileDescribesDocument = !path.isEmpty() && QFileInfo::exists(path);

    QStringList readback;
    for (int i = 0; i < kDrawOrderCount; ++i)
    {
        m_channelSources[i] = graphicsDocumentChannelSourcesFromFile(m_passDocument, kDrawOrder[i]);
        QStringList four;
        for (int ch = 0; ch < 4; ++ch)
            four << graphicsChannelSourceToText(m_channelSources[i].value(ch));
        readback << QStringLiteral("%1=[%2]").arg(graphicsPassLabel(kDrawOrder[i]),
                                                  four.join(QLatin1Char('|')));
    }

    // Reported when the document is prepared, not per frame - and in the file's own words, so this line and
    // the file can be compared directly when a channel is not doing what it looks like it says.
    GraphicsLog::info(QStringLiteral("channels: %1, %2")
                          .arg(m_channelFileDescribesDocument
                                   ? QStringLiteral("from %1").arg(path)
                                   : QStringLiteral("no channels file, so channel i reads Buffer i"),
                               readback.join(QStringLiteral(" "))));
}

void GraphicsRenderThread::applyPassDocumentRequest()
{
    if (!m_passDocumentRequested.exchange(false, std::memory_order_relaxed))
        return;

    QString requested;
    bool rebuild = false;
    {
        QMutexLocker lock(&m_bufferMutex);
        requested = m_requestedPassDocument;
        rebuild = m_requestedPassDocumentRebuild;
        m_requestedPassDocumentRebuild = false;
    }
    // A rebuild is honoured for the document already on screen too: that is what pressing Compile in a
    // document tab means - the pass file was just written, and the programs that read it must be built
    // again. A plain switch to the document already on screen is still refused, so clicking the tab you are
    // already in does not recompile five shaders.
    if (requested.isEmpty() || (!rebuild && requested.compare(m_activePassDocument) == 0))
        return;

    // One scan, on the render thread, with the context current - the same rule as everything else here.
    const QList<GraphicsDocument> documents =
        scanGraphicsDocuments(GraphicsSettings::shaderDirectoryPath());
    GraphicsDocument wanted;
    for (const GraphicsDocument& candidate : documents)
    {
        if (candidate.name.compare(requested, Qt::CaseInsensitive) == 0)
        {
            wanted = candidate;
            break;
        }
    }

    // A single-pass .frag IS a document too, and its passes matter as soon as one of its channels points at
    // a buffer it wrote: refusing it here is what left the channel row with nowhere to write. The pass chain
    // draws its Image (which is the .frag itself) and whatever buffers exist beside it, and the blit-to-
    // screen path already prefers a document's Image when there is one.
    if (!wanted.isValid())
    {
        GraphicsLog::info(QStringLiteral("pass document: '%1' is not on disk; leaving the passes as they are")
                              .arg(requested));
        return;
    }

    if (m_passPrograms)
    {
        m_passPrograms->destroy();
        m_passPrograms.reset();
    }
    // The channel textures belonged to the document being left, and their destruction needs the context
    // this thread holds.
    releaseChannelTextures();

    m_passPrograms = std::make_unique<GraphicsPassPrograms>();
    const bool built = m_passPrograms->create(wanted, QString());
    if (!built)
    {
        GraphicsLog::error(QStringLiteral("pass document: '%1' compiled nothing").arg(wanted.name));
        m_passPrograms.reset();
    }
    m_activePassDocument = wanted.name;
    GraphicsLog::info(QStringLiteral("pass document: now rendering '%1'").arg(wanted.name));
    // What each pass's channels read, read once here and kept for the frames that follow: the file is a
    // person's edit, not a per-frame input.
    refreshChannelSources();
    m_passesDrawnLastFrame = -1;   // so the next frame reports what it drew, once

    // A rebuild is somebody's Compile press, so it owes them an answer. Individual pass failures are
    // already in the log, in the renderer's own words and attributed to the pass's file; this is the
    // verdict that tells the editor the attempt finished, and that the document produced a picture or did
    // not. Emitted only for a rebuild: a plain document switch is a view action, and answering it would
    // file a compile report against a tab the user never compiled.
    if (rebuild)
        emit shaderCompileFinished(built, QString(), QString(), 0, QStringList());
}

void GraphicsRenderThread::applyShaderForget()
{
    QString name;
    {
        QMutexLocker lock(&m_bufferMutex);
        name = m_forgetShaderName;
    }
    if (name.isEmpty())
        return;

    QMutexLocker lock(&m_rendererMutex);

    const auto found = m_renderers.find(name);
    if (found == m_renderers.end())
        return;   // never compiled, so there is nothing to drop

    // The one refusal: the program being drawn with right now. The tab may be closed, but the program in
    // memory is what the picture IS, and dropping it would take the picture away for no reason. It goes
    // when something else goes on screen.
    if (found->second.get() == m_activeRenderer.load(std::memory_order_relaxed))
    {
        GraphicsLog::info(QStringLiteral("buffer: '%1' is still the picture, so its program is kept; it "
                                         "will be dropped when another buffer goes on screen").arg(name));
        return;
    }

    // Destroying GL objects needs the context current - which is exactly where this runs.
    m_renderers.erase(found);
    GraphicsLog::info(QStringLiteral("buffer: '%1' released (%2 renderer(s) alive)")
                          .arg(name).arg(m_renderers.size()));
}

GraphicsRenderer* GraphicsRenderThread::createRenderer(const QString& shaderName)
{
    // Called with m_rendererMutex held and the context current (see the note in the header).
    const QString name = shaderName.isEmpty() ? GraphicsSettings::defaultShaderName() : shaderName;

    const auto found = m_renderers.find(name);
    if (found != m_renderers.end())
        return found->second.get();

    auto renderer = std::make_unique<GraphicsRenderer>();
    renderer->setShaderName(name);
    if (!renderer->prepare())
    {
        GraphicsLog::error(QStringLiteral("buffer: '%1' has no geometry to draw with").arg(name));
        return nullptr;
    }

    renderer->setUpGpuTimer();
    GraphicsRenderer* raw = renderer.get();
    m_renderers.emplace(name, std::move(renderer));
    return raw;
}

void GraphicsRenderThread::applyShaderCompile()
{
    // Which buffer to build: the one the request named, or - for a plain "Reload Shader" - the one
    // already on screen.
    QString wanted;
    {
        QMutexLocker lock(&m_bufferMutex);
        wanted = m_requestedShaderName;
    }
    const QString current = shaderName();
    if (wanted.isEmpty())
        wanted = current;

    // A DOCUMENT IS NOT A BUFFER. What the editor is looking at is always a document - a directory holding
    // image.frag, or a top-level .frag whose Image pass is that file - and a document's passes are compiled
    // as a set by GraphicsPassPrograms. The single-shader path below reads "<name>.frag" from the shader
    // directory, which for a document directory is a file that does not exist; pressing Compile in a
    // document tab therefore reported a failure while the picture went on showing the OLD passes, because
    // the file had been written and nothing ever read it again. Handing the request to the pass path is what
    // makes an edit visible. The verdict comes from there too (applyPassDocumentRequest), so this returns
    // without emitting one - two verdicts for one Compile would file a failure over a success.
    {
        const QList<GraphicsDocument> documents =
            scanGraphicsDocuments(GraphicsSettings::shaderDirectoryPath());
        for (const GraphicsDocument& document : documents)
        {
            if (document.name.compare(wanted, Qt::CaseInsensitive) != 0)
                continue;
            GraphicsLog::info(QStringLiteral("compile: '%1' is a %2 document; rebuilding its passes "
                                             "(passes, not a '<name>.frag')")
                                  .arg(wanted, document.singlePass ? QStringLiteral("single-pass")
                                                                   : QStringLiteral("directory")));
            requestPassDocument(document.name, true);
            return;
        }
    }

    GraphicsLog::info(QStringLiteral("compile: buffer '%1' (on screen: '%2')").arg(wanted, current));

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
    GraphicsRenderer* renderer = nullptr;
    GraphicsCompileResult result;
    {
        QMutexLocker lock(&m_rendererMutex);
        renderer = createRenderer(wanted);
    }
    if (!renderer)
    {
        // Nothing to build into: the geometry could not be created at all, which is not about the
        // user's shader. Reported in the same channel as a compile failure so the editor is not left
        // waiting, and the picture is untouched.
        GraphicsLog::error(QStringLiteral("compile: buffer '%1' could not be prepared; still rendering "
                                          "'%2'").arg(wanted, current));
        emit shaderCompileFinished(false,
                                   tr("Could not prepare a renderer for buffer \"%1\".").arg(wanted),
                                   QString(), 0, QStringList());
        return;
    }

    // The compile itself, with no lock held: this is the slow part.
    result = renderer->buildAndInstall();

    if (!result.ok())
    {
        // The promise, in the user's words: the picture does not change. The compiler's own words go
        // back to whoever asked - the editor, which shows them where the user is looking - because a
        // failure that only reaches a log file is a failure the user retries blindly. What WAS read comes
        // with them: a failure inside a library is only readable next to the fact that the library was
        // read at all.
        GraphicsLog::warn(QStringLiteral("compile: buffer '%1' did not build; still rendering '%2' "
                                         "(%3ms)").arg(wanted, current).arg(t.elapsed()));
        emit shaderCompileFinished(false, result.log, result.errorFile, result.errorLine,
                                   result.includedShaders);
        return;
    }

    // It built, so it goes on screen - the only step that touches what the loop reads.
    {
        QMutexLocker lock(&m_rendererMutex);
        m_activeRenderer.store(renderer, std::memory_order_relaxed);
    }
    {
        QMutexLocker lock(&m_bufferMutex);
        m_activeShaderName = wanted;
        m_requestedShaderName = wanted;
    }

    GraphicsLog::info(QStringLiteral("compile: buffer '%1' is on screen (%2ms)").arg(wanted).arg(t.elapsed()));
    emit shaderCompileFinished(true, QString(), QString(), 0, result.includedShaders);
}

bool GraphicsRenderThread::setSpoutPublishing(bool publish)
{
    if (!m_loopRunning.load(std::memory_order_relaxed))
    {
        GraphicsLog::warn(QStringLiteral("spout: %1 requested but the render loop is not running")
                              .arg(publish ? QStringLiteral("publishing") : QStringLiteral("stopping")));
        return false;
    }

    m_spoutRequestWanted.store(publish, std::memory_order_relaxed);
    m_spoutRequestPending.store(true, std::memory_order_release);
    return true;
}

bool GraphicsRenderThread::isSpoutPublishing() const
{
    QMutexLocker lock(&m_spoutMutex);
    return m_spoutPublisher && m_spoutPublisher->isPublishing();
}

void GraphicsRenderThread::applySpoutRequest()
{
    const bool want = m_spoutRequestWanted.load(std::memory_order_relaxed);

    QMutexLocker lock(&m_spoutMutex);

    if (!want)
    {
        m_spoutPublishing.store(false, std::memory_order_relaxed);
        if (m_spoutPublisher)
        {
            GraphicsLog::info(QStringLiteral("spout: stopping"));
            m_spoutPublisher->stop();
            m_spoutPublisher.reset();
        }
        return;
    }

    if (m_spoutPublisher && m_spoutPublisher->isPublishing())
    {
        m_spoutPublishing.store(true, std::memory_order_relaxed);
        return;
    }

    const QSize size = renderTargetSize();
    auto publisher = std::make_unique<GraphicsSpoutPublisher>();

    QString error;
    if (!publisher->start(QStringLiteral("Sonic Pi Graphics"), size.width(), size.height(), &error))
    {
        // Reported with the reason Spout gave: a menu item that does nothing with no explanation is the
        // kind of thing a user retries forever.
        GraphicsLog::error(QStringLiteral("spout: could not start publishing: %1").arg(error));
        m_spoutPublishing.store(false, std::memory_order_relaxed);
        return;
    }

    // Which adapter each half of the bridge landed on - the one fact about "can this machine share a
    // texture between GL and D3D11" that only this process can report, and one the user cannot see for
    // themselves. STATED, NOT ACTED ON: nothing in this feature switches adapters, and the picture works
    // whichever pair this turns out to be. The comparison is by vendor word, which is a hint and is
    // labelled as one.
    const QString glAdapter = m_renderer.isEmpty() ? QStringLiteral("(unknown)") : m_renderer;
    const QString dxAdapter = publisher->adapterName();
    QString relation = QStringLiteral(" (Spout did not name its adapter)");
    if (!dxAdapter.isEmpty())
    {
        const QString glVendor = glAdapter.section(QLatin1Char(' '), 0, 0);
        const QString dxVendor = dxAdapter.section(QLatin1Char(' '), 0, 0);
        relation = QStringLiteral(" (")
                   + ((glAdapter.contains(dxVendor, Qt::CaseInsensitive)
                       || dxAdapter.contains(glVendor, Qt::CaseInsensitive))
                          ? QStringLiteral("same vendor - which a shared texture would require")
                          : QStringLiteral("different vendors, so a shared texture between them is "
                                           "impossible; the CPU route is the supported path anyway"))
                   + QStringLiteral(")");
    }
    GraphicsLog::info(QStringLiteral("spout: GL renderer '%1'; Spout's D3D11 device is on '%2'%3")
                          .arg(glAdapter, dxAdapter, relation));

    m_spoutPublisher = std::move(publisher);
    m_spoutPublishing.store(true, std::memory_order_relaxed);
}

bool GraphicsRenderThread::setUpSpoutReadback()
{
    releaseSpoutReadback();

    const int w = m_actualWidth.load(std::memory_order_relaxed);
    const int h = m_actualHeight.load(std::memory_order_relaxed);
    if (w <= 0 || h <= 0)
        return false;

    QOpenGLExtraFunctions* f = m_context ? m_context->extraFunctions() : nullptr;
    if (!f)
        return false;

    f->glGenBuffers(2, m_readbackPbos);
    for (GLuint& pbo : m_readbackPbos)
    {
        f->glBindBuffer(GL_PIXEL_PACK_BUFFER, pbo);
        f->glBufferData(GL_PIXEL_PACK_BUFFER, GLsizeiptr(size_t(w) * size_t(h) * 4), nullptr,
                        GL_STREAM_READ);
    }
    f->glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);

    m_readbackSlot = 0;
    m_readbackHasPrevious = false;
    return m_readbackPbos[0] != 0 && m_readbackPbos[1] != 0;
}

void GraphicsRenderThread::releaseSpoutReadback()
{
    // The buffers belong to this thread's context, so they go while it is still current.
    if (m_readbackPbos[0] == 0 && m_readbackPbos[1] == 0)
        return;

    if (QOpenGLExtraFunctions* f = m_context ? m_context->extraFunctions() : nullptr)
    {
        f->glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
        f->glDeleteBuffers(2, m_readbackPbos);
    }
    m_readbackPbos[0] = 0;
    m_readbackPbos[1] = 0;
    m_readbackHasPrevious = false;
}

void GraphicsRenderThread::publishFrameToSpout()
{
    GraphicsSpoutPublisher* publisher = m_spoutPublisher.get();
    if (!publisher || !publisher->isPublishing())
        return;
    if (!spoutReadbackReady())
    {
        // The buffers are made with the render targets; if there are none, there is nothing to read.
        if (!setUpSpoutReadback())
            return;
    }

    QOpenGLExtraFunctions* f = m_context ? m_context->extraFunctions() : nullptr;
    if (!f)
        return;

    const int w = m_actualWidth.load(std::memory_order_relaxed);
    const int h = m_actualHeight.load(std::memory_order_relaxed);
    if (w <= 0 || h <= 0)
        return;

    QElapsedTimer t;
    t.start();

    // This frame: queue the copy into its buffer and return. Nothing waits here - that is the whole point
    // of the two buffers, and the reason the loop's frame time does not move.
    f->glBindBuffer(GL_PIXEL_PACK_BUFFER, m_readbackPbos[m_readbackSlot]);
    f->glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    f->glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);

    const double issueMs = double(t.nsecsElapsed()) / 1.0e6;

    // The frame from one iteration ago: by now the GPU has finished copying it, so mapping should not
    // stall. Whether it does is measured rather than assumed - the map is timed on its own, because a
    // stall here is the difference between "the hand-off is free" and "the hand-off costs a frame".
    double mapMs = 0.0;
    double publishMs = 0.0;
    double unmapMs = 0.0;
    if (m_readbackHasPrevious)
    {
        const int previous = 1 - m_readbackSlot;
        f->glBindBuffer(GL_PIXEL_PACK_BUFFER, m_readbackPbos[previous]);

        QElapsedTimer m;
        m.start();
        void* pixels = f->glMapBufferRange(GL_PIXEL_PACK_BUFFER, 0,
                                           GLsizeiptr(size_t(w) * size_t(h) * 4), GL_MAP_READ_BIT);
        mapMs = double(m.nsecsElapsed()) / 1.0e6;

        if (pixels)
        {
            QElapsedTimer c;
            c.start();
            // bottomUp: a glReadPixels gives row 0 = the bottom of the picture, which is the opposite of
            // what the sender's texture wants.
            publisher->publishFrame(static_cast<const unsigned char*>(pixels), true);
            publishMs = double(c.nsecsElapsed()) / 1.0e6;

            // Timed on its own because it is not a formality: the first version of this left it inside the
            // total but outside every part, and the parts then added up to half the total - which reads as
            // a bug in the parts rather than as a cost that had not been attributed yet.
            QElapsedTimer u;
            u.start();
            f->glUnmapBuffer(GL_PIXEL_PACK_BUFFER);
            unmapMs = double(u.nsecsElapsed()) / 1.0e6;
        }
        f->glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    }

    m_readbackSlot = 1 - m_readbackSlot;
    m_readbackHasPrevious = true;

    m_spoutReadbackMsSum += double(t.nsecsElapsed()) / 1.0e6;
    m_spoutIssueMsSum += issueMs;
    m_spoutMapMsSum += mapMs;
    m_spoutPublishMsSum += publishMs;
    m_spoutUnmapMsSum += unmapMs;
    ++m_spoutReadbackCount;
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
        GraphicsRenderer* renderer = m_activeRenderer.load(std::memory_order_relaxed);
        if (renderer && m_targets[0])
            m_renderVerified = renderer->verifyShaderOutput(*m_targets[0]);
        else
            GraphicsLog::warn(QStringLiteral("no render target; skipping the readback check"));
    }
    // ---------------------------------------------------------------------

    // Set up the GPU frame timer, now that the renderer exists and the context is current.
    // Reported immediately: whether the shader's own cost can be measured, and why not when it
    // cannot. A figure that is silently absent is worse than one that is absent and explained,
    // because nobody knows to distrust it.
    {
        QMutexLocker lock(&m_rendererMutex);
        if (GraphicsRenderer* renderer = m_activeRenderer.load(std::memory_order_relaxed))
        {
            renderer->setUpGpuTimer();
            if (m_verbose)
                GraphicsLog::info(QStringLiteral("  gpu timing  : %1")
                                      .arg(renderer->gpuTimerDescription()));
        }
    }

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
    // 2026-09-25, the same hazard from the other end: the spin covers a sleep error only when the spin
    // window is LARGER than that error, and the window is min(2ms, interval/8) - so it shrinks as the
    // requested rate rises. Measured from the running application (Spout off, one 60s window each):
    //
    //     asked   interval   spin window   measured   outcome
    //      60Hz   16.67 ms   2.00 ms        59.9 fps  met exactly
    //     125Hz    8.00 ms   1.00 ms       114.8 fps  9% short
    //     144Hz    6.94 ms   0.87 ms       128.5 fps  11% short
    //     165Hz    6.06 ms   0.76 ms       142.1 fps  14% short
    //
    // A sleep late by about a millisecond a frame (what the process's timer resolution gives the wait this
    // used to make) is absorbed at 60Hz and not at the rest. So the wait itself is now GraphicsPacer,
    // which sleeps on a high-resolution waitable timer where the platform has one - measured overshoot
    // 1.24ms at 144Hz against 5.31ms for the old wait, in a process whose timer resolution has not been
    // raised at all - and the spin stays as what covers the small error that remains.
    constexpr qint64 kSpinWindowMs = 2;

    // How this loop sleeps, and therefore what the user's "144Hz" is being measured against. Its
    // description goes in the startup line below, because "the render loop did not meet the rate you
    // asked for" has at least two very different causes and which wait is in use is the first of them.
    GraphicsPacer pacer;

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
    // The rate the loop paces to, which is NOT simply what the user asked for.
    //
    // It is also capped by what the display can show. This thread renders offscreen, so
    // nothing else throttles it to a display, and pacing above the refresh rate produces
    // frames nobody can see while reporting a rate the user cannot observe. Measured before
    // this cap existed: a 240Hz request was met - 240.3 fps, logged as healthy - on a 165Hz
    // panel.
    //
    // Derived through effectiveTargetHz() and not recomputed here, so the startup path and
    // the menu path cannot disagree about what the rate is.
    int capHz = effectiveTargetHz();
    qint64 intervalNs = 1000000000LL / capHz;
    qint64 spinWindowNs = qMin(qint64(2000000), intervalNs / 8);
    m_frameCapHz.store(capHz, std::memory_order_relaxed);

    GraphicsLog::info(QStringLiteral("render loop: started, cap %1Hz, interval %2ns, spin %3us, "
                                     "sleeping on the %4, priority=lowest")
                          .arg(capHz)
                          .arg(intervalNs)
                          .arg(spinWindowNs / 1000)
                          .arg(pacer.description()));

    quint64 windowFrames = 0;
    double  windowWorstMs = 0.0;
    // The minute's accumulators, for the summary line at the bottom of this file's reporting.
    //
    // Three rates have to agree with each other for this feature to be believable - what the user asked
    // for, what the loop is actually running at, and what the sender is actually sending - and the overlay
    // shows them one second at a time, which is right for WATCHING and useless for CHECKING: you cannot
    // compare three numbers that are only ever on screen for a second, and nothing records them. So the
    // same figures also go to the log together, from the same window, once a minute - which is bounded,
    // and is why there is still no per-second line.
    QElapsedTimer summaryTimer;
    summaryTimer.start();
    quint64 summarySeconds = 0;
    quint64 summaryFrames = 0;
    double  summaryWorstSecondFps = 0.0;
    bool    summaryHaveFps = false;
    double  summaryWorstFrameMs = 0.0;
    qint64  summaryWaitUs = 0;
    double  summaryGpuMsSum = 0.0;
    int     summaryGpuCount = 0;
    quint64 summarySent = 0;
    quint64 summaryDropped = 0;
    double  summaryReadbackMsSum = 0.0;
    int     summaryReadbackCount = 0;
    // How long this loop spent waiting for the consumer to release a target, over the
    // last report window. This is the whole cost of the handoff, and the design says it
    // should be in the microseconds: the fence being waited on was placed a frame
    // earlier, so it has almost always signalled already. A value approaching the frame
    // interval means the consumer is the bottleneck, which is a fact worth reporting
    // rather than a state worth hiding behind a skipped frame.
    qint64  windowWaitUs = 0;
    qint64  windowWaitWorstUs = 0;
    // GPU time accumulators for the reporting window. Averaged rather than sampled, because the
    // renderer hands back one frame's figure at a time and a point sample of a varying quantity
    // describes the frame rather than the shader.
    double  windowGpuMsSum = 0.0;
    double  windowGpuMsWorst = 0.0;
    int     windowGpuCount = 0;
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
            applyShaderCompile();
        applyPassDocumentRequest();

        // Buffers whose files are gone, applied after any compile in the same frame: a compile can make
        // a previously-active buffer droppable, and dropping before it would be the one case this
        // refuses for no reason.
        if (m_forgetRequested.exchange(false, std::memory_order_acquire))
            applyShaderForget();

        // Spout publishing asked for from the menu (or from the stored preference at startup): applied
        // here, where the output size is known.
        if (m_spoutRequestPending.exchange(false, std::memory_order_acquire))
            applySpoutRequest();

        // Applied at the top of the frame, before anything is drawn, so a resize
        // can never land between the clear and the draw. This is the only place
        // the target changes size.
        applyRenderTargetSizeRequest();

        // A rate change made from the menu since the last frame: RESTART, do not adjust.
        //
        // nextDeadlineNs was accumulated from the OLD interval, so after a change it is a
        // value belonging to a different target - continuing to pace against it means pacing
        // M beats to N's tempo. Every "smooth" way to adapt it is a way of preserving a
        // number that has stopped meaning anything.
        //
        // So everything deriving from the old rate is thrown away and re-anchored to now:
        // the pacing deadline, the statistics window, and the frame delta. That is also why
        // the three risks of a live rate change - catching up (a burst of frames), stalling
        // (waiting out a stale deadline), and statistics that average two different rates -
        // need no separate handling: resetting is what removes them, rather than something
        // done to work around them.
        //
        // The frame is abandoned rather than drawn, because it was built from a pacing state
        // that no longer applies and its time delta would be measured against a frame from
        // the previous rate.
        if (applyRateChange(&capHz, &intervalNs, &spinWindowNs))
        {
            nextDeadlineNs = frameStartNs;
            reportTimer.restart();
            windowFrames = 0;
            windowWorstMs = 0.0;
            windowWaitUs = 0;
            windowWaitWorstUs = 0;
            // The minute's summary starts again too: a rate is only a target for the frames that were
            // paced to it, so a summary spanning a rate change would average two different questions.
            summaryTimer.restart();
            summarySeconds = 0;
            summaryFrames = 0;
            summaryWorstSecondFps = 0.0;
            summaryHaveFps = false;
            summaryWorstFrameMs = 0.0;
            summaryWaitUs = 0;
            summaryGpuMsSum = 0.0;
            summaryGpuCount = 0;
            summarySent = 0;
            summaryDropped = 0;
            summaryReadbackMsSum = 0.0;
            summaryReadbackCount = 0;
            lastFrameStartNs = frameStartNs;
            GraphicsLog::info(QStringLiteral("render loop: rate changed to %1Hz "
                                             "(interval %2ns, spin %3us); pacing restarted")
                                  .arg(capHz)
                                  .arg(intervalNs)
                                  .arg(spinWindowNs / 1000));
            continue;
        }

        GraphicsFrame frame;
        frame.timeSeconds = double(frameStartNs - clockStartNs) / 1.0e9;
        // Zero on the first frame: there is no previous frame to measure against,
        // and inventing one would be a value a shader could act on.
        frame.deltaSeconds = (totalFrames == 0)
                                 ? 0.0
                                 : double(frameStartNs - lastFrameStartNs) / 1.0e9;
        frame.frameIndex = totalFrames;
        lastFrameStartNs = frameStartNs;

        // OSC-driven values, refreshed only when something actually changed: one atomic load per
        // frame against a hash copy per message. The snapshot is a member, so the pointer the frame
        // carries stays valid for the whole frame even if the GUI thread stores a new value in the
        // middle of it - the renderer can never see a half-updated set.
        if (m_uniformValues)
        {
            const quint64 version = m_uniformValues->version();
            if (version != m_uniformVersion)
            {
                m_uniformVersion = version;
                m_uniformSnapshot = m_uniformValues->snapshot();
            }
            frame.dynamic = &m_uniformSnapshot;
        }

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

        // The renderer for whichever buffer is active, read once for the frame: a switch applied at the
        // top of this frame is already in effect here, and one requested from another thread during the
        // frame waits for the next - which is the point of applying switches at a frame boundary.
        GraphicsRenderer* activeRenderer = m_activeRenderer.load(std::memory_order_relaxed);

        // The document's passes, in the order GraphicsPasses.h names: each into its own target pair, so a
        // pass samples the previous frame of anything it reads while this frame's earlier passes are
        // already written. Nothing here touches the on-screen path below - m_targets, the active renderer
        // and the handoff are left exactly as they were - so this draws off-screen and the picture is
        // unchanged until channels are bound, which is the next step.
        //
        // Channels are deliberately unbound: a pass that samples one gets black, the rule the web renderer
        // settled on for an absent buffer. Reported when the count CHANGES, never per frame.
        if (m_passPrograms && m_passPrograms->isValid())
        {
            int drawn = 0;
            for (int i = 0; i < kDrawOrderCount; ++i)
            {
                GraphicsRenderer* passRenderer = m_passPrograms->pass(kDrawOrder[i]);
                if (!passRenderer || !m_bufferTargets[i])
                    continue;   // an empty pass costs nothing

                GraphicsTarget* passTarget = m_bufferTargets[i]->write();
                if (!passTarget)
                    continue;

                passTarget->bind();
                if (QOpenGLExtraFunctions* extra = m_context ? m_context->extraFunctions() : nullptr)
                    extra->glViewport(0, 0, passTarget->size().width(), passTarget->size().height());

                // The frame values are shared with the pass, so a pass sees the same clock as the buffer on
                // screen; only the resolution differs, and the existing code sets that again before it draws.
                // Every channel reads the READ side of its buffer, which after each pass's swap is this
                // frame's result for a pass already drawn and last frame's for one not drawn yet - so the
                // "earlier = this frame, self or later = last frame" rule falls out of the ping-pong for
                // free, with no index arithmetic to get wrong.
                //
                // THE SOURCES COME FROM A CACHE, NOT FROM DISK. This loop used to call
                // graphicsDocumentChannelSourcesFromFile() four times per pass - twenty file opens and
                // parses per frame, at 60Hz and up, for a file that changes only when a person clicks. They
                // are read once where the document is prepared (applyPassDocumentRequest, and at startup)
                // and kept in m_channelSources; "what a channel reads" cannot change mid-frame, which is the
                // rule the comment above already stated for the assignment as a whole.
                const QList<GraphicsChannelSource>& passSources = m_channelSources[i];
                for (int ch = 0; ch < 4; ++ch)
                {
                    GraphicsChannelSource passSource;
                    if (ch < passSources.size())
                        passSource = passSources[ch];
                    if (!m_channelFileDescribesDocument)
                    {
                        // No channels.txt at all: the historical default, channel i reads Buffer i.
                        passSource.kind = GraphicsChannelSource::Buffer;
                        passSource.bufferIndex = ch;
                    }

                    // textureForChannel() owns the difference: a buffer's read side, an image, or a cube. The
                    // bind target follows the kind, because a cube bound as GL_TEXTURE_2D is a GL error and a
                    // black channel - the kind of mistake that looks like "the image did not load".
                    frame.channelTexture[ch] = textureForChannel(passSource);
                    if (frame.channelTexture[ch] != 0 && m_context && m_context->extraFunctions())
                    {
                        m_context->extraFunctions()->glBindTexture(
                            passSource.kind == GraphicsChannelSource::Cubemap ? GL_TEXTURE_CUBE_MAP
                                                                              : GL_TEXTURE_2D,
                            frame.channelTexture[ch]);
                    }
                }

                frame.resolution = passTarget->size();
                if (passRenderer->renderInto(*passTarget, frame))
                    ++drawn;

                m_bufferTargets[i]->swap();   // this frame's result becomes what a later pass reads
            }
            if (drawn != m_passesDrawnLastFrame)
            {
                m_passesDrawnLastFrame = drawn;

                // ONE measurement, when the count changes: what the passes actually wrote. Buffer A writes
                // (1.0, 0.5) and the Image pass reads it through channel 0 unchanged, so this must read
                // rgb(255,128) - the composite assertion the web renderer used, and the only thing here
                // that proves the channel is bound and the order is right rather than merely configured.
                {
                    const int imageIndex = graphicsPassDrawIndex(GraphicsPass::Image);
                    GraphicsTarget* imageSide = (imageIndex >= 0 && m_bufferTargets[imageIndex])
                                                    ? m_bufferTargets[imageIndex]->read() : nullptr;
                    if (imageSide && imageSide->isValid() && m_context && m_context->extraFunctions())
                    {
                        QOpenGLExtraFunctions* extra = m_context->extraFunctions();
                        const QSize size = imageSide->size();
                        imageSide->bind();
                        unsigned char pixel[4] = { 0, 0, 0, 0 };
                        extra->glReadPixels(size.width() / 2, size.height() / 2, 1, 1,
                                            GL_RGBA, GL_UNSIGNED_BYTE, pixel);
                        GraphicsLog::info(QStringLiteral("pass pixel: Image centre = rgb(%1,%2,%3) "
                                                         "(Buffer A wrote rgb(255,128,0); the channel is bound "
                                                         "and the order holds when they agree)")
                                              .arg(pixel[0]).arg(pixel[1]).arg(pixel[2]));
                    }
                }
                GraphicsLog::info(QStringLiteral("passes drawn: %1 of %2 (off-screen; channels read the document's own buffers)")
                                      .arg(drawn)
                                      .arg(kDrawOrderCount));
            }
        }
        if (activeRenderer && m_targets[back])
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
            // While a document is on screen, its Image pass IS the picture: blit that pass's finished result
            // into this very target, in place of the candidate renderer's own draw. Everything else in this
            // block - the fences above, the timing and stats below, the publish - runs unchanged, which is
            // the point: the display path is not rewritten, only fed. A blit re-runs no shader and does not
            // touch the channels, which stay bound inside the pass loop where the passes draw. Sizes may
            // differ (blitFramebuffer scales, per Qt's documentation), which will matter as soon as output
            // size and pass size are allowed to differ.
            const int documentImageIndex = (m_passPrograms && m_passPrograms->isValid())
                                               ? graphicsPassDrawIndex(GraphicsPass::Image)
                                               : -1;
            GraphicsTarget* documentImage = (documentImageIndex >= 0 && m_bufferTargets[documentImageIndex])
                                                ? m_bufferTargets[documentImageIndex]->read()
                                                : nullptr;
            bool drewDocumentImage = false;
            if (documentImage && documentImage->isValid())
            {
                QOpenGLExtraFunctions* blit = m_context ? m_context->extraFunctions() : nullptr;
                if (blit)
                {
                    const QSize from = documentImage->size();
                    const QSize to = target.size();
                    blit->glBindFramebuffer(GL_READ_FRAMEBUFFER, documentImage->framebuffer());
                    blit->glBindFramebuffer(GL_DRAW_FRAMEBUFFER, target.framebuffer());
                    blit->glBlitFramebuffer(0, 0, from.width(), from.height(),
                                            0, 0, to.width(), to.height(),
                                            GL_COLOR_BUFFER_BIT, GL_NEAREST);
                    // Read the DISPLAY target back while it is still bound, straight after the blit. This is
                    // what separates "the blit did not deliver" from "the display path did not show what was
                    // delivered" - the same one-pixel discipline as everywhere else, and the only way to tell
                    // those two apart from a log.
                    if (m_screenSource != documentImageIndex)
                    {
                        unsigned char check[4] = { 0, 0, 0, 0 };
                        blit->glReadPixels(to.width() / 2, to.height() / 2, 1, 1,
                                           GL_RGBA, GL_UNSIGNED_BYTE, check);
                        GraphicsLog::info(QStringLiteral("display target after blit: rgb(%1,%2,%3) "
                                                         "(the Image pass's own centre was rgb(255,127,0) "
                                                         "when this is taken)")
                                              .arg(check[0]).arg(check[1]).arg(check[2]));
                    }
                    blit->glBindFramebuffer(GL_FRAMEBUFFER, 0);
                    drewDocumentImage = true;

                    // Said when the source CHANGES, not per frame - and the pixel is read back once for the
                    // same reason: one number that can be wrong beats 60 lines a second that nobody reads.
                    if (m_screenSource != documentImageIndex)
                    {
                        m_screenSource = documentImageIndex;
                        GraphicsLog::info(QStringLiteral("screen source: the document's Image pass "
                                                         "(%1x%2 -> %3x%4)")
                                              .arg(from.width()).arg(from.height())
                                              .arg(to.width()).arg(to.height()));
                    }
                }
            }
            // A document's Image pass was blitted in above, so the shader is NOT re-run - but the body of
            // this block must still run: it is where the frame is published to the consumers. Skipping the
            // whole block left them reading an old cleared target, which is what a blue screen and a black
            // debug window turned out to be.
            if (drewDocumentImage || activeRenderer->renderInto(target, frame))
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

            // Spout, if publishing. AFTER the publication above and while the target's framebuffer is
            // still bound: glReadPixels reads the framebuffer that is bound at the moment of the call, and
            // the draw has just been issued into it. The copy is queued rather than waited for, and the
            // PREVIOUS frame is the one taken, so this costs the loop the microseconds it takes to issue
            // the read - the figure itself goes to the overlay, and to the log once, once it has settled.
            if (m_spoutPublishing.load(std::memory_order_relaxed))
                publishFrameToSpout();
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
            const double waitAvgUs = windowFrames ? double(windowWaitUs) / double(windowFrames) : 0.0;

            // Copied out before the resets at the end of this block: the minute's summary is built from
            // these, and by then the accumulators they come from are gone.
            const quint64 framesThisSecond = windowFrames;
            const double worstMsThisSecond = windowWorstMs;
            double gpuAvgThisSecond = -1.0;

            m_fps.store(fps, std::memory_order_relaxed);
            m_worstFrameMs.store(windowWorstMs, std::memory_order_relaxed);

            // The GPU time, averaged over the window rather than sampled once.
            //
            // The renderer returns one frame's figure at a time, a few frames late, so a single
            // reading is a point sample of a quantity that varies; averaged over a second it
            // describes the shader rather than the frame. -1 means the timer is unavailable, and
            // is carried through rather than turned into 0 - a shader that costs nothing and a
            // shader that was not measured must not look alike.
            if (activeRenderer)
            {
                const double gpuNow = activeRenderer->gpuFrameMs();
                if (gpuNow >= 0.0)
                {
                    windowGpuMsSum += gpuNow;
                    ++windowGpuCount;
                    windowGpuMsWorst = qMax(windowGpuMsWorst, gpuNow);
                }
                const double avg = windowGpuCount > 0 ? windowGpuMsSum / double(windowGpuCount) : -1.0;
                gpuAvgThisSecond = avg;
                activeRenderer->setGpuFrameAverages(avg,
                                                    windowGpuCount > 0 ? windowGpuMsWorst : -1.0);
            }

            // Published for the debug window. Written once per reporting window rather
            // than per frame: a figure that changes 60 times a second cannot be read, so
            // a store in the hot path would buy nothing. The window draws them a little
            // slower still (see GraphicsPreviewWindow::kStatsIntervalMs).
            m_consumerWaitAvgUs.store(waitAvgUs, std::memory_order_relaxed);
            m_consumerWaitWorstUs.store(double(windowWaitWorstUs), std::memory_order_relaxed);

            // Whether the renderer is keeping up with the rate the user asked for.
            //
            // Decided here, once, by the side that measures both numbers. The rate setting is
            // a SCHEDULING constraint - this is a realtime audio application and an offscreen
            // renderer must not take the machine - and it is simultaneously the expectation
            // the user wants reported on. Pacing to it does not weaken that report: a pacer
            // that cannot keep up simply does not, the measured rate falls below the target,
            // and this notices.
            //
            // STRICTLY below, at the user's request, with no tolerance band and no minimum
            // duration.
            //
            // An earlier version required three consecutive seconds below 95%, and both of
            // those numbers were my choice rather than the user's. The effect was to stay
            // silent through a real shortfall for several seconds while deciding on the user's
            // behalf that a one-second dip was not worth mentioning. Whether a dip is jitter
            // or a genuine limit is a judgement about that user's own machine and shader, so
            // the job here is to report the fact rather than to grade it.
            //
            // The cost is that a rate landing exactly on the target can oscillate across it
            // and report repeatedly. That is accepted. It is bounded by being reported on the
            // TRANSITION only: a sustained shortfall produces one entry, not one a second.
            //
            // A missing cap (0) means no expectation to measure against, so nothing is
            // reported: "unlimited" is not a target that can be missed.
            bool belowTarget = false;
            if (capHz > 0 && fps > 0.0)
            {
                const bool wasBelow = m_belowTarget.load(std::memory_order_relaxed);
                const bool isBelow = fps < double(capHz);
                if (isBelow != wasBelow)
                    m_belowTarget.store(isBelow, std::memory_order_relaxed);
                belowTarget = isBelow;
            }

            // Nothing is logged per second, on purpose.
            //
            // There used to be a full statistics line here every second, and before that a
            // WARN entry whenever the rate fell below the target. Both are gone:
            //
            //   * The figures are on SCREEN, in the debug window's top-left corner, coloured
            //     green or amber against the target. A rate is something to watch while
            //     working, not to read afterwards, and the colour carries "am I getting what
            //     I asked for" without a line of text per second.
            //   * An entry a second, plus the two windows' own entries, made the log mostly
            //     a record of the frame rate - harder to read than the thing it reported on,
            //     which defeats the purpose of a log.
            //
            // What remains in the log is what a log is for: what was set up, what changed, and
            // anything that went wrong. m_fps, m_belowTarget and the rest are still published
            // to GraphicsFrameStats every second - that is how the overlay gets them - so the
            // information is produced exactly as before; only the writing of it per second
            // has stopped.
            emit frameStatsUpdated();

            // Spout, for the window that just ended. The figures go to GraphicsFrameStats for the overlay;
            // the LOG gets only what is new - one measurement when publishing starts, and a warning when
            // frames begin to be dropped (which means a receiver is behind, and the picture being sent is
            // no longer the picture being drawn).
            quint64 sentThisSecond = 0;
            quint64 droppedThisSecond = 0;
            double readbackThisSecond = -1.0;
            if (m_spoutPublishing.load(std::memory_order_relaxed))
            {
                quint64 sent = 0;
                quint64 dropped = 0;
                QMutexLocker spoutLock(&m_spoutMutex);
                if (m_spoutPublisher)
                {
                    sent = m_spoutPublisher->takeSentCount();
                    dropped = m_spoutPublisher->takeDroppedCount();
                }
                sentThisSecond = sent;
                droppedThisSecond = dropped;

                const double readbackAvg = m_spoutReadbackCount > 0
                                               ? m_spoutReadbackMsSum / double(m_spoutReadbackCount)
                                               : -1.0;
                readbackThisSecond = readbackAvg;
                const double issueAvg = m_spoutReadbackCount > 0
                                            ? m_spoutIssueMsSum / double(m_spoutReadbackCount)
                                            : 0.0;
                const double mapAvg = m_spoutReadbackCount > 0
                                          ? m_spoutMapMsSum / double(m_spoutReadbackCount)
                                          : 0.0;
                const double publishAvg = m_spoutReadbackCount > 0
                                              ? m_spoutPublishMsSum / double(m_spoutReadbackCount)
                                              : 0.0;
                const double unmapAvg = m_spoutReadbackCount > 0
                                            ? m_spoutUnmapMsSum / double(m_spoutReadbackCount)
                                            : 0.0;
                if (m_spoutReadbackCount > 0)
                    ++m_spoutMeasuredWindows;

                m_spoutSentWindow.store(sent, std::memory_order_relaxed);
                m_spoutDroppedWindow.store(dropped, std::memory_order_relaxed);
                // Nothing until the warm-up is behind us: a figure from the window that started the moment
                // publishing was switched on is several times the real cost, and putting THAT on screen
                // would be showing the user a number that is wrong by a factor of ten. The overlay renders
                // a negative value as "-", so the line shows the frame rates and dashes for the cost until
                // there is something worth reporting.
                m_spoutReadbackMsAvg.store(m_spoutMeasuredWindows >= kSpoutSettleWindows ? readbackAvg : -1.0,
                                           std::memory_order_relaxed);

                // Not the first windows: see kSpoutSettleWindows for the measurement that moved this from
                // three to ten. Written once when it has settled, and then again only if it MOVES - a
                // figure that is printed once and never revisited is a claim rather than a measurement, and
                // a receiver appearing or going away is exactly what would move it.
                const bool settled = m_spoutMeasuredWindows >= kSpoutSettleWindows && m_spoutReadbackCount > 0;
                const bool moved = m_spoutFirstMeasurementLogged
                                   && qAbs(readbackAvg - m_spoutLoggedMs) > kSpoutRelogMs
                                   && m_spoutMeasuredWindows - m_spoutLoggedWindow >= kSpoutRelogWindows;
                if (settled && (!m_spoutFirstMeasurementLogged || moved))
                {
                    const bool first = !m_spoutFirstMeasurementLogged;
                    m_spoutFirstMeasurementLogged = true;
                    m_spoutLoggedMs = readbackAvg;
                    m_spoutLoggedWindow = m_spoutMeasuredWindows;
                    GraphicsLog::info(QStringLiteral("spout: read-back costs %1 ms a frame (queueing the "
                                                     "copy %2 ms, waiting for the pixels %3 ms, handing "
                                                     "them to the sender %4 ms, releasing the buffer %5 ms%6); "
                                                     "%7 frames sent, %8 dropped in the last second")
                                          .arg(readbackAvg, 0, 'f', 2)
                                          .arg(issueAvg, 0, 'f', 2)
                                          .arg(mapAvg, 0, 'f', 2)
                                          .arg(publishAvg, 0, 'f', 2)
                                          .arg(unmapAvg, 0, 'f', 2)
                                          .arg(first ? QString() : QStringLiteral(", and it has moved"))
                                          .arg(sent)
                                          .arg(dropped));
                }

                const bool dropping = dropped > 0;
                if (dropping && !m_spoutDropping)
                    GraphicsLog::warn(QStringLiteral("spout: dropping frames (%1 in the last second, %2 "
                                                     "sent) - the receiver is behind, and what it shows is "
                                                     "no longer the newest frame").arg(dropped).arg(sent));
                else if (!dropping && m_spoutDropping)
                    GraphicsLog::info(QStringLiteral("spout: no longer dropping frames"));
                m_spoutDropping = dropping;

                m_spoutReadbackMsSum = 0.0;
                m_spoutIssueMsSum = 0.0;
                m_spoutMapMsSum = 0.0;
                m_spoutPublishMsSum = 0.0;
                m_spoutUnmapMsSum = 0.0;
                m_spoutReadbackCount = 0;
            }
            else
            {
                m_spoutSentWindow.store(0, std::memory_order_relaxed);
                m_spoutDroppedWindow.store(0, std::memory_order_relaxed);
                m_spoutReadbackMsAvg.store(-1.0, std::memory_order_relaxed);
                m_spoutFirstMeasurementLogged = false;
                m_spoutMeasuredWindows = 0;
                m_spoutLoggedMs = -1.0;
                m_spoutLoggedWindow = 0;
                m_spoutDropping = false;
            }

            windowFrames = 0;
            windowWorstMs = 0.0;
            windowWaitUs = 0;
            windowWaitWorstUs = 0;
            windowGpuMsSum = 0.0;
            windowGpuMsWorst = 0.0;
            windowGpuCount = 0;
            reportTimer.restart();

            // The minute's summary, and the only place the three rates meet.
            //
            // Built from this window's own figures rather than from a second set of counters, so the
            // numbers in the line are the numbers the overlay was showing during that minute - taken
            // before the resets above, which is why they are copied out first. The WORST second is in it
            // because an average hides the thing a user who asked for 144Hz cares about: whether every
            // second met it, or only most of them did.
            ++summarySeconds;
            summaryFrames += framesThisSecond;
            if (!summaryHaveFps || fps < summaryWorstSecondFps)
            {
                summaryWorstSecondFps = fps;
                summaryHaveFps = true;
            }
            summaryWorstFrameMs = qMax(summaryWorstFrameMs, worstMsThisSecond);
            summaryWaitUs += qint64(waitAvgUs * double(framesThisSecond));
            summarySent += sentThisSecond;
            summaryDropped += droppedThisSecond;
            if (readbackThisSecond >= 0.0)
            {
                summaryReadbackMsSum += readbackThisSecond;
                ++summaryReadbackCount;
            }
            if (gpuAvgThisSecond >= 0.0)
            {
                summaryGpuMsSum += gpuAvgThisSecond;
                ++summaryGpuCount;
            }

            if (summaryTimer.elapsed() >= 60000 && summaryFrames > 0)
            {
                const double summarySecs = double(summaryTimer.elapsed()) / 1000.0;
                const double summaryFps = double(summaryFrames) / summarySecs;
                const double frameMsAvg = 1000.0 / summaryFps;
                const double waitMsAvg = double(summaryWaitUs) / double(summaryFrames) / 1000.0;

                GraphicsLog::info(
                    QStringLiteral("render loop: %1 fps of %2 target (%3s, %4 frames, worst second %5); "
                                   "frame %6 ms avg / %7 ms worst; consumer wait %8 ms avg; gpu %9 ms avg")
                        .arg(summaryFps, 0, 'f', 1)
                        .arg(capHz)
                        .arg(summarySecs, 0, 'f', 1)
                        .arg(summaryFrames)
                        .arg(summaryWorstSecondFps, 0, 'f', 1)
                        .arg(frameMsAvg, 0, 'f', 2)
                        .arg(summaryWorstFrameMs, 0, 'f', 2)
                        .arg(waitMsAvg, 0, 'f', 2)
                        .arg(summaryGpuCount > 0
                                 ? QString::number(summaryGpuMsSum / double(summaryGpuCount), 'f', 2)
                                 : QStringLiteral("-")));

                if (summarySent > 0 || summaryDropped > 0)
                {
                    GraphicsLog::info(
                        QStringLiteral("spout: %1 fps sent (%2 frames, %3 dropped, %4/s) over the same "
                                       "%5s; read-back %6 ms avg")
                            .arg(double(summarySent) / summarySecs, 0, 'f', 1)
                            .arg(summarySent)
                            .arg(summaryDropped)
                            .arg(double(summaryDropped) / summarySecs, 0, 'f', 1)
                            .arg(summarySecs, 0, 'f', 1)
                            .arg(summaryReadbackCount > 0
                                     ? QString::number(summaryReadbackMsSum
                                                           / double(summaryReadbackCount),
                                                       'f', 2)
                                     : QStringLiteral("-")));
                }

                summaryTimer.restart();
                summarySeconds = 0;
                summaryFrames = 0;
                summaryWorstSecondFps = 0.0;
                summaryHaveFps = false;
                summaryWorstFrameMs = 0.0;
                summaryWaitUs = 0;
                summaryGpuMsSum = 0.0;
                summaryGpuCount = 0;
                summarySent = 0;
                summaryDropped = 0;
                summaryReadbackMsSum = 0.0;
                summaryReadbackCount = 0;
            }
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
            pacer.wait(sleepNs);

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

        // The multi-pass pair is a GL object too, so it goes while the context is still current - the
        // same reason the two above are reset here rather than left to member destruction, which runs
        // long after the context is gone.
        if (m_passPrograms) {
            m_passPrograms->destroy();
            m_passPrograms.reset();
        }

        for (int i = 0; i < kPassCount; ++i) {
            if (m_bufferTargets[i]) {
                m_bufferTargets[i]->destroy();
                m_bufferTargets[i].reset();
            }
        }

        // The query objects belong to this context, so they go while it is still current - for every
        // buffer's renderer, not just the one that happened to be on screen.
        {
            QMutexLocker lock(&m_rendererMutex);
            for (auto& entry : m_renderers)
            {
                if (entry.second)
                    entry.second->releaseGpuTimer();
            }
            m_activeRenderer.store(nullptr, std::memory_order_relaxed);
            m_renderers.clear();
        }
    }

    m_context->doneCurrent();
}

} // namespace SonicPi
