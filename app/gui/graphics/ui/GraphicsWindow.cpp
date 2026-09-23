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

#include "GraphicsWindow.h"
#include "GraphicsLog.h"
#include "GraphicsSettings.h"

#include <QDateTime>

#include <QCloseEvent>
#include <QGuiApplication>
#include <QKeyEvent>
#include <QOpenGLContext>
#include <QOpenGLFunctions>
#include <QOpenGLExtraFunctions>
#include <QScreen>

namespace SonicPi
{

GraphicsWindow::GraphicsWindow(QWindow* parent)
    : QOpenGLWindow(NoPartialUpdate, parent)
{
    setTitle(QStringLiteral("Sonic Pi - Graphics Output"));
    resize(kDefaultWidth, kDefaultHeight);

    // A 3.3 Core context, matching the render thread. The Qt default is 2.0 with
    // no profile, which would silently deny the FBO.
    QSurfaceFormat fmt = QSurfaceFormat::defaultFormat();
    fmt.setVersion(3, 3);
    fmt.setProfile(QSurfaceFormat::CoreProfile);
    fmt.setRenderableType(QSurfaceFormat::OpenGL);
    fmt.setDepthBufferSize(0);
    fmt.setStencilBufferSize(0);
    fmt.setSwapInterval(1);
    setFormat(fmt);
}

GraphicsWindow::~GraphicsWindow()
{
    // The view's GL objects are Qt RAII types and their destructors need the owning
    // context current. A window whose surface is already gone cannot provide one, in
    // which case Qt warns and leaks rather than crashing - which is the better failure.
    if (context() && context()->makeCurrent(this))
    {
        // m_view is a value member and is destroyed after this body runs, while the
        // context is still current. Nothing to do but make it current; the doneCurrent()
        // is deliberately NOT called, because the member destruction happens after it
        // would have.
    }
}

void GraphicsWindow::setRenderThread(GraphicsRenderThread* thread)
{
    // Stored, not used to set a size: the window does not decide the output
    // resolution. It is kept so the window can report which render target it is
    // displaying.
    m_renderThread = thread;
}

void GraphicsWindow::initializeGL()
{
    if (!context() || !context()->isValid())
    {
        GraphicsLog::error(QStringLiteral("window: no valid GL context in initializeGL"));
        return;
    }

    QOpenGLFunctions* f = context()->functions();
    if (f)
    {
        GraphicsLog::info(QStringLiteral("window GL context: %1")
                              .arg(QString::fromLatin1(
                                  reinterpret_cast<const char*>(f->glGetString(GL_VERSION)))));
    }

    // Whether this window can actually see the render thread's textures. Reported
    // because the failure is silent - everything runs, the picture is just missing
    // - and because the answer depends on AA_ShareOpenGLContexts having been set
    // before QApplication, which is easy to get wrong and impossible to see.
    {
        QOpenGLContext* group = QOpenGLContext::globalShareContext();
        GraphicsLog::info(QStringLiteral("window: share group %1")
               .arg(!group ? QStringLiteral("NONE (Qt has no global share context)")
                           : (context()->shareGroup() == group->shareGroup()
                                  ? QStringLiteral("matches Qt's global group")
                                  : QStringLiteral("DIFFERENT from Qt's global group"))));
    }

    // The size being displayed is the render target's, so the crop matches what was
    // actually rendered. Taken from the render thread rather than re-read from
    // settings: a second copy of the setting could disagree with the target.
    m_outputSize = m_renderThread ? m_renderThread->renderTargetSize()
                                  : GraphicsSettings::outputSize();
    {
        const qreal dpr = devicePixelRatio();
        const QSize surface(qMax(1, int(width() * dpr)), qMax(1, int(height() * dpr)));
        GraphicsLog::info(QStringLiteral("window: showing a 1:1 crop of the %1x%2 output; "
                                         "surface is %3x%4 device pixels (logical %5x%6 at dpr %7)")
                              .arg(m_outputSize.width()).arg(m_outputSize.height())
                              .arg(surface.width()).arg(surface.height())
                              .arg(width()).arg(height())
                              .arg(dpr));
    }

    // Nothing else to set up here: this window displays the render thread's
    // texture and builds its display shader lazily on the first frame it can show.
}

void GraphicsWindow::resizeGL(int w, int h)
{
    // Nothing to rebuild: the render target is the fixed output resolution and the
    // window only shows a crop of it, so a resize changes what is visible rather
    // than what is rendered. The repaint is all that is needed.
    Q_UNUSED(w);
    Q_UNUSED(h);
    update();
}

void GraphicsWindow::paintGL()
{
    QOpenGLFunctions* f = context() ? context()->functions() : nullptr;
    if (!f)
        return;

    ++m_paintCount;

    // This window is a CONSUMER. It displays the frame the render thread produced and
    // never draws a shader of its own.
    //
    // What it deliberately does not own any more is the sampling itself: the display
    // shader, the quad, the fence protocol and the repeat-the-last-frame behaviour all
    // live in GraphicsTextureView, because the debug preview needs exactly the same
    // behaviour. Two copies of the access rules would be two chances to get them wrong,
    // and this feature has already spent three attempts learning that.
    //
    // What is left here is what makes this a window: its surface, the crop, the clear, and
    // the cadence. The view draws into whatever viewport it is given.
    //
    // There is still no fallback that draws the shader here. A consumer that cannot get a
    // frame shows the background, which is honest; a second thing able to draw the picture
    // would be a second producer, with two renderers, two clocks, and a uniform that has
    // to be set in two places.
    const qreal dpr = devicePixelRatio();
    const QSize surface(qMax(1, int(width() * dpr)), qMax(1, int(height() * dpr)));

    // Clear the whole surface first, so the area outside the crop is the documented
    // background rather than whatever the previous frame left there. A window
    // larger than the output shows margin, and the margin has to be painted by
    // someone.
    f->glViewport(0, 0, surface.width(), surface.height());
    f->glClearColor(GraphicsRenderer::kClearR,
                    GraphicsRenderer::kClearG,
                    GraphicsRenderer::kClearB,
                    GraphicsRenderer::kClearA);
    f->glClear(GL_COLOR_BUFFER_BIT);

    // 1:1 crop, centred, never scaled - see cropRect().
    const QRect destination = cropRect();
    if (destination.isEmpty())
        return;

    // glViewport takes framebuffer pixels with the origin at the BOTTOM-left, while
    // the crop rectangle is in Qt's top-left coordinates - hence the y conversion.
    // Done here because this is where the two conventions meet. The view draws into
    // whatever viewport it is given, which is the whole of what it needs to know about
    // geometry.
    f->glViewport(destination.x(),
                  surface.height() - (destination.y() + destination.height()),
                  destination.width(),
                  destination.height());

    // Sampling, the fence handoff and "repeat the last frame if the producer has not
    // finished" all happen in here. The window deliberately does not know how.
    m_view.drawSharedFrame();

    // Report what is on screen, once a second.
    //
    // The acceptance check for the whole handover: the render thread logs its iFrame,
    // and if this window is showing that thread's output then the two must describe one
    // sequence. Before sharing they were two unrelated counters that both happened to
    // advance, which looks fine and proves nothing.
    //
    // The two failure counters are the other half of the check. "It looks smooth" is
    // not a measurement; a target that was busy or a fence that had not signalled is,
    // and each points at a different cause. Both being zero is what says the handoff
    // is actually free rather than merely fast enough to be unnoticeable.
    //
    // Timed by hand rather than through GraphicsLog::throttled(), which suppresses by
    // message CONTENT - a message carrying a frame number differs every frame, so
    // nothing is ever suppressed and the log gets one line per frame.
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    if (now - m_lastFrameReportMs >= 1000)
    {
        const qint64 elapsed = m_lastFrameReportMs == 0 ? 0 : (now - m_lastFrameReportMs);
        m_lastFrameReportMs = now;
        m_staleFrames += m_view.takeStaleCount();
        const GraphicsSharedFrame shared = m_sharedFrame ? m_sharedFrame->read()
                                                         : GraphicsSharedFrame();
        // The paint count is reported because the window paces ITSELF now, and "how often
        // is it actually repainting" is the only way to tell whether that pacing is the
        // display's or a busy loop's. It is not decoration: a preview window that
        // repainted 139 times a second while the display runs at 60 was found by exactly
        // this number.
        GraphicsLog::info(shared.valid()
                              ? QStringLiteral("window: showing shared frame %1 (texture %2, "
                                               "%3x%4); %5 stale, %6 paints in %7ms")
                                    .arg(shared.frameIndex)
                                    .arg(shared.texture)
                                    .arg(shared.size.width())
                                    .arg(shared.size.height())
                                    .arg(m_staleFrames)
                                    .arg(m_paintCount)
                                    .arg(elapsed)
                              : QStringLiteral("window: no frame published yet (%1 paints in %2ms)")
                                    .arg(m_paintCount)
                                    .arg(elapsed));
        m_staleFrames = 0;
        m_paintCount = 0;
    }

    // Ask for the next frame. This is what keeps the window repainting, and it is why
    // nothing outside this window has to know the window's cadence.
    //
    // The previous arrangement was a 16ms QTimer in MainWindow, owned by the main
    // window and running at a rate it had no reason to know about. That is three
    // problems in one: a second clock (16ms is 62.5Hz, not any rate the user chose),
    // a hardcoded number in a class that does not render, and a piece of the graphics
    // feature living in MainWindow - the same "state that should exist once, existing
    // somewhere it does not belong" shape as the other incidents in
    // graphics-architecture-review.md.
    //
    // requestUpdate() rather than update(): it schedules the repaint for the next
    // frame in the platform's own cycle and coalesces repeats, so this is paced by the
    // display rather than by a timer's guess at it. A 60Hz screen gets 60 updates a
    // second and a 144Hz screen gets 144, with no setting to keep in sync and no
    // writer of that setting to get wrong.
    //
    // There is deliberately no frame-cap check here. The producer is what the user
    // capped, in graphics.ini; this window is a view of whatever the producer made,
    // and re-showing the same texture because the producer has not drawn a new one yet
    // is the correct behaviour rather than a waste - it is exactly the "no new frame,
    // show the old one" rule, and it costs one textured quad.
    requestUpdate();
}

// Where the output image goes on the window's surface, in device pixels with a
// top-left origin.
//
// 1:1 and centred. Never scaled, so a mismatch between the window's shape and the
// output's shape shows as margin rather than as distortion.
QRect GraphicsWindow::cropRect() const
{
    if (m_outputSize.isEmpty())
        return QRect();

    const qreal dpr = devicePixelRatio();
    const int surfaceW = qMax(1, int(width() * dpr));
    const int surfaceH = qMax(1, int(height() * dpr));

    // The visible part is at most the surface and at most the output itself.
    const int visibleW = qMin(surfaceW, m_outputSize.width());
    const int visibleH = qMin(surfaceH, m_outputSize.height());

    // Centred on the surface, so the window is a viewport onto the middle of the
    // output. A window larger than the output therefore leaves even margin on all
    // sides rather than pinning the image into a corner.
    return QRect((surfaceW - visibleW) / 2, (surfaceH - visibleH) / 2, visibleW, visibleH);
}

QScreen* GraphicsWindow::showOnNextScreen()
{
    const QList<QScreen*> screens = QGuiApplication::screens();
    if (screens.size() < 2)
    {
        GraphicsLog::info(QStringLiteral("window: only one screen, nothing to move to"));
        return nullptr;
    }

    const int current = qMax(0, screens.indexOf(screen()));
    QScreen* next = screens.at((current + 1) % screens.size());

    // Re-place the window explicitly. setScreen() alone only takes effect on the
    // next show, and while fullscreen the geometry has to be reset too or the
    // window keeps the old screen's bounds.
    const QRect geom = next->geometry();
    if (m_fullscreen)
    {
        leaveFullscreen();
        setScreen(next);
        setGeometry(geom);
        enterFullscreen(next);
    }
    else
    {
        setScreen(next);
        setGeometry(QRect(geom.x() + 40, geom.y() + 40, kDefaultWidth, kDefaultHeight));
    }

    GraphicsLog::info(QStringLiteral("window moved to screen: %1").arg(describeOutput()));
    return next;
}

bool GraphicsWindow::enterFullscreen(QScreen* target)
{
    QScreen* want = target ? target : screen();
    if (!want)
    {
        GraphicsLog::warn(QStringLiteral("window: no screen to go fullscreen on"));
        return false;
    }

    if (!m_fullscreen)
    {
        m_screenBeforeFullscreen = screen();
    }

    setScreen(want);
    // Some window managers keep the pre-fullscreen geometry unless it is set
    // explicitly first. Same precaution the main window takes.
    const QRect geom = want->geometry();
    setGeometry(geom.x(), geom.y(), geom.width(), geom.height());
    showFullScreen();

    m_fullscreen = true;
    GraphicsLog::info(QStringLiteral("window fullscreen on: %1").arg(describeOutput()));
    return m_fullscreen;
}

void GraphicsWindow::leaveFullscreen()
{
    if (!m_fullscreen)
        return;

    showNormal();
    m_fullscreen = false;

    // Put it back as a small, centred, fully on-screen window - always.
    //
    // The original report was "the menu bar is gone and the window cannot be
    // moved, so the Graphics menu is the only way to close it". The cause was
    // neither: the window was coming back *off-screen* at negative coordinates
    // (-13,-58), so its whole frame - and therefore its title bar and close
    // button - sat outside the visible area. Nothing was missing; it was simply
    // out of reach, and with no visible title bar there was nothing to drag.
    //
    // Why it landed there: enterFullscreen() stretches the window to the screen
    // before showFullScreen(), so showNormal()'s notion of "normal" is that
    // screen-sized rect - measured at 1280x784, the full available screen. No
    // windowed geometry had ever been recorded, so there was nothing to restore.
    //
    // Fix: never restore. Always assign a small centred rect, clamped to the
    // screen's availableGeometry. No saved state means no ambiguous "restore to
    // what" to get wrong, and the frame is guaranteed to be reachable.
    QScreen* back = m_screenBeforeFullscreen ? m_screenBeforeFullscreen : screen();
    if (back)
        setScreen(back);

    const QRect avail = back ? back->availableGeometry() : QRect(0, 0, kWindowedWidth, kWindowedHeight);
    // Clamp, so a small screen cannot leave part of the window off it.
    const int w = qMin(kWindowedWidth, avail.width());
    const int h = qMin(kWindowedHeight, avail.height());
    setGeometry(avail.x() + (avail.width() - w) / 2,
                avail.y() + (avail.height() - h) / 2,
                w, h);

    GraphicsLog::info(QStringLiteral("window left fullscreen, now: %1  geometry=%2x%3 at %4,%5")
                          .arg(describeOutput())
                          .arg(width())
                          .arg(height())
                          .arg(x())
                          .arg(y()));
}

QString GraphicsWindow::describeOutput() const
{
    QScreen* s = screen();
    if (!s)
        return QStringLiteral("(no screen)");

    return QStringLiteral("%1 %2x%3%4")
        .arg(s->name())
        .arg(s->geometry().width())
        .arg(s->geometry().height())
        .arg(m_fullscreen ? QStringLiteral(" fullscreen") : QStringLiteral(" windowed"));
}

void GraphicsWindow::keyPressEvent(QKeyEvent* e)
{
    // Fullscreen has no title bar and the menu bar belongs to the main window,
    // so the window has to be able to give itself back on its own.
    switch (e->key())
    {
    case Qt::Key_Escape:
        if (m_fullscreen)
        {
            leaveFullscreen();
            e->accept();
            return;
        }
        break;
    case Qt::Key_F11:
        if (m_fullscreen)
            leaveFullscreen();
        else
            enterFullscreen(nullptr);
        e->accept();
        return;
    case Qt::Key_F12:
        showOnNextScreen();
        e->accept();
        return;
    default:
        break;
    }
    QOpenGLWindow::keyPressEvent(e);
}

void GraphicsWindow::closeEvent(QCloseEvent* e)
{
    // Closing the window must un-tick the menu action that opened it. For a dock
    // widget Qt would report this; for an independent window it has to be said
    // out loud.
    GraphicsLog::info(QStringLiteral("window closed by user"));
    m_fullscreen = false;
    emit closedByUser();
    QOpenGLWindow::closeEvent(e);
}

} // namespace SonicPi
