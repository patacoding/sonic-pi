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

namespace SonicPi
{

// The per-frame values handed to the shader as uniforms.
//
// Header-only and dependency-free on purpose: the renderer consumes this and the
// render loop produces it, and neither should have to include the other.
//
// The names and meanings follow ShaderToy's, so a shader written for ShaderToy
// runs here without being rewritten - that compatibility is a stated design goal
// rather than a coincidence, and it is why the fields are named iTime, iTimeDelta
// and iResolution rather than something more house-style.
//
// Produced by whoever owns the loop, never read from a clock by the renderer.
// The renderer draws what it is told to draw; a renderer that consulted the
// clock itself would animate even when the caller wanted a still frame, and would
// make a frame impossible to reproduce.
struct GraphicsFrame
{
    // Seconds since the shader's clock started. The only value that has to be
    // continuous for animation to look right.
    //
    // Computed as "now minus the start instant", NOT by accumulating the time
    // between frames. Accumulating a small float delta is the classic ShaderToy
    // time-drift bug: at 60Hz each delta is about 0.0167, and a float32 loses
    // resolution as the total grows, so a long-running shader visibly stutters
    // after a while even though every individual delta was right.
    double timeSeconds = 0.0;

    // Wall time between this frame and the previous one, in seconds. Zero on the
    // first frame, because there is no previous frame to measure against and
    // inventing one would be a lie a shader could act on.
    double deltaSeconds = 0.0;

    // Frames drawn since the clock started, starting at 0 for the first frame.
    unsigned long long frameIndex = 0;

    // Size of the surface being drawn into, in device pixels. The size the shader
    // should use for aspect correction; the logical window size would be wrong on
    // a HiDPI display.
    QSize resolution;
};

} // namespace SonicPi
