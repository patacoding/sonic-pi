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

#pragma once

#include <QElapsedTimer>
#include <QOpenGLBuffer>
#include <QOpenGLShaderProgram>
#include <QOpenGLVertexArrayObject>
#include <QOpenGLWindow>
#include <QSize>

#include "GraphicsRenderer.h"
#include "GraphicsRenderThread.h"
#include "GraphicsSharedFrame.h"
#include "GraphicsTextureView.h"

#include <memory>

class QScreen;

namespace SonicPi
{

// The window the graphics output is shown in.
//
// A QOpenGLWindow rather than a widget: the output is a plain fullscreen surface
// on whichever screen the performer points it at, with no widget layout, no menu
// bar and no Qt widget composition in the path. It is also the reason the main
// window is unaffected - a QOpenGLWidget inside the app window would push the
// whole window onto Qt's RHI composition path and cost a backing-store copy per
// frame, which the audio scope already avoids for exactly that reason.
//
// What it draws: the shader, straight to its own surface. There is deliberately
// no intermediate framebuffer here. An earlier revision allocated one and never
// drew to it, while paintGL() cleared the surface to a flat colour, so the window
// showed a solid blue rectangle no matter what the shader said - the shader was
// only ever running in the offscreen verification on the render thread, which
// nothing displayed. The window now owns the only renderer on the display path,
// so an edit plus Reload Shader is visible immediately.
//
// Drawing to the surface rather than to a framebuffer is the Phase 0 shape. When
// step 1.5/1.6 introduces a shared render target, the window's job changes to
// displaying a texture another context rendered into, and this class stops owning
// a renderer at all.
//
// Lifecycle: created and destroyed by MainWindow. Like any QWindow it must be
// used from the GUI thread only.
class GraphicsWindow : public QOpenGLWindow
{
    Q_OBJECT

public:
    // The size the window opens at when not fullscreen, and the size it is put
    // back to when leaving fullscreen. Deliberately small: leaving fullscreen
    // should hand back an obviously windowed, fully on-screen window rather than
    // anything derived from the fullscreen rect.
    static constexpr int kDefaultWidth = 960;
    static constexpr int kDefaultHeight = 540;
    static constexpr int kWindowedWidth = 480;
    static constexpr int kWindowedHeight = 320;

    explicit GraphicsWindow(QWindow* parent = nullptr);
    ~GraphicsWindow() override;

    // The render thread whose output this window shows a crop of.
    //
    // The window does NOT dictate the render target size - that is the user's
    // configured output resolution, and the window is a viewer of it. The handle is
    // held so the window can report which target it is displaying, and so step 1.2
    // can read the shared texture from it. Null is allowed.
    //
    // Not owned. Call before show().
    void setRenderThread(GraphicsRenderThread* thread);

    // The slot the render thread publishes its frames into. Not owned; must be the
    // same object handed to the render thread. When set, the window DISPLAYS that
    // texture instead of drawing a shader of its own - which is the whole point:
    // one renderer, one clock, one picture.
    //
    // Null is legal and falls back to the window drawing for itself, which is the
    // pre-sharing behaviour.
    void setSharedFrameSlot(GraphicsSharedFrameSlot* slot)
    {
        m_sharedFrame = slot;
        m_view.setSharedFrameSlot(slot);
    }

    // Move to the next screen in QGuiApplication::screens(), wrapping around.
    // Returns the screen it landed on, or nullptr if there is only one.
    QScreen* showOnNextScreen();

    // Put the window on `screen` and return whether it is now fullscreen there.
    bool enterFullscreen(QScreen* screen);
    // Leave fullscreen, returning to a normal window on the current screen.
    void leaveFullscreen();
    bool isFullscreen() const { return m_fullscreen; }

    // Human-readable description of where the output currently is, for the log
    // and for the status line.
    QString describeOutput() const;

