// ── Nothing of ours is on the page ──────────────────────────────────────────────────────────────────────────
//
// By request: every piece of graphics UI is out of the audio interface -- no canvas, no buttons, no panes, no
// settings, no styles, not even a file fetched beyond this one. What is left in the page is the app's own
// interface, untouched.
//
// The whole layer is kept in ./graphics/ (every file moved, nothing rewritten: graphics/gfx-layer.js is the
// entry it always was). The page loads this file and nothing comes of it -- and the app's own record hook calls
// window.sonicPiGfx?.record(…), which is a no-op when the object is not there, so the app runs exactly as it
// shipped.
//
// Putting it back is deliberately a piece at a time: turn this on and the gate imports the layer, which is where
// every part of it lives; or import one module from ./graphics/ directly to bring back only that part. The
// build copies ./graphics/ into the artifact when this is true (tools/build-for-cdn.sh).
export const GFX_ENABLED = false;   // the whole layer stays off
export const EDITOR_TAB = true;     // ...except the editor, which is back on its own

if (GFX_ENABLED) await import("./graphics/gfx-layer.js");

if (EDITOR_TAB && !GFX_ENABLED) {
  const { createEditorTab } = await import("./gfx-editor-tab.js");
  createEditorTab({ log: (t) => console.info(`Shadertoy — ${t}`) });
}
