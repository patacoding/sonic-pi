#version 330 core

// Sonic Pi - Graphics output
//
// The default fragment shader. Until the graphics feature renders a real scene,
// this draws a coordinate ramp rather than a flat colour: every pixel shows its
// own uv, so the mapping can be judged by eye, and an inverted or stretched axis
// is immediately obvious instead of looking like a plausible picture.
//
//   red   increases with u  (left  -> right)
//   green increases with v  (bottom -> top)
//
// The uv origin is bottom-left because that is OpenGL's, so this reads as a ramp
// from black at the bottom-left to yellow at the top-right.
//
// This file is free to change: the pipeline's self-test does not depend on it.
// GraphicsRenderer::verifyShaderOutput() draws its own pattern from anchors.frag
// instead, so editing this file cannot break the check and the check cannot
// constrain what this file draws.
//
// Edit this file and use Graphics -> Reload Shader (Ctrl+Shift+R) to see the
// change without restarting. A shader that fails to compile is reported in
// graphics.log and the previous one keeps drawing.

in vec2 v_uv;
layout(location = 0) out vec4 FragColor;

void main()
{
    FragColor = vec4(v_uv, 0.35, 1.0);
}
