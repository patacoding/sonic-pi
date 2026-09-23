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

#include <QOpenGLWindow>

namespace SonicPi
{

// The graphics debug window: the whole output picture, fitted into a small window, plus
// the render thread's numbers in the log.
//
// A separate window rather than a pane in the main window, on purpose. The graphics
// feature is an addition to this application, not part of it, and the evidence for that
// principle is in the architecture review: every time a piece of graphics state has been
// allowed to live in MainWindow it has drifted from the copy the render thread holds.
// Numbers about rendering belong beside the rendering, not in the log pane of a window
// that does not render.
//
// It is a real consumer, not a viewer: it waits on the same fences as the output window
// and leaves its own, so with this window open the producer's `consumer wait` figure
// covers both readers.
//
// WHERE THE NUMBERS GO: the log, not drawn into the picture.
//
// The first attempt drew them over the frame with GL and never appeared. That is a
// solvable problem, but it is not worth solving here: this window's job is to show the
// picture, and the numbers are already wanted somewhere they can be read, copied and kept
// - GraphicsLog, which the main window mirrors into its log pane and which is also written
// to graphics.log. So the picture stays clean and the numbers go where text belongs.
//
// Scale: the whole frame, fitted, never cropped. The window's shape is the user's
// business; the frame is shown complete, with the leftover margin black so it reads as
// letterboxing rather than as part of the picture.
class GraphicsPreviewWindow : public QOpenGLWindow
{
    Q_OBJECT

public:
    // Small by default. This is a debug view that sits beside the real output; a preview
    // that competes with it for screen space is the wrong default.
    static constexpr int kDefaultWidth = 320;
    static constexpr int kDefaultHeight = 240;

    explicit GraphicsPreviewWindow(QWindow* parent = nullptr);
    ~GraphicsPreviewWindow() override;

    // The render thread whose output and statistics this window shows. Not owned.
    void setRenderThread(GraphicsRenderThread* thread);

    // The slot the render thread publishes into. Not owned. Required: this window has no
    // fallback that draws the shader itself, because a second thing able to draw the
    // picture would be a second producer.
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
    // Where the whole frame goes inside this window's surface: fitted by aspect ratio,
    // centred, in device pixels with a bottom-left origin as GL wants. Never crops.
    QRect fittedRect(const QSize& frame, const QSize& surface) const;

    // Write the render thread's numbers to the log, at most a few times a second.
    void reportStats();

    GraphicsTextureView m_view{GraphicsConsumer::Preview};

    // Not owned. See setRenderThread().
    GraphicsRenderThread* m_renderThread = nullptr;

    // The frame index the last repaint was requested for, so the window asks for another
    // repaint only when the producer has actually published something new. Without it the
    // window repaints as fast as the event loop spins - measured at 139 paints a second
    // against a 60Hz producer, which is 79 wasted frames a second.
    quint64 m_lastRequestedFrame = 0;

    // Statistics reporting, timed by hand. Not GraphicsLog::throttled(), which suppresses
    // by message CONTENT - this message carries changing numbers, so nothing would ever
    // be suppressed.
    qint64  m_lastReportMs = 0;
    quint64 m_paintsSinceReport = 0;
    quint64 m_statsReportCount = 0;
};

} // namespace SonicPi
