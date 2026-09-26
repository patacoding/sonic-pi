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

  // one column per FFT bin and the newest samples for the waveform, filled each frame by the upper
  // layer (gfx.js, which owns the analyser). The texture's own width is the ceiling -- fftSize 1024
  // is what makes the analyser's 512 bins land on it exactly, and the fill is bounded by the data so
  // a different fftSize would show fewer columns rather than read off the end
  const audio = { fft: new Float32Array(renderer.audioSize.w), wave: new Float32Array(renderer.audioSize.w) };

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
    renderer.render({ ...state, sampleRate: sampleRate(), audio });
    if (pending) { const p = pending; pending = null; try { p.resolve(grab(p.scale)); } catch (e) { p.reject(e); } }
  }

  // ── capture: the frame that was just drawn ────────────────────────────────────────────────────────
  // `preserveDrawingBuffer` is off on purpose (it costs a copy every frame), so the drawing buffer is
  // only readable INSIDE the frame that drew it -- hence a capture is taken at the end of the next
  // frame, from the same call stack. Nothing is re-rendered: what comes back is the picture that is on
  // screen, at the canvas's own size, with no interface over it, and with no side effects on iFrame,
  // iTime or the ping-pong (a re-render would advance all three and make an "identical" capture differ).
  //
  // This is what makes audio-visual work drivable from a script: set the code, Run, and take the picture
  // a human would take a screenshot of.
  let pending = null;

  function grab(scale = 1) {
    const w = canvas.width, h = canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);        // whatever the passes left bound, the screen is what we want
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(w * scale));
    out.height = Math.max(1, Math.round(h * scale));
    const ctx = out.getContext("2d");
    const img = ctx.createImageData(out.width, out.height);
    // WebGL's origin is bottom-left and the canvas's is top-left: flipped row by row, and scaled by
    // nearest sampling (a capture is evidence, not a resampled picture)
    let sum = 0;
    for (let y = 0; y < out.height; y++) {
      const sy = h - 1 - Math.min(h - 1, Math.floor(y / scale));
      for (let x = 0; x < out.width; x++) {
        const sx = Math.min(w - 1, Math.floor(x / scale));
        const s = (sy * w + sx) * 4, d = (y * out.width + x) * 4;
        img.data[d] = px[s]; img.data[d + 1] = px[s + 1]; img.data[d + 2] = px[s + 2]; img.data[d + 3] = 255;
        sum += (px[s] * 0.2126 + px[s + 1] * 0.7152 + px[s + 2] * 0.0722) / 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const url = out.toDataURL("image/png");
    return {
      dataUrl: url, url, width: out.width, height: out.height,
      bytes: Math.round((url.length - "data:image/png;base64,".length) * 0.75),
      mean: sum / (out.width * out.height),           // 0 = black: the cheapest "did anything draw?" there is
      frame: state.frame, time: state.time,
    };
  }

  /** The next drawn frame, as a PNG data URL. `scale` < 1 answers with a smaller picture. */
  function capture({ scale = 1 } = {}) {
    if (disposed) return Promise.reject(new Error("the canvas is disposed"));
    if (!canvas.width || !canvas.height) return Promise.reject(new Error("the canvas has no size yet"));
    return new Promise((resolve, reject) => { pending = { resolve, reject, scale: scale > 0 ? scale : 1 }; });
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
    /** What the upper layer fills each frame: the audio, as the texture's two rows (gfx-renderer.js). */
    audio,
    set: (name, values) => renderer.set(name, values),
    setIfPresent: (name, values) => renderer.setIfPresent(name, values),
    /** Moving the channels' cables, which is not a compile: see gfx-renderer.js. All four at once. */
    setChannels: (refs) => renderer.setChannels(refs),
    addImage: (name, source) => renderer.addImage(name, source),
    removeImage: (name) => renderer.removeImage(name),
    get images() { return renderer.images; },
    /** The next drawn frame as a PNG data URL -- see the note above `grab()`. */
    capture,
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
