// The shader the graphics canvas draws. Edit this file and reload the page — it is fetched as
// `gfx-shader.frag`, so nothing needs rebuilding. (If this file is missing, gfx.js falls back to a
// small placeholder of its own and says so in the Log.)
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
// Two of these come from the music. Declare the ones you want — a uniform that is declared but never
// USED is not in the linked program at all, so setting it is refused with "declares no uniform":
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
// A name the shader does not declare, or a shape that does not fit it, is reported in the Log panel
// and changes nothing. Directives are silent by default; `:gfxv` is the one that shows.
//
// ── uGain: the one to try first ──────────────────────────────────────────────────────────────────
//
// `uGain` is not fed by anything. It is here so a value from your own code has something unmistakable
// to move: it ZOOMS the whole pattern — 1.0 shows it all, 0.0 is six times closer — and lights a rim
// at the top of its range. So the whole picture scaling up and down IS the check that a directive
// arrived.
//
//   live_loop :gfx do
//     puts :gfxv, :uGain, rrand(0.0, 1.0)     # :gfxv also says each one in the Log
//     sleep 0.5
//   end
//
// Then swap `:gfxv` for `:gfx`: the picture keeps moving and the Log goes quiet. Send something the
// shader cannot hold and the Log says why instead of changing anything:
//
//   puts :gfx, :uGain, 1, 2, 3        # "uGain" is float in the shader, but vec3 was given
//   puts :gfx, :uNope, 1.0            # the running shader declares no uniform "uNope"

uniform float uGain;    // yours to drive
uniform float uLevel;   // the audio's
uniform vec4  uBands;   // the audio's

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // 1.0 -> the whole pattern, 0.0 -> six times closer. Clamped, so any value is safe to send.
  float zoom = mix(6.0, 1.0, clamp(uGain, 0.0, 1.0));

  vec2  uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y * zoom;
  float r  = length(uv);
  float a  = atan(uv.y, uv.x);
  float t  = iTime;

  vec3 col = vec3(0.0);

  // rings breathing with the low end
  for (int i = 0; i < 5; i++) {
    float fi  = float(i);
    float rad = 0.16 + 0.13 * fi + 0.09 * uBands.x;
    col += vec3(0.15, 0.55, 1.00) * smoothstep(0.014 * zoom, 0.0, abs(r - rad - 0.02 * sin(t * 1.3 + fi)));
  }

  // spokes the high end pushes round
  float spokes = 0.5 + 0.5 * sin(a * 6.0 + t * (0.4 + 2.5 * uBands.w));
  col += mix(vec3(0.05, 0.10, 0.25), vec3(1.00, 0.45, 0.12), spokes) * 0.28 * (0.25 + uLevel * 3.0);

  // a core that pulses with the overall level
  col += vec3(1.0, 0.85, 0.55) * smoothstep(0.07 * zoom, 0.0, r) * (0.18 + 1.5 * uLevel);
  col += vec3(0.05, 0.10, 0.22) * (1.0 - smoothstep(0.0, 1.1, r));

  // a rim only when uGain is up, so the two ends of its range cannot be mistaken for each other
  col += vec3(0.10, 0.85, 0.65) * smoothstep(0.85, 1.0, uGain) * smoothstep(0.02, 0.0, abs(r - 0.85));

  fragColor = vec4(col, 1.0);
}
