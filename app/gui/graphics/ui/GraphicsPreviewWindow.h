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

#include "GraphicsRenderThread.h"
#include "GraphicsSharedFrame.h"
#include "GraphicsTextureView.h"

#include <QImage>
#include <QOpenGLWindow>
#include <QString>

namespace SonicPi
{

// The graphics debug window: the whole output picture, fitted into a small window, with the
// live frame rate drawn in its top-left corner.
//
// A separate window rather than a pane in the main window, on purpose. The graphics feature
// is an addition to this application, not part of it, and the evidence for that principle is
// in the architecture review: every time a piece of graphics state has been allowed to live
// in MainWindow it has drifted from the copy the render thread holds.
//
// It is a real consumer, not a viewer: it waits on the same fences as the output window and
// leaves its own, so with this window open the producer's `consumer wait` figure covers both
// readers.
//
// WHERE THE FRAME RATE IS SHOWN, AND WHY IT MOVED
//
// It is drawn in this window, not written to the log. That is a reversal, and the reasoning
// behind it is worth keeping:
//
//   * The rate is something the user WATCHES. A number in a log file is read after the fact;
//     a number in the corner of the preview is seen while working.
//   * Logging it once a second made the log mostly this one figure, and the detail lines from
//     the two windows made up the rest. The log became harder to read than the thing it was
//     reporting on, which defeats the point of a log.
//   * A shortfall is therefore shown by COLOUR here - green at or above the target, amber
//     below it - so "am I getting what I asked for" is answerable at a glance, without a
//     warning appearing in a file nobody is watching.
//
// The comparison is the render thread's, not this window's: it measures both numbers and
// publishes belowTarget (see GraphicsFrameStats), and this only chooses a colour from it, so
// the two cannot disagree about whether the target is being met.
//
// This window logs its INITIALISATION and its SIZE CHANGES and nothing else. A size change is
// worth an entry because it changes what is on screen and is the first thing worth knowing
// when something looks wrong; the frame rate is not, because it is already on screen.
class GraphicsPreviewWindow : public QOpenGLWindow
{
    Q_OBJECT

public:
    // Small by default. This is a debug view that sits beside the real output; a preview that
    // competes with it for screen space is the wrong default.
    static constexpr int kDefaultWidth = 320;
    static constexpr int kDefaultHeight = 240;

    explicit GraphicsPreviewWindow(QWindow* parent = nullptr);
    ~GraphicsPreviewWindow() override;

    // The render thread whose output and statistics this window shows. Not owned.
    void setRenderThread(GraphicsRenderThread* thread);

    // The slot the render thread publishes into. Not owned. Required: this window has no
    // fallback that draws the shader itself, because a second thing able to draw the picture
    // would be a second producer.
    void setSharedFrameSlot(GraphicsSharedFrameSlot* slot) { m_view.setSharedFrameSlot(slot); }

signals:
    void closedByUser();

protected:
    void initializeGL() override;
    void paintGL() override;
    void resizeGL(int w, int h) override;
    void keyPressEvent(QKeyEvent* e) override;
    void closeEvent(QCloseEvent* e) override;

private:
    // Rebuild the fps overlay from the render thread's figures, at most a few times a second
    // and only when the text actually changes.
    void refreshFpsOverlay();

    // Placement is fittedFrameRect() in GraphicsTextureView.h, shared with the output window:
    // leaving the picture whole is a rule about the display side rather than about either
    // window, so it is not implemented twice.

    GraphicsTextureView m_view{GraphicsConsumer::Preview};

    // Not owned. See setRenderThread().
    GraphicsRenderThread* m_renderThread = nullptr;

    // Overlay state. The last text is kept so an unchanged figure costs a string comparison
    // instead of a painter pass and a texture upload.
    qint64  m_lastOverlayMs = 0;
    QString m_lastFpsText;
};

} // namespace SonicPi