    // There is no reloadShaders() here any more.
    //
    // This window displays the render thread's texture and owns no shader, so it had
    // nothing to reload. It was also the wrong thread to do it on: the shader being
    // reloaded belongs to the render thread's context. Reloading is requested through
    // GraphicsRenderThread::requestShaderReload() and applied by that thread.

    // There is no setFrameRate() here either, and no repaint timer.
    //
    // The window paces itself: paintGL() ends by calling requestUpdate(), so the
    // cadence is the platform's frame cycle. Nothing outside needs to know it and
    // nothing outside can get it wrong. See the note in paintGL() for what the
    // previous arrangement - a 16ms timer in MainWindow - cost.

signals:
    // Emitted when the user closes the window directly, so the menu action that
    // opened it can be un-ticked. A QDockWidget reports this to Qt for free; an
    // independent top-level window does not.
    void closedByUser();

protected:
    void initializeGL() override;
    void paintGL() override;
    void resizeGL(int w, int h) override;
    void keyPressEvent(QKeyEvent* e) override;
    void closeEvent(QCloseEvent* e) override;

private:
    // Where the whole frame goes on this window's surface, in device pixels with a top-left
    // origin.
    //
    // Fitted and centred, never cropped - the same rule the debug preview follows, and for the
    // same reason: the output resolution is a property of the OUTPUT, since that is what Spout
    // sends and Spout has no window at all. A window may not crop it or scale it to suit
    // itself, so a window smaller than the output shows a smaller whole picture.
    QRect fittedRect() const;

    // Tell the render thread what this window's screen can show, in Hz. Called whenever this
    // window's placement changes, because that is when the answer can change.
    void reportDisplayRefresh();

    // The sampling and the handoff, shared with every other consumer. See
    // GraphicsTextureView: this window owns only what makes it a window - its surface,
    // its size, and where it sits - while the view owns the display shader, the fence
    // protocol and the repeat-the-last-frame behaviour.
    //
    // Deliberately not a copy of that logic. There are now two consumers, and the one
    // lesson this feature has taught repeatedly is that a rule implemented twice drifts:
    // the last time a single rule had two implementations it took three attempts and a
    // visible flicker to find out.
    GraphicsTextureView m_view{GraphicsConsumer::OutputWindow};

    // Not owned. See setSharedFrameSlot().
    GraphicsSharedFrameSlot* m_sharedFrame = nullptr;
    // Time of the last "showing shared frame" report, so it appears once a second
    // instead of once a frame. See the note where it is used.
    qint64 m_lastFrameReportMs = 0;

    // Count of frames whose producer fence had not signalled within the guard timeout,
    // reported once a second.
    //
    // This exists because "the picture flickers" is not a measurement and neither is
    // "it looks smooth now". When the handoff is working this stays at zero: the
    // producer draws in a fraction of a millisecond, so a fence placed before the
    // previous repaint has always signalled by the next one. A non-zero count says the
    // producer has genuinely stalled, which is a different problem from a slow
    // consumer and should not be confused with it.
    quint64 m_staleFrames = 0;

    // Paints since the last report, so "how often is this window actually repainting" is
    // observable. The window paces itself with requestUpdate() now, and a self-paced loop
    // that runs faster than the display is indistinguishable from a correct one in every
    // other log line.
    quint64 m_paintCount = 0;

    // Not owned, and not used to set the output size. See setRenderThread().
    GraphicsRenderThread* m_renderThread = nullptr;
    // The resolution being shown, in pixels. Taken from the render thread so the crop
    // matches what was actually allocated rather than a second copy of the setting that
    // could disagree with it.
    QSize m_outputSize;
    bool m_fullscreen = false;

    // The screen fullscreen was entered on, so leaving can put the window back on
    // the screen it came from rather than the primary one. No geometry is saved:
    // leaving fullscreen always assigns a small centred rect instead.
    QScreen* m_screenBeforeFullscreen = nullptr;
};

} // namespace SonicPi
