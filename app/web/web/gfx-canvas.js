// SPDX-License-Identifier: AGPL-3.0-or-later
// The canvas behind the interface: the GL context, the frame's own clock and pointer, and the loop.
//
// Everything about SHADERS lives elsewhere now:
//
//   gfx-program.js    one pass: compile, swap, never left broken, and where a line number points
//   gfx-renderer.js   the passes in order, the buffers, and what each channel samples
//   gfx-document.js   what a shader document IS (and the rule that only code is ever saved)
//
// What is left here is what is nobody else's business: the element, the context, the resolution and
// pixel ratio, the pointer, the clock the frame's own values come from, and calling the renderer once
// a frame. Keeping it this thin is what makes the passes testable at all -- a probe can build a
// renderer on its own context and drive it, which is exactly what tools/webgl-multipass-probe does.
//
// One rule came along from the old single-pass file and still holds: the uniform list is the LINK's,
// never the source's. A declared-but-unused uniform is not in `glGetActiveUniform` at all (measured
// on the desktop side, dev-discipline.md §7), so reading the source would "find" names the linker
// threw away and tell a player a value was accepted when nothing could receive it.

import { createRenderer } from "./gfx-renderer.js";
import { emptyDocument } from "./gfx-document.js";

/**
 * @param {{document?: object, imageSource?: string, onProblem?: Function}} opts
 *   `imageSource` is the Image pass's starting code -- what the `.frag` file holds.
 */
export function createCanvas({ document: doc = null, imageSource = "", onProblem = () => {} } = {}) {
  const canvas = document.createElement("canvas");
  canvas.id = "gfx-canvas";
  const gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: "low-power" });
  if (!gl) {
    onProblem("this browser has no WebGL2, so the shader canvas cannot run");
    return null;
  }

  const renderer = createRenderer(gl, { onProblem });
  let shown = doc ?? emptyDocument("Untitled", imageSource);
  const compiled = renderer.compile(shown);
  if (!compiled.ok) for (const f of compiled.failures) onProblem(`${f.pass} did not compile.\n${f.report}`);

  const state = {
    time: 0, delta: 0, frame: 0,
    mouse: [0, 0, 0, 0],          // x, y, down-x, down-y -- in Shadertoy's sense, made in the renderer
    down: false,
    date: new Float32Array(4),
  };
  const bands = [0, 0, 0, 0];
  let raf = 0, last = 0, disposed = false;
  let sampleRate = () => 48000;
  let feed = null;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);   // 2 is plenty: a background, not a game
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      renderer.resize(w, h);
    }
  }

  function stamp() {
    const now = new Date();
    state.date[0] = now.getFullYear(); state.date[1] = now.getMonth() + 1; state.date[2] = now.getDate();
    state.date[3] = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  }

  function frame(now) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const seconds = now / 1000;
    state.delta = last ? seconds - last : 0;
    last = seconds;
    state.time += state.delta;
    state.frame++;
    resize();
    stamp();
    feed?.(state.time, state.delta);                 // the upper layer's own values (the audio)
    renderer.render({ ...state, sampleRate: sampleRate() });
  }

  const move = (e) => { state.mouse[0] = e.clientX; state.mouse[1] = canvas.clientHeight - e.clientY; };
  const down = (e) => { state.down = true; move(e); state.mouse[2] = state.mouse[0]; state.mouse[3] = state.mouse[1]; };
  const up = () => { state.down = false; };
  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("pointerdown", down, { passive: true });
  window.addEventListener("pointerup", up, { passive: true });

  canvas.width = Math.max(1, canvas.clientWidth); canvas.height = Math.max(1, canvas.clientHeight);
  renderer.resize(canvas.width, canvas.height);
  raf = requestAnimationFrame(frame);

  return {
    canvas,
    renderer,
    get document() { return shown; },
    /** Compile a document and, if it is good, make it the one being drawn. */
    compile(next) {
      if (next) shown = next;
      return renderer.compile(shown);
    },
    /** The names a program can drive: every pass's own, plus the frame's own (which are read-only). */
    get usable() { return [...new Set([...renderer.userUniforms(), ...renderer.builtins])].sort(); },
    get userUniforms() { return renderer.userUniforms(); },
    get live() { return renderer.live; },
    get float() { return renderer.float; },
    set: (name, values) => renderer.set(name, values),
    setIfPresent: (name, values) => renderer.setIfPresent(name, values),
    onFeed: (fn) => { feed = fn; },
    setSampleRate: (fn) => { sampleRate = fn; },
    bands,
    destroy() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      renderer.dispose();
      canvas.remove();
    },
  };
}
