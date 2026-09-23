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

#include <QImage>
#include <QOpenGLBuffer>
#include <QOpenGLFunctions>
#include <QOpenGLShaderProgram>
#include <QOpenGLVertexArrayObject>
#include <QSize>

#include "GraphicsSharedFrame.h"

#include <memory>

#include <atomic>

namespace SonicPi
{

// The whole consumer side of the handoff, in one place, so that a second consumer
// cannot drift from the first.
//
// The output window and the debug preview do exactly the same four things every frame:
// wait for the producer's fence, sample the shared texture, leave a fence of their own,
// and ask for the next frame. That is not a coincidence and it must not be duplicated -
// a copy would be a second implementation of the access rules, and the last time this
// feature had two implementations of one rule it took three attempts to find out.
//
// So the view owns the sampling and the handoff, and the window owns only what makes it
// a window: its surface, its size, and how it is placed. What the view deliberately does
// NOT own is the render target - the output resolution is the user's, in
// GraphicsSettings, and neither window decides it.
//
// `identity` is this consumer's fixed slot in the fence array. It is assigned, not
// discovered: several consumers read the same published texture, and what keeps them
// from interfering is only that each writes its own slot. See GraphicsTargetFence.
class GraphicsTextureView
{
public:
    explicit GraphicsTextureView(GraphicsConsumer::Id identity);
    ~GraphicsTextureView();

    // The slot the render thread publishes into. Not owned; must be the same object
    // handed to the render thread. Setting it after a frame has already been shown is
    // safe - the next frame simply comes from the new slot.
    void setSharedFrameSlot(GraphicsSharedFrameSlot* slot) { m_sharedFrame = slot; }

    // Build the display shader and its quad. Requires a current context. Idempotent.
    bool initialize();

    // Draw the published frame into the current viewport.
    //
    // Returns false when there is nothing to show yet, which leaves whatever the caller
    // painted underneath. The caller is responsible for clearing and for setting the
    // viewport - on purpose: this view knows nothing about window geometry.
    bool drawSharedFrame();

    // Whether to filter when sampling. Off (the default) is GL_NEAREST, which is right
    // for the output window because it shows a 1:1 crop and filtering would soften pixels
    // that are meant to be shown exactly as rendered. On is GL_LINEAR, for a view that
    // scales the frame down - a 1280x720 output shown whole in a 320x240 window needs
    // filtering or it aliases badly.
    void setSmoothScaling(bool on) { m_smoothScaling = on; }

    bool isReady() const { return m_ready; }
    // The size of the frame last shown, so a caller can report or crop by it.
    QSize lastFrameSize() const { return m_lastFrameSize; }
    // The frame index last shown, so a consumer can tell whether anything new has been
    // published and avoid repainting the same picture for nothing.
    quint64 lastFrameIndex() const { return m_lastFrameIndex; }
    int lastTargetIndex() const { return m_lastTargetIndex; }

    // How many frames had to repeat the previous picture because the producer's fence
    // had not signalled within the guard timeout, and resets the count.
    //
    // Counted here because this is where it happens, and taken by the caller because
    // this is a diagnostic rather than a behaviour. A non-zero count means the producer
    // has stopped drawing, which is a different problem from a slow consumer.
    quint64 takeStaleCount() { return m_staleFrames.exchange(0, std::memory_order_relaxed); }

private:
    bool blitTexture(GLuint texture);

    GraphicsConsumer::Id m_identity;
    GraphicsSharedFrameSlot* m_sharedFrame = nullptr;

    std::unique_ptr<QOpenGLShaderProgram>     m_program;
    std::unique_ptr<QOpenGLVertexArrayObject> m_vao;
    std::unique_ptr<QOpenGLBuffer>            m_vbo;
    bool m_ready = false;

    // The last texture that was drawn, so a frame whose fence has not signalled can
    // repeat the previous picture instead of leaving a flash of background. The caller
    // has already cleared, so "nothing" is a full-screen flash, which is worse than a
    // repeated frame.
    GLuint m_lastGoodTexture = 0;
    QSize   m_lastFrameSize;
    quint64 m_lastFrameIndex = 0;
    int     m_lastTargetIndex = -1;
    bool    m_smoothScaling = false;

    // Frames shown as a repeat of the previous one because the producer's fence had not
    // signalled. Taken by the caller, which is the only thing that reports it.
    std::atomic<quint64> m_staleFrames{0};
};

} // namespace SonicPi
