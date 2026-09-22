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

#include <memory>

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
// Lifecycle: created and destroyed by MainWindow. Like any QWindow it must be
// used from the GUI thread only.
class GraphicsWindow : public QOpenGLWindow
{
    Q_OBJECT

public:
    // The size the window opens at when not fullscreen. Deliberately 16:9 and
    // modest; the composer resizes it.
    static constexpr int kDefaultWidth = 960;
    static constexpr int kDefaultHeight = 540;

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
    // Rebuild the framebuffer to match the surface. Called on resize and when
    // the surface moves to a screen with a different pixel density.
    void resizeTarget(int pixelWidth, int pixelHeight);

    std::unique_ptr<GraphicsRenderer> m_renderer;
    QSize m_targetSize;
    bool  m_glReady  = false;
    bool  m_fullscreen = false;
    // The screen fullscreen was entered on, so leaving can restore the window to
    // the screen it came from rather than the primary one.
    QScreen* m_screenBeforeFullscreen = nullptr;
};

} // namespace SonicPi
