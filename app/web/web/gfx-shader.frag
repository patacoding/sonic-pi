// The shader the graphics canvas draws. Edit this file and reload the page — it is fetched as
// `gfx-shader.frag`, so nothing needs rebuilding (if it is missing, gfx.js falls back to a copy
// of this one built into it).
//
// Shadertoy's shape: write `mainImage(out vec4 fragColor, in vec2 fragCoord)`. These are already
// declared for you, so declaring them again is not needed (and is skipped if you do):
//
//   iTime        float  seconds since the first frame
//   iTimeDelta   float  the last frame's duration
//   iFrame       int    frames drawn
//   iResolution  vec3   x, y, pixel aspect (always 1.0 here)
//   iMouse       vec4   xy the pointer, zw where it was pressed
//   iDate        vec4   year, month, day, seconds into the day
//   iSampleRate  float  the audio context's rate
//
// And these come from the music, if you declare them — the same way, and with the same
// validation, as any uniform you set from your own code:
//
//   uLevel       float  the overall level, fast to rise and slow to fall
//   uBands       vec4   bass, low-mid, high-mid, treble
//
// To send a value from your Sonic Pi program, `puts` a directive. The values arrive as Ruby's own
// printed form, so use symbols — they come out bare, where a string would arrive quoted:
//
//   puts :gfx, :uGain, 0.5                 # sets  uniform float uGain;  →  :gfx :uGain 0.5
//   puts :gfx, :uColor, 1.0, 0.2, 0.8      # sets  uniform vec3  uColor; →  :gfx :uColor 1.0 0.2 0.8
//   puts :gfxv, :uGain, 0.5                # the same, and also said in the Log panel
//
// A name the shader does not declare, or a shape that does not fit it, is reported in the Log
// panel and changes nothing. Directives are silent by default; `:gfxv` is the one that shows.
//
// uniform float uGain;   // uncomment to see a `:gfx` directive reach it

uniform float uLevel;
uniform vec4  uBands;

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2  uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  float r  = length(uv);
  float a  = atan(uv.y, uv.x);
  float t  = iTime;

  vec3 col = vec3(0.0);

  // rings breathing with the low end
  for (int i = 0; i < 5; i++) {
    float fi  = float(i);
    float rad = 0.16 + 0.13 * fi + 0.09 * uBands.x;
    col += vec3(0.15, 0.55, 1.00) * smoothstep(0.014, 0.0, abs(r - rad - 0.02 * sin(t * 1.3 + fi)));
  }

  // spokes the high end pushes round
  float spokes = 0.5 + 0.5 * sin(a * 6.0 + t * (0.4 + 2.5 * uBands.w));
  col += mix(vec3(0.05, 0.10, 0.25), vec3(1.00, 0.45, 0.12), spokes) * 0.28 * (0.25 + uLevel * 3.0);

  // a core that pulses with the overall level
  col += vec3(1.0, 0.85, 0.55) * smoothstep(0.07, 0.0, r) * (0.18 + 1.5 * uLevel);
  col += vec3(0.05, 0.10, 0.22) * (1.0 - smoothstep(0.0, 1.1, r));

  fragColor = vec4(col, 1.0);
}
