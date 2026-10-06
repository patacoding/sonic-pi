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
  let canvasView = null;
  try {
    const { createCanvasView } = await import("./gfx-canvas-view.js");
    canvasView = createCanvasView({ onSay: (t) => console.info(`Shadertoy — ${t}`) });
  } catch (e) {
    // loud, because a canvas that never appears is otherwise indistinguishable from one that draws nothing
    console.error(`Shadertoy — the canvas could not be created: ${e?.stack ?? e}`);
  }
  // published BEFORE anything is compiled: a startup compile that throws must not take the object with it, or
  // the picture is there and nothing can reach it (measured: window.sonicPiCanvas was undefined while every
  // module had loaded fine)
  if (canvasView) window.sonicPiCanvas = canvasView;
  try {
    const { createEditorTab, defaultPasses } = await import("./gfx-editor-tab.js");
    createEditorTab({ log: (t) => console.info(`Shadertoy — ${t}`), canvasView });
    const sets = (() => { try { return JSON.parse(localStorage.getItem("sp-shadertoy-sets") ?? "null"); } catch { return null; } })();
    const set0 = sets?.docs?.[sets.doc ?? 0];
    canvasView?.setPasses(set0?.passes ?? defaultPasses(), set0?.channels ?? []);
  } catch (e) {
    console.error(`Shadertoy — the editor or the startup compile failed: ${e?.message ?? e}`);
    try { canvasView.setPasses({ Image: "void mainImage(out vec4 c, in vec2 p) { c = vec4(p.x / iResolution.x, p.y / iResolution.y, 0.5, 1.0); }" }, []); } catch {}
  }
}
