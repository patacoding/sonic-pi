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

#include "GraphicsPreviewWindow.h"
#include "GraphicsLog.h"

#include <QCloseEvent>
#include <QDateTime>
#include <QKeyEvent>
#include <QOpenGLContext>
#include <QSurfaceFormat>

namespace SonicPi
{

namespace
{
// How often the numbers are written to the log. Not per frame: a figure that changes 60
// times a second cannot be read, and it would bury everything else in the file. Five
// times a second is fast enough to watch a number settle and slow enough to read.
constexpr qint64 kStatsIntervalMs = 200;
} // namespace

GraphicsPreviewWindow::GraphicsPreviewWindow(QWindow* parent)
    : QOpenGLWindow(NoPartialUpdate, parent)
{
    setTitle(QStringLiteral("Sonic Pi - Graphics Debug"));
    resize(kDefaultWidth, kDefaultHeight);

    // A 3.3 Core context, matching the render thread and the output window. The Qt
    // default is 2.0 with no profile, which would deny the shared texture and the
    // `#version 330 core` display shader without saying why.
    QSurfaceFormat fmt = QSurfaceFormat::defaultFormat();
    fmt.setVersion(3, 3);
    fmt.setProfile(QSurfaceFormat::CoreProfile);
    fmt.setRenderableType(QSurfaceFormat::OpenGL);
    fmt.setDepthBufferSize(0);
    fmt.setStencilBufferSize(0);
    fmt.setSwapInterval(1);
    setFormat(fmt);

    // Scaling the frame down into a small window needs filtering. See
    // GraphicsTextureView::setSmoothScaling.
    m_view.setSmoothScaling(true);
}

GraphicsPreviewWindow::~GraphicsPreviewWindow() = default;

void GraphicsPreviewWindow::setRenderThread(GraphicsRenderThread* thread)
{
    m_renderThread = thread;
}

void GraphicsPreviewWindow::initializeGL()
{
    if (!context() || !context()->isValid())
    {
        GraphicsLog::error(QStringLiteral("preview: no valid GL context in initializeGL"));
        return;
    }

    if (!m_view.initialize())
    {
        GraphicsLog::error(QStringLiteral("preview: the texture view failed to initialise"));
        return;
    }

    // Reported because the failure is silent - everything runs, the picture is just
    // missing - and because the answer depends on sharing being set up before
    // QApplication, which is easy to get wrong and impossible to see from the outside.
    QOpenGLContext* group = QOpenGLContext::globalShareContext();
    GraphicsLog::info(QStringLiteral("preview: share group %1")
           .arg(!group ? QStringLiteral("NONE (Qt has no global share context)")
                       : (context()->shareGroup() == group->shareGroup()
                              ? QStringLiteral("matches Qt's global group")
                              : QStringLiteral("DIFFERENT from Qt's global group"))));
    GraphicsLog::info(QStringLiteral("preview: ready, consumer slot %1 of %2; "
                                     "stats are written to this log, not drawn in the window")
                          .arg(int(GraphicsConsumer::Preview))
                          .arg(int(GraphicsConsumer::Count)));
}

void GraphicsPreviewWindow::resizeGL(int w, int h)
{
    Q_UNUSED(w);
    Q_UNUSED(h);
    // Nothing to rebuild: the render target is the user's fixed output resolution, and a
    // resize only changes how large the fitted copy of it is. The repaint is all that is
    // needed.
    update();
}

// The whole frame, fitted by aspect ratio and centred, in device pixels with the
// bottom-left origin GL expects.
//
// Fit rather than crop, so nothing of the picture is ever hidden - that is the point of a
// preview. It also means this window is the one place where the output IS scaled, which is
// the opposite of the output window's rule (1:1, centred, never scaled). The two rules are
// different because the two windows answer different questions: the output window must show
// pixels exactly as rendered, the preview must show the whole picture whatever its size.
QRect GraphicsPreviewWindow::fittedRect(const QSize& frame, const QSize& surface) const
{
    if (frame.isEmpty() || surface.isEmpty())
        return QRect();

    // Integer arithmetic, so the result is exact and compares cleanly.
    const int byWidthH  = qMax(1, frame.height() * surface.width() / frame.width());
    const int byHeightW = qMax(1, frame.width() * surface.height() / frame.height());

    int w, h;
    if (byWidthH <= surface.height())
    {
        // Height-limited fit: the frame is relatively taller than the window.
        w = surface.width();
        h = byWidthH;
    }
    else
    {
        w = byHeightW;
        h = surface.height();
    }

    return QRect((surface.width() - w) / 2, (surface.height() - h) / 2, w, h);
}

void GraphicsPreviewWindow::reportStats()
{
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    if (m_lastReportMs == 0)
        m_lastReportMs = now;
    if (now - m_lastReportMs < kStatsIntervalMs)
        return;

    const qint64 elapsed = now - m_lastReportMs;
    m_lastReportMs = now;

    if (!m_renderThread)
        return;

    const GraphicsFrameStats s = m_renderThread->frameStats();
    ++m_statsReportCount;

    // Written once in full, then the paints-per-report field alone, so the steady state
    // does not bury the file. The full form is repeated every 5th report (once a second)
    // so a reader joining late always catches up quickly.
    // "Below target" is the only condition worth acting on, so it is called out.
    const bool below = s.frameCapHz > 0 && s.fps > 0.0 && s.fps < double(s.frameCapHz) * 0.97;

    GraphicsLog::info(QStringLiteral("preview: %1 | target %2 fps, actual %3 fps%4 | "
                                     "frame ms last %5 worst %6 | "
                                     "wait us avg %7 worst %8 | "
                                     "readers %9 | slow %10 fail %11 | "
                                     "paints %12 in %13ms | frames %14%15")
                          .arg(m_statsReportCount)
                          .arg(s.frameCapHz > 0 ? QString::number(s.frameCapHz)
                                                : QStringLiteral("auto"))
                          .arg(s.fps, 0, 'f', 1)
                          .arg(below ? QStringLiteral("  BELOW TARGET") : QString())
                          .arg(s.lastFrameMs, 0, 'f', 2)
                          .arg(s.worstFrameMs, 0, 'f', 2)
                          .arg(s.consumerWaitAvgUs, 0, 'f', 1)
                          .arg(s.consumerWaitWorstUs, 0, 'f', 1)
                          .arg(s.targetCount)
                          .arg(s.slowReaderCount)
                          .arg(s.waitFailedCount)
                          .arg(m_paintsSinceReport)
                          .arg(elapsed)
                          .arg(s.frames)
                          .arg(s.hung ? QStringLiteral("  STOPPED (watchdog)")
                                      : (s.loopRunning ? QString() : QStringLiteral("  STOPPED"))));
    m_paintsSinceReport = 0;
}

void GraphicsPreviewWindow::paintGL()
{
    QOpenGLFunctions* f = context() ? context()->functions() : nullptr;
    if (!f)
        return;

    ++m_paintsSinceReport;

    // This window is a CONSUMER. It displays the render thread's frame and never draws a
    // shader of its own - a second thing able to draw the picture would be a second
    // producer, with its own clock and its own copy of every uniform.
    const qreal dpr = devicePixelRatio();
    const QSize surface(qMax(1, int(width() * dpr)), qMax(1, int(height() * dpr)));

    // The whole surface first, so the letterbox margin is BLACK rather than whatever the
    // previous frame left there. The margin has to be painted by someone, and black is
    // what makes the fitted frame read as the whole picture.
    f->glViewport(0, 0, surface.width(), surface.height());
    f->glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
    f->glClear(GL_COLOR_BUFFER_BIT);

    // Fit the frame to the window. Until a frame has been seen there is nothing to fit to,
    // so the target size is used - it is the same size, and it means the picture is
    // correctly placed from the very first paint rather than jumping on the second.
    QSize frame = m_view.lastFrameSize();
    if (frame.isEmpty() && m_renderThread)
        frame = m_renderThread->renderTargetSize();

    const QRect dest = fittedRect(frame, surface);
    if (!dest.isEmpty())
    {
        // glViewport's origin is the bottom-left, the rect's is the top-left - hence the y
        // conversion, done here because this is where the two conventions meet.
        f->glViewport(dest.x(), surface.height() - (dest.y() + dest.height()),
                      dest.width(), dest.height());
        m_view.drawSharedFrame();
    }

    reportStats();

    // Ask for the next repaint, ALWAYS.
    //
    // This was briefly gated on the frame index changing, to stop the window repainting
    // faster than the producer draws. That was a serious bug, and it presented as the exact
    // opposite of waste: the picture FROZE.
    //
    // Why: drawSharedFrame() updates the view's frame index on every paint, so on the
    // second paint of the same frame the index was already equal to the one recorded when
    // the previous update was requested. The condition was false, no further update was
    // requested, and the loop stopped dead after one frame.
    //
    // The general rule it broke: requesting the next frame must never be conditional on
    // state that drawing the current frame changes.
    //
    // requestUpdate() is the right call here precisely BECAUSE it coalesces. Asking every
    // time is how it is meant to be used; the platform decides how many of those become
    // paints. Being asked too often means a frame delivered too often; being asked
    // conditionally means a stopped window.
    requestUpdate();
}

void GraphicsPreviewWindow::keyPressEvent(QKeyEvent* e)
{
    switch (e->key())
    {
    case Qt::Key_Escape:
        close();
        e->accept();
        return;
    default:
        break;
    }
    QOpenGLWindow::keyPressEvent(e);
}

void GraphicsPreviewWindow::closeEvent(QCloseEvent* e)
{
    GraphicsLog::info(QStringLiteral("preview: window closed by user"));
    emit closedByUser();
    QOpenGLWindow::closeEvent(e);
}

} // namespace SonicPi
