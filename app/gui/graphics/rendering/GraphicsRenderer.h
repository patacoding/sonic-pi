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

#include <QOpenGLFunctions>
// Included rather than forward-declared: the member below is a unique_ptr to it,
// and any translation unit that destroys a GraphicsRenderer needs the complete
// type to instantiate the deleter.
#include <QOpenGLFramebufferObject>
#include <QSize>

#include <memory>

namespace SonicPi
{

// Draws into an offscreen framebuffer. Owned by, and only ever touched from,
// the graphics render thread.
//
// Phase 0 is deliberately narrow: prove that a frame can be rendered and that
// its pixels come back as expected. There is no window and no shader yet.
//
// The readback check exists because offscreen rendering has nothing to look at.
// "It ran without crashing" is not evidence that anything correct was drawn, so
// every step here verifies the pixels rather than the absence of errors - a
// check the original design document did not specify.
class GraphicsRenderer
{
public:
    GraphicsRenderer() = default;
    // Defined in the .cpp: QOpenGLFramebufferObject is only forward-declared
    // here, and unique_ptr's deleter needs the complete type.
    ~GraphicsRenderer();

    GraphicsRenderer(const GraphicsRenderer&) = delete;
    GraphicsRenderer& operator=(const GraphicsRenderer&) = delete;

    // Creates the framebuffer. Requires a current context. Returns false and
    // logs why on failure.
    bool initialize(const QSize& size);

    // Clears the framebuffer to a known colour, reads it back, and reports
    // whether the GPU produced what was asked for.
    bool verifyClearColour();

    // Reads the whole framebuffer back as RGBA8. Returns false on failure.
    //
    // Note: OpenGL's origin is bottom-left, so row 0 of the returned data is the
    // *bottom* row of the image. Nothing here depends on that yet - the check in
    // verifyClearColour uses a uniform colour - but anything comparing a pattern
    // to screen coordinates in a later step must account for it.
    bool readPixels(QSize* sizeOut, std::unique_ptr<unsigned char[]>* pixelsOut);

    QSize size() const { return m_size; }

    // The colour the framebuffer is cleared to. Kept as a named constant so the
    // verification and the clear cannot drift apart.
    static constexpr float kClearR = 0.25f;
    static constexpr float kClearG = 0.50f;
    static constexpr float kClearB = 0.75f;
    static constexpr float kClearA = 1.0f;

private:
    bool colourMatches(const unsigned char* rgba) const;

    std::unique_ptr<QOpenGLFramebufferObject> m_fbo;
    QSize m_size;
};

} // namespace SonicPi
