// ── The graphics layer is OFF ───────────────────────────────────────────────────────────────────────────────
//
// By request: the page is the app's own again, with none of our graphics UI on it -- no canvas, no panes, no
// panel, no HUD, no mode switch, no styles. The whole layer is kept, untouched, in gfx-layer.js beside this
// file, and one line brings it back:
//
//     export const GFX_ENABLED = true;
//
// Nothing upstream is involved either way: index.html loads this file (one of the two lines that are the whole
// intrusion), and with the layer off `window.sonicPiGfx` simply never appears -- the app's record hook calls it
// through `window.sonicPiGfx?.record(…)`, so it is a no-op and the app runs exactly as it shipped.
export const GFX_ENABLED = true;

if (GFX_ENABLED) await import("./gfx-layer.js");
