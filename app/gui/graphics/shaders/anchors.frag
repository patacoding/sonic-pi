#version 330 core

// Sonic Pi - Graphics output
//
// Quadrant test pattern. This is a self-test, not a picture: it exists so the
// offscreen pipeline can be proved to draw the right pixels in the right places,
// because "it ran without crashing" is not evidence that anything correct was
// rendered.
//
// The regions and their colours are a contract with
// GraphicsRenderer::verifyShaderOutput(), which reads these five points back and
// compares them channel by channel. Changing one without the other breaks the
// check - see the anchor table in GraphicsRenderer.cpp.
//
//   uv (0,0) bottom-left   red     (255,   0,   0)
//   uv (1,0) bottom-right  green   (  0, 255,   0)
//   uv (0,1) top-left      blue    (  0,   0, 255)
//   uv (1,1) top-right     yellow  (255, 255,   0)
//   centre                 white   (255, 255, 255)
//
// The uv origin is bottom-left because that is OpenGL's, which is why (0,0) is
// red rather than the more habitual top-left.
//
// Yellow is the odd one out: red + green. That is not an oversight. It makes the
// top-right corner the one point where both horizontal and vertical position are
// confirmed at once, so a pattern that is one axis out cannot pass by accident.
//
// An earlier version of this file built the colour arithmetically from the two
// quadrant selectors. That is compact but it hides its own mistakes: the
// expression was written one way and read as another, and the resulting
// mismatches looked like a channel or coordinate fault in the pipeline rather
// than a bug in four lines of shader. Four explicit branchless selects are too
// simple to misread.

in vec2 v_uv;
layout(location = 0) out vec4 FragColor;

// Branchless quadrant select: c0 when neither selector is set, c3 when both are.
vec3 pick(float sx, float sy, vec3 c0, vec3 c1, vec3 c2, vec3 c3)
{
    return mix(mix(c0, c1, sx), mix(c2, c3, sx), sy);
}

void main()
{
    const vec3 kRed    = vec3(1.0, 0.0, 0.0);
    const vec3 kGreen  = vec3(0.0, 1.0, 0.0);
    const vec3 kBlue   = vec3(0.0, 0.0, 1.0);
    const vec3 kYellow = vec3(1.0, 1.0, 0.0);

    // step() rather than a branch: uniform control flow, and no driver-dependent
    // behaviour.
    float sx = step(0.5, v_uv.x);
    float sy = step(0.5, v_uv.y);

    vec3 colour = pick(sx, sy, kRed, kGreen, kBlue, kYellow);

    // White centre patch. A region rather than a single pixel, so the anchor does
    // not depend on exactly which fragment the rasteriser lands on.
    float inCentre = step(0.4375, v_uv.x) * step(v_uv.x, 0.5625)
                   * step(0.4375, v_uv.y) * step(v_uv.y, 0.5625);
    colour = mix(colour, vec3(1.0), inCentre);

    FragColor = vec4(colour, 1.0);
}
