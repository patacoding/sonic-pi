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
    // Nothing to rebuild - the shader covers whatever the surface is - but the
    // window must be repainted at the new size. Qt does send an expose event on
    // resize, so this is belt and braces rather than the only trigger.
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
    // framebuffer is already current here. The viewport is still passed
    // explicitly: renderToBoundFramebuffer sets it from the device-pixel size,
    // which is what keeps the output sharp on a HiDPI screen.
    //
    // Deliberately NO readback on this path. Reading the framebuffer back to the
    // CPU stalls on the GPU; an earlier revision did it every frame and held the
    // rate at ~50Hz instead of 60 with a 3.2 MB log.
    const qreal dpr = devicePixelRatio();
    const QSize pixelSize(qMax(1, int(width() * dpr)), qMax(1, int(height() * dpr)));

    // The window's own shader clock.
    //
    // Anchored to the first painted frame and read as a difference, never
    // accumulated - see GraphicsFrame::timeSeconds for why that matters.
    //
    // The window keeps its own clock rather than sharing the render thread's
    // because the two draw different things from different contexts: this one
    // draws to the window's surface, the thread draws to an offscreen target.
    // When step 1.2 makes the window display the thread's texture instead of
    // drawing for itself, this clock goes away with the renderer that uses it.
    if (!m_clockStarted)
    {
        m_clock.start();
        m_sinceLastPaint.start();
        m_clockStarted = true;
    }

    GraphicsFrame frame;
    frame.timeSeconds = double(m_clock.elapsed()) / 1000.0;
    frame.deltaSeconds = m_havePainted ? double(m_sinceLastPaint.elapsed()) / 1000.0 : 0.0;
    frame.frameIndex = m_frameIndex;
    frame.resolution = pixelSize;

    m_renderer.renderToBoundFramebuffer(pixelSize, frame);

    m_sinceLastPaint.restart();
    m_havePainted = true;
    ++m_frameIndex;
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
