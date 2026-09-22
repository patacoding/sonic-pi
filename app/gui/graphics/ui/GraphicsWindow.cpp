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
    // The renderer holds a framebuffer, which needs a current context to be
    // destroyed. makeCurrent() on a window whose surface is already gone can
    // fail, in which case the framebuffer is leaked rather than crashing - Qt is
    // tearing the context down with the window anyway.
    if (m_glReady && context())
    {
        if (context()->makeCurrent(this))
        {
            m_renderer.reset();
            context()->doneCurrent();
        }
    }
    m_renderer.reset();
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
    m_glReady = true;
}

void GraphicsWindow::resizeGL(int w, int h)
{
    // w/h are in logical pixels; the framebuffer follows device pixels so the
    // output stays sharp on a HiDPI screen.
    const qreal dpr = devicePixelRatio();
    const int pw = qMax(1, int(w * dpr));
    const int ph = qMax(1, int(h * dpr));
    resizeTarget(pw, ph);
}

void GraphicsWindow::resizeTarget(int pixelWidth, int pixelHeight)
{
    if (!m_glReady || !context())
        return;

    const QSize want(pixelWidth, pixelHeight);
    if (want == m_targetSize && m_renderer)
        return;

    if (!context()->makeCurrent(this))
    {
        GraphicsLog::warn(QStringLiteral("window: could not make context current to resize target"));
        return;
    }

    if (!m_renderer)
        m_renderer = std::make_unique<GraphicsRenderer>();

    if (m_renderer->initialize(want))
    {
        m_targetSize = want;
        GraphicsLog::info(QStringLiteral("window target size %1x%2 (device pixels)")
                              .arg(want.width())
                              .arg(want.height()));
    }
    else
    {
        GraphicsLog::error(QStringLiteral("window: could not create a %1x%2 target")
                               .arg(want.width())
                               .arg(want.height()));
    }

    context()->doneCurrent();
}

void GraphicsWindow::paintGL()
{
    QOpenGLFunctions* f = context() ? context()->functions() : nullptr;
    if (!f)
        return;

    // Phase 1.1 clears the surface to the colour Phase 0.2 verified. The shader
    // replaces this in Phase 0.3/2.
    //
    // Deliberately NO readback here. GraphicsRenderer::verifyClearColour() reads
    // the framebuffer back to the CPU, which stalls on the GPU. An earlier
    // revision called it every frame, which produced 7790 readbacks, a 3.2 MB
    // log over 154 seconds, and held the frame rate at ~50Hz instead of 60. It
    // is a one-shot verification tool for the render thread, not a frame loop
    // step.
    f->glClearColor(GraphicsRenderer::kClearR,
                    GraphicsRenderer::kClearG,
                    GraphicsRenderer::kClearB,
                    GraphicsRenderer::kClearA);
    f->glClear(GL_COLOR_BUFFER_BIT);
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
    // Not a restore of the previous geometry. enterFullscreen() stretches the
    // window to the screen before showFullScreen(), so showNormal()'s notion of
    // "normal" is a screen-sized rect. That is what produced a window as big as
    // the display with its title bar above the top edge, which reads as "the
    // window has lost its title bar". Saving and restoring the geometry is one
    // way around it; simply picking a windowed size is simpler and has no
    // ambiguous state to get wrong.
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
