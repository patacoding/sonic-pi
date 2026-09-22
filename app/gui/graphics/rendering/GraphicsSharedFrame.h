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

#include <QSize>

#include <atomic>

namespace SonicPi
{

// The render thread's current frame, published for the output window to display.
//
// Pure data, header-only and dependency-free, like GraphicsFrame: the render
// thread produces it and the window consumes it, and neither needs to include the
// other.
//
// Ownership rule, which is what makes this safe without a mutex: the render thread
// is the ONLY writer, and the window only reads. There is no frame exchange and no
// double buffering - the window shows whichever frame is current and repeats it if
// it repaints faster than the renderer draws. That is what the design settled on,
// and it is why the renderer must finish its frame before publishing: the texture
// is not valid for reading while a frame is half-drawn into it.
//
// The window samples the texture directly rather than copying it, so the two
// contexts must be in the same share group. That is set up in main.cpp and the
// render thread; QOpenGLContext::globalShareContext() is what ties them together.
struct GraphicsSharedFrame
{
    // GL texture name of the renderer's colour attachment. 0 means "nothing to
    // show yet" - before the first frame, or after the target was rebuilt - and
    // consumers must treat it as such rather than binding texture 0.
    GLuint texture = 0;

    // Size of that texture, in pixels. Read together with the texture name so a
    // display can tell whether what it is about to sample matches what it sized
    // its own state for.
    QSize size;

    // Frame counter from the renderer. Its only purpose here is to make the two
    // sides comparable: if the window displays this texture then whatever it shows
    // must correspond to this value, so a mismatch is visible evidence about which
    // producer drew the picture.
    quint64 frameIndex = 0;

    bool valid() const { return texture != 0 && !size.isEmpty(); }
};

// The published frame, written by the render thread and read by the window.
//
// Fields are separate atomics rather than one struct behind a mutex, because the
// reader must never be able to stall a frame and every field is individually
// meaningful. The name doubles as the validity flag, so it is published LAST with
// release ordering: a reader that sees a non-zero texture is guaranteed to see the
// matching size and frame index that were written before it.
class GraphicsSharedFrameSlot
{
public:
    void publish(GLuint texture, const QSize& size, quint64 frameIndex)
    {
        m_size = size;
        m_frameIndex.store(frameIndex, std::memory_order_relaxed);
        // Release: everything above must be visible to a reader that observes this.
        m_texture.store(texture, std::memory_order_release);
    }

    // Clears the slot, so consumers stop displaying a texture that is about to be
    // destroyed. Called before the target is rebuilt.
    void clear()
    {
        m_texture.store(0, std::memory_order_release);
    }

    GraphicsSharedFrame read() const
    {
        GraphicsSharedFrame f;
        // Acquire: pairs with the release store above, so a non-zero texture
        // implies the rest of the struct is the matching data.
        f.texture = m_texture.load(std::memory_order_acquire);
        if (f.texture != 0)
        {
            f.size = m_size;
            f.frameIndex = m_frameIndex.load(std::memory_order_relaxed);
        }
        return f;
    }

private:
    std::atomic<GLuint>  m_texture{0};
    std::atomic<quint64> m_frameIndex{0};
    // Written before m_texture and only read when m_texture is non-zero, so it
    // needs no synchronisation of its own - the release/acquire pair on the
    // texture name is what orders it.
    QSize m_size;
};

} // namespace SonicPi
