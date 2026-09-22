#version 330 core

// Sonic Pi - Graphics output
//
// Full-screen quad. Position and texture coordinate are passed in as vertex
// attributes rather than derived from gl_VertexID.
//
// An earlier version used the vertex-ID fullscreen-triangle trick. It rendered
// something, which was exactly the problem: the UVs only spanned half the range,
// so every pixel sampled the same corner region and the verification anchors all
// read the same colour. Deriving coordinates saves a buffer but is easy to get
// subtly wrong, and a wrong derivation still draws a plausible-looking picture.
// Six explicit vertices cost nothing and cannot be mis-derived.
//
// Six vertices, two triangles. Position is in clip space (-1..1); v_uv is in
// 0..1 with (0,0) at the bottom-left, because that is where OpenGL's origin is.

layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_uv;

out vec2 v_uv;

void main()
{
    v_uv = a_uv;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
