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
    // Release the display objects while the context can still be made current.
    // Their destructors need it, and a window whose surface is already gone cannot
    // provide one - in that case they leak rather than crash, and Qt is tearing the
    // context down with the window anyway.
    if (m_displayReady && context() && context()->makeCurrent(this))
    {
        m_displayVbo.reset();
        m_displayVao.reset();
        m_displayProgram.reset();
        context()->doneCurrent();
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

// The display shader: show a texture, flipped vertically.
//
// The flip is not optional and not a preference. GL's texture origin is its
// bottom-left, so sampling with v increasing upward shows the renderer's
// framebuffer the same way up as it was drawn; the D3D interop path needs the
// opposite for the same reason. Which way round it goes is a property of the two
// coordinate systems, so it is pinned here once rather than left to each caller.
static const char* kDisplayVertexShader = R"(
#version 330 core
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
    // a_pos is already in clip space (-1..1); derive uv from it rather than
    // carrying a second attribute, since the quad is exactly the whole viewport.
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
)";

static const char* kDisplayFragmentShader = R"(
#version 330 core
uniform sampler2D u_texture;
in vec2 v_uv;
layout(location = 0) out vec4 FragColor;
void main() {
    FragColor = texture(u_texture, v_uv);
}
)";

bool GraphicsWindow::initDisplay()
{
    if (m_displayReady)
        return true;

    auto program = std::make_unique<QOpenGLShaderProgram>();
    if (!program->addShaderFromSourceCode(QOpenGLShader::Vertex, kDisplayVertexShader)
        || !program->addShaderFromSourceCode(QOpenGLShader::Fragment, kDisplayFragmentShader)
        || !program->link())
    {
        GraphicsLog::error(QStringLiteral("window: the display shader failed\n%1").arg(program->log()));
        return false;
    }

    m_displayVao = std::make_unique<QOpenGLVertexArrayObject>();
    if (!m_displayVao->create())
    {
        GraphicsLog::error(QStringLiteral("window: could not create a VAO for the display"));
        m_displayVao.reset();
        return false;
    }
    m_displayVao->bind();

    // A quad covering clip space, in the two triangles a core profile needs.
    static const float kQuad[] = {
        -1.0f, -1.0f,
         1.0f, -1.0f,
         1.0f,  1.0f,
        -1.0f, -1.0f,
         1.0f,  1.0f,
        -1.0f,  1.0f,
    };
    m_displayVbo = std::make_unique<QOpenGLBuffer>(QOpenGLBuffer::VertexBuffer);
    if (!m_displayVbo->create() || !m_displayVbo->bind())
    {
        GraphicsLog::error(QStringLiteral("window: could not create a VBO for the display"));
        m_displayVbo.reset();
        m_displayVao.reset();
        return false;
    }
    m_displayVbo->setUsagePattern(QOpenGLBuffer::StaticDraw);
    m_displayVbo->allocate(kQuad, int(sizeof(kQuad)));
    m_displayVao->release();
    m_displayVbo->release();

    m_displayProgram = std::move(program);
    m_displayReady = true;
    GraphicsLog::info(QStringLiteral("window: display shader ready (samples the shared texture)"));
    return true;
}

