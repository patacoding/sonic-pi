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

#include <QOpenGLWindow>
#include <QSize>

#include "GraphicsRenderer.h"

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

    // Re-read the shader from disk. Called on the GUI thread, where this window's
    // context lives, so it can make that context current itself.
    bool reloadShaders();

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
    // Owns the shader program and the quad. Not a pointer: there is exactly one
    // for the window's whole life, and a pointer only added a null case.
    GraphicsRenderer m_renderer;
    bool m_shaderReady = false;
    bool m_fullscreen = false;
    // The screen fullscreen was entered on, so leaving can put the window back on
    // the screen it came from rather than the primary one. No geometry is saved:
    // leaving fullscreen always assigns a small centred rect instead.
    QScreen* m_screenBeforeFullscreen = nullptr;
};

} // namespace SonicPi
