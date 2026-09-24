// Sonic Pi - Graphics: noise helpers, for `#include`.
//
// HOW TO USE
//
//     #version 330 core
//     #include "lib/noise.frag"
//
// The name is resolved like every other shader file: YOUR copy under
// <home>/.sonic-pi/graphics/shaders first, this one second. So this library works with nothing
// installed - and if you want to change it, save a copy in your own shader directory and edit that. The
// copy wins. Nothing here is read-only.
//
// WHERE THE INCLUDE GOES
//
// Below `#version`, because GLSL requires that directive to be the first thing in a shader. An include
// above it is refused with an explanation. An included file must not carry a `#version` of its own.
// Included once however many times it is named.
//
// NAMES
//
// `valueNoise`, deliberately NOT `noise2`. GLSL's early built-ins noise1..noise4 were removed in 330
// core, but this driver still declares them: a function called `noise2` with a different return type is
// an "overloaded functions must have the same return type" error, measured on this machine. Keep
// library function names prefixed, and prefer one that says what it does.
//
// WHAT IT COSTS
//
// An include brings in the whole file, so a broken function anywhere in here fails the shader that
// included it, even if nothing calls it. Libraries are therefore split by topic rather than piled into
// one file: include only what the shader uses.

// A stable pseudo-random number in [0,1) from a 2D point. Not random at all, which is the point: the
// same input always gives the same output, so a pattern built from it holds still instead of crawling.
float hash21(vec2 p)
{
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Smooth value noise: hash at the four corners of the cell the point falls in, then interpolate with a
// smoothstep curve so the cells meet without visible seams.
float valueNoise(vec2 p)
{
    vec2 i = floor(p);
    vec2 f = fract(p);

    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));

    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Fractal noise: several octaves of value noise, each at twice the frequency and half the amplitude,
// normalised so the result stays in [0,1] whatever the octave count.
//
// The loop bound is a constant and the octave count is an int, because GLSL wants a constant expression
// there - `fbm(p, 5)` then costs exactly what five octaves cost.
float fbm(vec2 p, int octaves)
{
    const int kMaxOctaves = 8;

    float sum = 0.0;
    float total = 0.0;
    float amplitude = 0.5;

    for (int i = 0; i < kMaxOctaves; ++i)
    {
        if (i >= octaves)
            break;

        sum += amplitude * valueNoise(p);
        total += amplitude;
        p *= 2.0;
        amplitude *= 0.5;
    }

    return total > 0.0 ? sum / total : 0.0;
}
