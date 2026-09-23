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
#include <QFontMetrics>
#include <QKeyEvent>
#include <QOpenGLContext>
#include <QPainter>
#include <QSurfaceFormat>

namespace SonicPi
{

namespace
{
// How often the overlay image is rebuilt.
//
// The frame rate is the number the user watches, so it has to move fast enough to look live,
// but the statistics behind it only update once a second, and redrawing the image is a
// QPainter pass plus a texture upload. A quarter of a second reads as live without doing
// that work sixty times a second for a number that has not changed.
constexpr qint64 kOverlayIntervalMs = 250;

// The overlay's own scale, in device pixels so the glyphs stay sharp on a high-DPI screen
// without any scaling arithmetic.
constexpr int kPadding = 6;
constexpr int kFontPx = 15;
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

    // One line at startup and then quiet. The frame rate is shown IN the window, so there is
    // nothing left to say per second: this window's own statistics are detail about a viewer,
    // and detail that repeats is what made the log unreadable. See reportStats()'s absence -
    // it was removed rather than slowed down.
    GraphicsLog::info(QStringLiteral("preview: ready, consumer slot %1 of %2, %3x%4; "
                                     "live fps is drawn in the window")
                          .arg(int(GraphicsConsumer::Preview))
                          .arg(int(GraphicsConsumer::Count))
                          .arg(width())
                          .arg(height()));
}

void GraphicsPreviewWindow::resizeGL(int w, int h)
{
    // Unlike the frame rate, a size change IS worth a log entry: it changes what is being
    // displayed and when something looks wrong on screen this is the first thing worth
    // knowing. Also written by the output window, for the same reason.
    GraphicsLog::info(QStringLiteral("preview: resized to %1x%2 (logical)").arg(w).arg(h));
    QOpenGLWindow::resizeGL(w, h);
    update();
}

// The fitting itself lives in GraphicsTextureView.h as fittedFrameRect(), shared with the
// output window. It used to be a method here; two copies of a rule about the display side is
// how this feature has previously ended up with implementations that disagree.

// Build the overlay image from the render thread's figures.
//
// Everything shown comes from the producer's snapshot; this window measures nothing itself.
// The one comparison made here is equality against the target, and it is made only to choose
// a colour - the render thread has already decided whether the target is being met and
// publishes that as belowTarget, so the two cannot disagree about it.
void GraphicsPreviewWindow::refreshFpsOverlay()
{
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    if (now - m_lastOverlayMs < kOverlayIntervalMs)
        return;
    m_lastOverlayMs = now;

    if (!m_renderThread)
        return;

    const GraphicsFrameStats s = m_renderThread->frameStats();
    if (s.frameCapHz <= 0)
        return;   // no target to show against

    const QString fpsText = QStringLiteral("%1").arg(s.fps, 0, 'f', 1);
    const QString targetText = QStringLiteral("/ %1 fps").arg(s.frameCapHz);
    // The GPU figure, when it could be measured. -1 means the timer is unavailable, and is shown
    // as "-" rather than as 0.0: a shader that costs nothing and a shader that was not measured
    // must not look alike, and 0.0 would read as the former.
    const QString gpuText = s.gpuMsAvg >= 0.0
                                ? QStringLiteral("gpu %1 ms").arg(s.gpuMsAvg, 0, 'f', 2)
                                : QStringLiteral("gpu -");

    if (fpsText == m_lastFpsText && gpuText == m_lastGpuText)
        return;
    m_lastFpsText = fpsText;
    m_lastGpuText = gpuText;

    QFont font(QStringLiteral("Consolas"));
    font.setPixelSize(kFontPx);
    font.setStyleHint(QFont::Monospace);
    font.setBold(true);

    const QFontMetrics fm(font);
    const int textW = qMax(qMax(fm.horizontalAdvance(fpsText), fm.horizontalAdvance(targetText)),
                           fm.horizontalAdvance(gpuText));
    const int lineH = fm.height();

    QImage img(textW + kPadding * 2, lineH * 3 + kPadding * 2, QImage::Format_ARGB32);
    img.fill(QColor(0, 0, 0, 170));

    QPainter p(&img);
    p.setFont(font);

    // Green while the target is being met, amber when it is not. The threshold is the producer's,
    // not this window's - see GraphicsFrameStats::belowTarget.
    p.setPen(s.belowTarget ? QColor(255, 190, 70) : QColor(120, 255, 140));
    p.drawText(kPadding, kPadding + fm.ascent(), fpsText);

    p.setPen(QColor(210, 210, 210));
    p.drawText(kPadding, kPadding + lineH + fm.ascent(), targetText);
    p.drawText(kPadding, kPadding + lineH * 2 + fm.ascent(), gpuText);
    p.end();

    m_view.setOverlay(img);
}

void GraphicsPreviewWindow::paintGL()
{
    QOpenGLFunctions* f = context() ? context()->functions() : nullptr;
    if (!f)
        return;

    // This window is a CONSUMER. It displays the render thread's frame and never draws a
    // shader of its own - a second thing able to draw the picture would be a second
    // producer, with its own clock and its own copy of every uniform.
    const qreal dpr = devicePixelRatio();
    const QSize surface(qMax(1, int(width() * dpr)), qMax(1, int(height() * dpr)));

    // The whole surface first, so the letterbox margin is BLACK rather than whatever the
    // previous frame left there. The margin has to be painted by someone, and black is what
    // makes the fitted frame read as the whole picture.
    f->glViewport(0, 0, surface.width(), surface.height());
    f->glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
    f->glClear(GL_COLOR_BUFFER_BIT);

    // Fit the frame to the window. Until a frame has been seen there is nothing to fit to,
    // so the target size is used - it is the same size, and it means the picture is correctly
    // placed from the very first paint rather than jumping on the second.
    QSize frame = m_view.lastFrameSize();
    if (frame.isEmpty() && m_renderThread)
        frame = m_renderThread->renderTargetSize();

    const QRect dest = fittedFrameRect(frame, surface);
    if (!dest.isEmpty())
    {
        // glViewport's origin is the bottom-left, the rect's is the top-left - hence the y
        // conversion, done here because this is where the two conventions meet.
        f->glViewport(dest.x(), surface.height() - (dest.y() + dest.height()),
                      dest.width(), dest.height());
        m_view.drawSharedFrame();
    }

    refreshFpsOverlay();

    // Ask for the next repaint, ALWAYS.
    //
    // This was briefly gated on the frame index changing, to stop the window repainting
    // faster than the producer draws. That was a serious bug, and it presented as the exact
    // opposite of waste: the picture FROZE, because drawSharedFrame() updates the view's frame
    // index on every paint, so on the second paint of a frame the condition was already false
    // and no further update was requested.
    //
    // The general rule it broke: requesting the next frame must never be conditional on state
    // that drawing the current frame changes. requestUpdate() is right precisely BECAUSE it
    // coalesces - asking every time is how it is meant to be used, and the platform decides
    // how many requests become paints.
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
