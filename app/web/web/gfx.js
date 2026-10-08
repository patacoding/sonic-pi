// Our layer's entry. index.html loads this file (one of the two lines that are the whole intrusion) and nothing
// else of ours is on the page unless it is wired here, deliberately and one piece at a time.
//
//   GFX_ENABLED  the whole original layer (graphics/gfx-layer.js) -- OFF, kept, one line away
//   EDITOR_TAB   the pieces we are building now:
//                  level 0  the render canvas, its own layer, three display states, one button
//                  level 1  the Shadertoy page: documents, passes, channels, the values the music sends
export const GFX_ENABLED = false;
export const EDITOR_TAB = true;
export const SYNTH_ENABLED = true;      // the Soundgineer engine, wired in by web/synth/host.js

if (GFX_ENABLED) await import("./graphics/gfx-layer.js");

// ── our synthesiser: an independent engine of its own, connected into the app's input bus ─────────────────
if (SYNTH_ENABLED) {
  try {
    const { synthHost } = await import("./synth/host.js");   // publishes window.sonicPiSynth
    console.info(`Synth — layer loaded (${synthHost.ready ? "running" : "waiting for the engine's first Run"})`);
  } catch (e) {
    console.error(`Synth — the layer could not be loaded: ${e?.stack ?? e}`);
  }
}

if (EDITOR_TAB && !GFX_ENABLED) {
  // ── level 0: the canvas, with its button (preview / fullscreen / hidden) ─────────────────────────────────
  let canvasView = null;
  try {
    const { createCanvasView } = await import("./gfx-canvas-view.js");
    canvasView = createCanvasView({ onSay: (t) => console.info(`Shadertoy — ${t}`) });
    window.sonicPiCanvas = canvasView;          // published before anything is compiled: a compile that throws
  } catch (e) {                                 // must not take the object with it
    console.error(`Shadertoy — the canvas could not be created: ${e?.stack ?? e}`);
  }

  // ── level 1: the Shadertoy page, with its button (audio <-> shadertoy) ───────────────────────────────────
  try {
    const { createShadertoyPage } = await import("./gfx-shadertoy-page.js");
    const page = createShadertoyPage();
    window.sonicPiGfx = Object.assign(window.sonicPiGfx ?? {}, { page });
    // the first document comes from the ORIGINAL model, and goes to the canvas so the preview is not black
    const { emptyDocument } = await import("./graphics/gfx-document.js");
    // a starter Image, so the editor is not empty and the preview draws something recognisable
    const STARTER = `void mainImage(out vec4 c, in vec2 p) {
    vec2 uv = p / iResolution.xy;
    c = vec4(uv.x, uv.y, 0.5 + 0.5 * sin(iTime), 1.0);
}
`;
    const doc = emptyDocument("Alpha", STARTER);
    canvasView?.setPasses?.({ Common: doc.common, ...doc.passes }, doc.channels);
  } catch (e) {
    console.error(`Shadertoy — the page could not be created: ${e?.stack ?? e}`);
  }
}