bool GraphicsWindow::drawSharedFrame(const QRect& destination)
{
    if (!m_sharedFrame || destination.isEmpty())
        return false;

    const GraphicsSharedFrame shared = m_sharedFrame->read();
    if (!shared.valid())
        return false;

    if (!initDisplay())
        return false;

    QOpenGLContext* ctx = context();
    QOpenGLFunctions* f = ctx ? ctx->functions() : nullptr;
    if (!f)
        return false;

    // Wait for the producer to finish this frame before sampling it.
    //
    // This is the access protection the design was missing, and its absence is what
    // made the window flicker: without it this code samples a texture whose draw has
    // been issued but not necessarily completed, so consecutive frames alternate
    // between a finished image and a partial one.
    //
    // glClientWaitSync rather than glFinish: it waits for one fence, not for the whole
    // pipeline, so it orders the two contexts without stalling everything. This is the
    // same mechanism Chromium's GPU synchronisation uses for shared textures. Spout
    // states the requirement plainly - "access protection ensures that the texture can
    // only be accessed by one process at a time" - and a fence is that protection
    // without a blocking CPU lock.
    //
    // Zero timeout: if the producer has not finished, showing the previous frame once
    // more is better than stalling the GUI thread. That is Spout's own policy for a
    // fast consumer - "it will read duplicate frames".
    if (shared.fence)
    {
        QOpenGLExtraFunctions* extra = ctx ? ctx->extraFunctions() : nullptr;
        if (extra)
        {
            const GLenum r = extra->glClientWaitSync(shared.fence,
                                                     GL_SYNC_FLUSH_COMMANDS_BIT, 0);
            if (r == GL_TIMEOUT_EXPIRED || r == GL_WAIT_FAILED)
                return false;   // keep showing what we had; try again next frame
        }
    }

    // The texture name belongs to the render thread's context. It is usable here
    // only because the two contexts are in one share group - see the share-group
    // logging in initializeGL, which exists to make a silent failure of that
    // visible.
    if (shared.texture != m_boundDisplayTexture)
    {
        m_boundDisplayTexture = shared.texture;
        GraphicsLog::info(QStringLiteral("window: displaying shared texture %1 (%2x%3)")
                              .arg(shared.texture)
                              .arg(shared.size.width())
                              .arg(shared.size.height()));
    }

    // Report the frame number being shown, once a second.
    //
    // This is the acceptance check for the whole handover: the render thread logs
    // its iFrame, and if the window is displaying that thread's output then the
    // numbers must describe the same sequence. Before sharing they were two
    // unrelated counters that both happened to advance, which is exactly the kind
    // of thing that looks fine and proves nothing.
    //
    // Throttled by hand rather than through GraphicsLog::throttled(). That helper
    // suppresses by message CONTENT, so a message carrying a frame number is
    // different every frame and nothing is ever suppressed - it flooded the log
    // with one line per frame the first time this ran. A time check is what this
    // needs, not a content check.
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    if (now - m_lastFrameReportMs >= 1000)
    {
        m_lastFrameReportMs = now;
        GraphicsLog::info(QStringLiteral("window: showing shared frame %1").arg(shared.frameIndex));
    }

    // Filtering is set per texture rather than per frame: these are state on the
    // texture object, and re-setting them every frame would be noise. GL_NEAREST
    // because the view is 1:1 - any filtering here would soften pixels that are
    // meant to be shown exactly as rendered. Set while the texture is bound.
    f->glActiveTexture(GL_TEXTURE0);
    f->glBindTexture(GL_TEXTURE_2D, shared.texture);
    f->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    f->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    f->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    f->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

    // No diagnostic readback here. Whether the picture is correct is judged by
    // looking at it - see docs/dev-discipline.md.
    m_displayProgram->bind();
    m_displayProgram->setUniformValue("u_texture", 0);
    m_displayVao->bind();
    m_displayVbo->bind();
    m_displayProgram->enableAttributeArray(0);
    m_displayProgram->setAttributeBuffer(0, GL_FLOAT, 0, 2, 2 * sizeof(float));
    f->glDrawArrays(GL_TRIANGLES, 0, 6);
    m_displayProgram->disableAttributeArray(0);
    m_displayVbo->release();
    m_displayVao->release();
    m_displayProgram->release();

    return true;
}

void GraphicsWindow::paintGL()
{
    QOpenGLFunctions* f = context() ? context()->functions() : nullptr;
    if (!f)
        return;

    // This window is a CONSUMER. It displays the frame the render thread produced
    // and never draws a shader of its own.
    //
    // The earlier "fall back to drawing it here" branch is deliberately gone. It
    // existed so the window would show something before the first frame arrived,
    // but a second thing that can draw the picture is a second producer: two
    // renderers, two clocks, and a uniform that has to be set in two places. A
    // consumer that cannot get a frame shows the background, which is honest and
    // cannot drift.
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
    // Done here because this is where the two conventions meet.
    f->glViewport(destination.x(),
                  surface.height() - (destination.y() + destination.height()),
                  destination.width(),
                  destination.height());

    drawSharedFrame(destination);

    // Report which frame is on screen, once a second.
    //
    // The acceptance check for the whole handover: the render thread logs its
    // iFrame, and if this window is showing that thread's output then the two must
    // describe one sequence. Before sharing they were two unrelated counters that
    // both happened to advance, which looks fine and proves nothing.
    //
    // Timed by hand rather than through GraphicsLog::throttled(), which suppresses
    // by message CONTENT - a message carrying a frame number differs every frame,
    // so nothing is ever suppressed and the log gets one line per frame.
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    if (now - m_lastFrameReportMs >= 1000)
    {
        m_lastFrameReportMs = now;
        const GraphicsSharedFrame shared = m_sharedFrame ? m_sharedFrame->read()
                                                         : GraphicsSharedFrame();
        GraphicsLog::info(shared.valid()
                              ? QStringLiteral("window: showing shared frame %1").arg(shared.frameIndex)
                              : QStringLiteral("window: no frame published yet"));
    }
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
