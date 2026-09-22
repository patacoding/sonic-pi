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

#include <QCloseEvent>
#include <QGuiApplication>
#include <QKeyEvent>
#include <QOpenGLContext>
#include <QOpenGLFunctions>
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
    // The renderer holds GL objects, which need a current context to be
    // destroyed. makeCurrent() on a window whose surface is already gone can
    // fail, in which case they are leaked rather than crashing - Qt is tearing
    // the context down with the window anyway.
    if (m_shaderReady && context())
    {
        if (context()->makeCurrent(this))
        {
            m_renderer.destroy();
            context()->doneCurrent();
        }
    }
}

void GraphicsWindow::setRenderThread(GraphicsRenderThread* thread)
{
    // Stored, not used to set a size: the window does not decide the output
    // resolution. It is kept so the window can report which render target it is
    // displaying, and so step 1.2 can read the shared texture from it.
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

    // The render target size is the user's configured output resolution, decided
    // by the render thread from settings. Captured here so the log shows both
    // numbers side by side, and so cropRect() has the size without reaching across
    // to the render thread on every frame: this window is a crop of that target,
    // and a mismatch between the two is what explains a window that looks clipped.
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

    // No framebuffer: this renderer draws straight to the window's surface. See
    // the class comment for why there is deliberately no intermediate target.
    if (!m_renderer.initializeWithoutFramebuffer())
    {
        GraphicsLog::error(QStringLiteral("window: could not load the shader"));
        return;
    }

    m_shaderReady = true;
    GraphicsLog::info(QStringLiteral("window: shader loaded, drawing to surface\n"
                                     "  fragment : %1")
                          .arg(m_renderer.fragmentShaderPath()));
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

    if (!m_shaderReady)
    {
        // No usable shader: a flat clear is more useful than a stale or undefined
        // surface, and it makes "the shader never loaded" visibly different from
        // "the shader draws black".
        f->glClearColor(GraphicsRenderer::kClearR,
                        GraphicsRenderer::kClearG,
                        GraphicsRenderer::kClearB,
                        GraphicsRenderer::kClearA);
        f->glClear(GL_COLOR_BUFFER_BIT);
        return;
    }

    // QOpenGLWindow::paintGL's contract is that the context and the framebuffer
    // are bound and the viewport is set before this is called, so the default
    // framebuffer is already current here. renderToBoundFramebuffer sets the
    // viewport itself, because the window shows only part of the output.
    //
    // Deliberately NO readback on this path. Reading the framebuffer back to the
    // CPU stalls on the GPU; an earlier revision did it every frame and held the
    // rate at ~50Hz instead of 60 with a 3.2 MB log.

    // The window's own shader clock.
    //
    // Anchored to the first painted frame and read as a difference, never
    // accumulated - see GraphicsFrame::timeSeconds for why that matters.
    //
    // The window keeps its own clock rather than sharing the render thread's
    // because the two draw from different contexts: this one draws to the window's
    // surface, the thread draws to an offscreen target. When the shared-texture
    // step makes the window display the thread's target instead of drawing for
    // itself, this clock goes away along with the renderer that uses it.
    if (!m_clockStarted)
    {
        m_clock.start();
        m_sinceLastPaint.start();
        m_clockStarted = true;
    }

    // The window shows a 1:1 crop of the fixed output resolution, centred, with no
    // scaling and no aspect correction.
    //
    // No scaling is the point: the output is authored at a set resolution, and
    // seeing it stretched to whatever shape the window happens to be would make it
    // impossible to judge what an external consumer receives. Cropping means a
    // window smaller than the output reveals less of the image rather than
    // shrinking it, and a window larger than the output shows the whole thing with
    // margin around it.
    //
    // The rectangle comes from a helper rather than being computed inline, because
    // the shared-texture step needs exactly the same rectangle to blit into.
    const QRect destination = cropRect();

    GraphicsFrame frame;
    frame.timeSeconds = double(m_clock.elapsed()) / 1000.0;
    frame.deltaSeconds = m_havePainted ? double(m_sinceLastPaint.elapsed()) / 1000.0 : 0.0;
    frame.frameIndex = m_frameIndex;
    frame.resolution = m_outputSize;

    m_renderer.renderToBoundFramebuffer(m_outputSize, destination, frame);

    m_sinceLastPaint.restart();
    m_havePainted = true;
    ++m_frameIndex;
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

bool GraphicsWindow::reloadShaders()
{
    if (!m_shaderReady)
    {
        // initializeGL() failed to load a shader, which is exactly when a reload
        // is worth trying - the fix may be an edit to the file. Attempt the load
        // now that a context exists.
        if (!context() || !context()->isValid())
        {
            GraphicsLog::error(QStringLiteral("window: reload with no valid context"));
            return false;
        }
        if (!context()->makeCurrent(this))
        {
            GraphicsLog::error(QStringLiteral("window: could not make its context current to reload"));
            return false;
        }
        m_shaderReady = m_renderer.initializeWithoutFramebuffer();
        context()->doneCurrent();
        if (m_shaderReady)
            update();
        return m_shaderReady;
    }

    if (!context() || !context()->isValid())
    {
        GraphicsLog::error(QStringLiteral("window: reload with no valid context"));
        return false;
    }
    if (!context()->makeCurrent(this))
    {
        GraphicsLog::error(QStringLiteral("window: could not make its context current to reload"));
        return false;
    }

    const bool ok = m_renderer.reloadShaders();
    context()->doneCurrent();

    if (ok)
        update();

    return ok;
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
