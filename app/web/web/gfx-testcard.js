// SPDX-License-Identifier: AGPL-3.0-or-later
// A test card for the three inputs that are easy to be unsure about: the two audio textures and a
// picture. It is one screen that answers "is this actually working?" without reading any code:
//
//   top band      the spectrum (iChannel0), 64 bars. Silence is a flat row of stubs, music is not.
//   middle band   the waveform (iChannel1), drawn as a line. Silence is a straight line through the
//                 middle; anything playing moves it.
//   lower left    iChannel2, aspect-corrected, in a letterbox. Nothing wired is a hatch, a wired
//                 picture is the picture.
//   lower right   three swatches: how much spectrum there is, how far the waveform is from silence,
//                 and -- as a colour -- what iChannel2 turned out to be: green a real picture,
//                 magenta a picture that was asked for and is not here, dark nothing bound there.
//
//   That third swatch has to GUESS, and it guesses from the size the renderer reports: its stand-ins
//   are EXACTLY 1x1 (nothing bound) and EXACTLY 8x8 (the placeholder), so both dimensions are
//   compared against both. An earlier version asked "smaller than 8" for the placeholder, which made
//   an 8x2 picture read as missing while the panel beside it showed it perfectly -- the probe caught
//   that. What it still cannot tell: a real picture of exactly 1x1 or exactly 8x8.
//                   green    a real picture is bound and is being read
//                   magenta  a picture was ASKED for and is not in this session (the placeholder)
//                   dark     nothing is bound there at all
//
// It is here as CODE rather than as a fragment file so that both the app and tools/webgl-multipass-probe
// can use the very same source: the probe builds a document from `testCardDocument()` and reads pixels
// out of each region, which is what makes "the card works" a measurement rather than a claim.
//
// The channels it expects, and `testCardDocument` wires the two that need no file:
//   iChannel0 = Audio — spectrum      iChannel1 = Audio — waveform      iChannel2 = a picture
import { emptyDocument } from "./gfx-document.js";

export const TEST_CARD = `// The test card: spectrum, waveform, and iChannel2.
void mainImage(out vec4 c, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;

  // what a channel turned out to be. The renderer binds a 1x1 black texture for "nothing" and an
  // 8x8 magenta checker for "asked for, not here" (gfx-renderer.js), so the size says which it is.
  float ch2w = iChannelResolution[2].x;   // 1x1 = nothing bound, 8x8 = the placeholder, else a picture
  float ch2h = iChannelResolution[2].y;
  float nothingBound = (ch2w < 1.5 && ch2h < 1.5) ? 1.0 : 0.0;
  float missingPicture = (abs(ch2w - 8.0) < 0.5 && abs(ch2h - 8.0) < 0.5) ? 1.0 : 0.0;

  c = vec4(0.02, 0.02, 0.03, 1.0);

  if (uv.y > 0.66) {
    // ── the spectrum: 64 bars, each the energy of one slice of the 512 bins ──
    float bar = floor(uv.x * 64.0);
    float f = (bar + 0.5) / 64.0;
    float v = texture(iChannel0, vec2(f, 0.25)).x;
    vec3 dim = vec3(0.10, 0.13, 0.20);
    vec3 lit = mix(vec3(0.20, 0.55, 0.95), vec3(0.55, 0.95, 0.65), v);
    c.rgb = dim;
    if (uv.y < 0.66 + v * 0.32) c.rgb = lit;
    if (mod(bar, 8.0) < 0.5) c.rgb += 0.04;            // every eighth bar is marked: a grid, so a flat
  } else if (uv.y > 0.52) {                            // row of nothing still looks like a scale
    // ── the waveform: a line at the sample's value, and the silence line it should sit on ──
    float band = (uv.y - 0.52) / 0.14;
    float w = texture(iChannel1, vec2(uv.x, 0.75)).x;  // 0.5 is silence
    c.rgb = vec3(0.07, 0.07, 0.09);
    if (abs(band - 0.5) < 0.012) c.rgb = vec3(0.28, 0.28, 0.32);
    if (abs(band - w) < 0.030) c.rgb = vec3(0.95, 0.60, 0.25);
  } else if (uv.x < 0.5) {
    // ── the picture, letterboxed so it is not stretched ──
    if (nothingBound > 0.5) {
      // nothing is bound on iChannel2: a hatch, which is plainly not a picture and not an error
      float h = mod(floor(uv.x * 24.0) + floor(uv.y * 24.0), 2.0);
      c.rgb = mix(vec3(0.10, 0.10, 0.13), vec3(0.16, 0.16, 0.20), h);
    } else {
      vec2 panel = vec2(0.5, 0.52) * iResolution.xy;   // the panel, in pixels
      vec2 res = vec2(ch2w, max(ch2h, 1.0));
      float scale = min(panel.x / res.x, panel.y / res.y);
      vec2 rel = (fragCoord - panel * 0.5) / (res * scale) + 0.5;
      if (rel.x < 0.0 || rel.x > 1.0 || rel.y < 0.0 || rel.y > 1.0) c.rgb = vec3(0.05);
      else c.rgb = texture(iChannel2, rel).rgb;
    }
  } else {
    // ── three swatches: is the spectrum alive, is the waveform moving, is the picture really here ──
    float energy = 0.0;
    for (int i = 0; i < 8; i++) energy += texture(iChannel0, vec2((float(i) + 0.5) / 8.0, 0.25)).x;
    energy /= 8.0;
    float wave = abs(texture(iChannel1, vec2(0.5, 0.75)).x - 0.5) * 2.0;
    if (uv.y > 0.34) c.rgb = vec3(0.04) + vec3(0.30, 0.90, 0.60) * energy;
    else if (uv.y > 0.17) c.rgb = vec3(0.04) + vec3(0.95, 0.60, 0.25) * wave;
    else if (uv.x > 0.98 || uv.y < 0.02) c.rgb = vec3(0.12);
    else if (nothingBound > 0.5) c.rgb = vec3(0.11, 0.11, 0.15);
    else if (missingPicture > 0.5) c.rgb = vec3(0.90, 0.20, 0.90);
    else c.rgb = vec3(0.20, 0.90, 0.30);
  }
}`;

/**
 * The card as a document: the Image pass draws it, and the two audio channels are already wired --
 * they need no file, and wiring them is the whole point of the card. iChannel2 is left for a picture,
 * because that is the player's to choose (and the card says so in its third swatch).
 */
export function testCardDocument(name = "Test card") {
  const doc = emptyDocument(name, TEST_CARD);
  doc.channels = [
    { kind: "audio", band: "fft" },
    { kind: "audio", band: "wave" },
    { kind: "none" },
    { kind: "none" },
  ];
  return doc;
}
