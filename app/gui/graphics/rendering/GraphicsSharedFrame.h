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

// Two render targets, one fence per reader per target, and that is the whole handoff.
//
// The rule is one sentence: the producer writes whichever target no consumer is
// reading, and before it writes it waits for every consumer to have finished with that
// target last time. The wait is expressed as a GL fence a consumer leaves behind, never
// as a flag, and that distinction is the entire reason this design works:
//
//   GL is ASYNCHRONOUS. When a consumer returns from its draw call, the commands have
//   been SUBMITTED, not executed. A flag cleared there means "the CPU stopped talking
//   about this texture", not "the GPU stopped reading it". A producer that trusts such a
//   flag clears the texture and starts drawing into it while the reads are still queued
//   ahead of it, and the screen shows a picture alternating between old and new
//   contents.
//
// A fence answers the question that actually matters - has the GPU finished reading this
// texture? - and the producer can afford to BLOCK on it, because by the time a target
// comes round for reuse the fence on it was placed a whole frame earlier. The wait is
// therefore near-zero in practice, and it is measured (see the `consumer wait` field in
// GraphicsRenderThread's per-second line) rather than assumed.
//
// This replaces a version that used an "is the consumer reading?" flag plus a
// non-blocking skip. It was more code and it was wrong: the flag could not be true when
// it needed to be, so the producer never skipped and never waited, and nothing noticed.

// Who is reading. Identity, not registration.
//
// The set of consumers is known at build time, so an enum is enough and a runtime
// registry would be one more piece of state to keep in sync. Nothing in the mechanism
// depends on these particular values - the producer iterates Count slots and a consumer
// indexes its own - so this is a SIZING choice, not a limit the design imposes.
//
// Count = 3 is a practical sizing, not a technical ceiling:
//
//   1. the on-screen output window
//   2. the Spout sender, when it exists
//   3. a future preview / debug window
//
// Raising it costs an array of atomic pointers per target (a few dozen bytes each) and
// nothing else: no extra buffer, no extra render, no extra blit. Raising it above the
// number of consumers actually reading is equally harmless - a slot that is never
// written stays null and is skipped by the producer's loop.
//
// Note this is the number of READERS, not of targets. All consumers share the same
// published texture, so adding a consumer costs one more fence slot and nothing else.
namespace GraphicsConsumer
{
enum Id
{
    OutputWindow = 0,   // the on-screen output window
    Spout        = 1,   // the Spout sender, when it exists
    Preview      = 2,   // a future preview window
    Count        = 3,   // sizing, not a limit - see above
};
} // namespace GraphicsConsumer

// Every reader's fence for one render target.
//
// One slot per consumer, not one per target. The reason is the whole answer to "why is
// multi-consumer not complicated":
//
//   Reading is NON-DESTRUCTIVE. N consumers reading one texture do not interfere with
//   each other and do not need to know each other exists. So they all share the single
//   published texture - there is no per-consumer buffer, no reference count, and no
//   arbitration between readers.
//
//   What still has to be true is that the producer does not overwrite a texture while
//   anyone is reading it. That is the ONLY thing multiple consumers change: the producer
//   waits for all of them instead of one. Which is the same loop, run N times.
//
// The cost is therefore microscopic and does not grow with the work being done: by the
// time a target comes round for reuse, every fence on it was placed a whole frame
// earlier and has already signalled. Measured at one consumer the wait averages 8-13us
// against a 16.7ms frame budget, so three consumers cost roughly 40us - three immediate
// returns, not three waits. And if one consumer really is slow, the producer waits for
// THAT one; the other two checks stay instant.
//
// Each consumer writes only its own slot, so the slots cannot interfere. Using the wrong
// one is impossible because the index is that consumer's identity, not a turn-taking
// token.
struct GraphicsTargetFence
{
    // The consumer's fence covering its most recent read of this target. Null when that
    // consumer has not read it yet, which is the normal state for the first use.
    //
    // Written only by that consumer, waited on and deleted only by the producer. Both
    // operations happen at moments the two sides cannot overlap: the producer only
    // deletes after it has taken the handle and the fence has signalled, and a consumer
    // only ever replaces its own slot with a fence it has itself just created.
    std::atomic<GLsync> consumerFence[GraphicsConsumer::Count];
};

