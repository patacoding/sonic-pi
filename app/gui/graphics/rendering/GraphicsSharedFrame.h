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

// GLsync and the fence constants come from Qt's GL headers. The constants are not
// defined by QOpenGLExtraFunctions itself (only the entry points are), so the few
// that are needed are given here with their spec values rather than pulling in a
// platform GL header whose macros would fight Qt's.
#include <QOpenGLFunctions>

#ifndef GL_SYNC_GPU_COMMANDS_COMPLETE
#  define GL_SYNC_GPU_COMMANDS_COMPLETE 0x9117
#endif
#ifndef GL_SYNC_FLUSH_COMMANDS_BIT
#  define GL_SYNC_FLUSH_COMMANDS_BIT 0x00000001
#endif
#ifndef GL_ALREADY_SIGNALED
#  define GL_ALREADY_SIGNALED 0x911A
#endif
#ifndef GL_TIMEOUT_EXPIRED
#  define GL_TIMEOUT_EXPIRED 0x911B
#endif
#ifndef GL_CONDITION_SATISFIED
#  define GL_CONDITION_SATISFIED 0x911C
#endif
#ifndef GL_WAIT_FAILED
#  define GL_WAIT_FAILED 0x911D
#endif

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

    // The producer's completion fence for this frame, or nullptr if it did not place
    // one.
    //
    // A consumer MUST wait on this before sampling, which is the access protection
    // Spout describes. Without it a consumer can read a texture whose draw has been
    // issued but not completed, and gets an unfinished image - in practice, frames
    // alternating between the picture and a partial one, which reads as flicker.
    //
    // The fence belongs to the producer's context. Waiting on it from another context
    // in the same share group is the supported operation; the consumer must not
    // delete it, and the producer must not delete it while a consumer may still be
    // waiting.
    GLsync fence = nullptr;

    bool valid() const { return texture != 0 && !size.isEmpty(); }
};

// The published frame, written by the render thread and read by the window.
//
// Modelled on how Spout actually does this, which is worth stating because the
// first two attempts here got it wrong in the same way:
//
//   "The sender will replace the shared texture handle in shared memory every
//    frame. The receiver reads that handle from shared memory at its own frame rate
//    and copies the shared texture. There is texture access protection but no
//    synchronization. If the sender is faster, the receiver will simply miss frames.
//    If the receiver is faster it will read duplicate frames. Access protection
//    ensures that the texture can only be accessed by one process at a time."
//      - Spout maintainer, on SetFrameSync/WaitFrameSync
//
// Two things follow, and both were missing here:
//
//   * "One writer, one reader" is NOT sufficient protection. It rules out two
//     writers; it does not stop a reader sampling memory the writer currently owns.
//     That is what caused a flickering window: frames alternating between a finished
//     image and an unfinished one.
//
//   * What IS sufficient is an access barrier at the GPU level. A GL sync object
//     placed after the producer's draw and waited on by the consumer before it
//     samples. This is also what Chromium's GPU synchronisation design uses for the
//     same reason - it orders the two sides without blocking either CPU thread.
//
// So the slot carries a fence as well as the texture name. The consumer must wait
// for it; that wait is what makes "the last complete frame" actually complete.
//
// The atomic field ordering below is still needed, for the metadata itself.
class GraphicsSharedFrameSlot
{
public:
    void publish(GLuint texture, const QSize& size, quint64 frameIndex, GLsync fence)
    {
        m_size = size;
        m_frameIndex.store(frameIndex, std::memory_order_relaxed);
        m_fence.store(fence, std::memory_order_relaxed);
        // Release: everything above must be visible to a reader that observes this.
        m_texture.store(texture, std::memory_order_release);
    }

    // Clears the slot, so consumers stop displaying a texture that is about to be
    // destroyed. Called before a target is rebuilt or released.
    void clear()
    {
        m_fence.store(nullptr, std::memory_order_relaxed);
        m_texture.store(0, std::memory_order_release);
    }

    GraphicsSharedFrame read() const
    {
        GraphicsSharedFrame f;
        // Acquire: pairs with the release store above, so a non-zero texture implies
        // the rest of the struct is the matching data.
        f.texture = m_texture.load(std::memory_order_acquire);
        if (f.texture != 0)
        {
            f.size = m_size;
            f.frameIndex = m_frameIndex.load(std::memory_order_relaxed);
            f.fence = m_fence.load(std::memory_order_relaxed);
        }
        return f;
    }

private:
    std::atomic<GLuint>  m_texture{0};
    std::atomic<quint64> m_frameIndex{0};
    // The producer's completion fence for the published frame. Not atomic in the
    // lock-free sense - it is an opaque pointer only the GL context touches - but
    // published and read alongside the texture name so a consumer that sees a
    // texture also sees the matching fence.
    std::atomic<GLsync>  m_fence{nullptr};
    // Written before m_texture and only read when m_texture is non-zero, so it needs
    // no synchronisation of its own - the release/acquire pair on the texture name
    // orders it.
    QSize m_size;
};


} // namespace SonicPi