// One frame as published by the render thread, for a consumer to display.
//
// Pure data, header-only and dependency-free, like GraphicsFrame: the render thread
// produces it and the window consumes it, and neither needs to include the other.
struct GraphicsSharedFrame
{
    // GL texture name of the renderer's colour attachment. 0 means "nothing to
    // show yet" - before the first frame, or after the target was rebuilt - and
    // consumers must treat it as such rather than binding texture 0.
    GLuint texture = 0;

    // Which of the producer's targets this is. The consumer needs it to find the
    // fence it must leave behind after reading.
    int targetIndex = -1;

    // Size of that texture, in pixels. Read together with the texture name so a
    // display can tell whether what it is about to sample matches what it sized
    // its own state for.
    QSize size;

    // Frame counter from the renderer. Its only purpose here is to make the two
    // sides comparable: if the window displays this texture then whatever it shows
    // must correspond to this value, so a mismatch is visible evidence about which
    // producer drew the picture.
    quint64 frameIndex = 0;

    // The producer's completion fence for this frame. The consumer MUST wait on this
    // before sampling, or it reads a half-drawn image.
    GLsync fence = nullptr;

    bool valid() const { return texture != 0 && !size.isEmpty(); }
};

// The published frame, written by the render thread and read by the window.
//
// Modelled on how Spout describes its own handoff, which is worth quoting because the
// first attempts here got it wrong in the same way:
//
//   "The sender will replace the shared texture handle in shared memory every frame.
//    The receiver reads that handle from shared memory at its own frame rate and
//    copies the shared texture. There is texture access protection but no
//    synchronization. If the sender is faster, the receiver will simply miss frames.
//    If the receiver is faster it will read duplicate frames. Access protection
//    ensures that the texture can only be accessed by one process at a time."
//      - Spout maintainer, on SetFrameSync/WaitFrameSync
//
// Spout's "access protection" is exactly the per-target fence kept here. What this
// design adds over Spout's is that the producer waits for it rather than overwriting
// regardless, because a Sonic Pi shader output that tears is a visible defect whereas
// a dropped frame is not.
class GraphicsSharedFrameSlot
{
public:
    // How many targets the render thread may publish. The fences are fixed size so
    // that a consumer can index them without allocating anything.
    static constexpr int kMaxTargets = 4;

    void publish(GLuint texture, const QSize& size, quint64 frameIndex, GLsync fence,
                 int targetIndex)
    {
        m_size = size;
        m_frameIndex.store(frameIndex, std::memory_order_relaxed);
        m_fence.store(fence, std::memory_order_relaxed);
        m_targetIndex.store(targetIndex, std::memory_order_relaxed);
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
            f.targetIndex = m_targetIndex.load(std::memory_order_relaxed);
        }
        return f;
    }

    // The fences for one target. Both sides use this; there is no other way to reach
    // a target's fences, so there is nowhere for a second copy of that state to drift.
    GraphicsTargetFence& targetFence(int targetIndex)
    {
        return m_fences[clampIndex(targetIndex)];
    }

private:
    static int clampIndex(int i)
    {
        return (i >= 0 && i < kMaxTargets) ? i : 0;
    }

    std::atomic<GLuint>  m_texture{0};
    std::atomic<quint64> m_frameIndex{0};
    std::atomic<int>     m_targetIndex{-1};
    std::atomic<GLsync>  m_fence{nullptr};
    // Written before m_texture and only read when m_texture is non-zero, so it needs
    // no synchronisation of its own - the release/acquire pair on the texture name
    // orders it.
    QSize m_size;
    // One per target, never reallocated, so a consumer can hold a reference to one
    // across a call without worrying about it moving.
    GraphicsTargetFence m_fences[kMaxTargets];
};


} // namespace SonicPi
