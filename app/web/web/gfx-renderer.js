// SPDX-License-Identifier: AGPL-3.0-or-later
// The passes, drawn in order, into each other and then onto the screen.
//
// Shadertoy's machine, which the user asked for: Buffer A -> B -> C -> D -> Image every frame, each
// pass able to read the ones before it, Common text in front of all of them, and iChannel0..3
// choosing what a pass samples.
//
// ── The two things that are easy to get subtly wrong ────────────────────────────────────────────
//
// 1. WHAT A CHANNEL SEES. A pass that samples ITSELF must see the PREVIOUS frame (that is how a
//    feedback trail works); a pass that samples a buffer drawn EARLIER THIS FRAME must see this
//    frame's result. So each buffer keeps two textures: `cur` holds last frame's finished result,
//    `write` is what this frame draws into, and a channel resolves to `write` only once that buffer
//    has actually been drawn this frame. Both halves were measured before any of this was written --
//    tools/webgl-mrt-probe, "self_is_previous_frame=yes earlier_buffer_is_this_frame=yes".
//
// 2. WHAT HAPPENS WHEN SOMETHING IS MISSING. A channel may be bound to a buffer whose pass is blank,
//    or to a picture that was uploaded in an earlier session and is not here now. Neither may throw
//    and neither may draw a silent black hole that looks like a broken shader: the first is black
//    (nothing is there, and the pass that would fill it is off), the second is a visible placeholder
//    and one line in the Log. A performance must not stop because a file is missing.
//
// Float targets are used where the browser has them (EXT_color_buffer_float, measured present): 8
// bits per channel loses a feedback trail in a few frames. Without it the buffers fall back to RGBA8
// and `float` says so, because a piece that depends on high precision will look different.

import { createProgram, BUILTIN_NAMES } from "./gfx-program.js";
import { PASS_ORDER, BUFFER_PASSES, CHANNELS, isBuffer, activePasses } from "./gfx-document.js";

/** One pass's worth of GL: the program, and what each of its four channels asks for. */
export function createRenderer(gl, { onProblem = () => {} } = {}) {
  const passes = new Map();          // name -> { program, channels }
  const buffers = new Map();         // name -> { targets: [a, b], cur, write, written }
  const images = new Map();          // name -> { tex, w, h }   THIS SESSION ONLY
  const said = new Set();            // each kind of trouble once, not once a frame
  const say = (text) => { if (!said.has(text)) { said.add(text); onProblem(text); } };

  const floatOK = !!gl.getExtension("EXT_color_buffer_float");
  let W = 1, H = 1;
  let lastChannels = [];             // what the four channels are now, for a pass compiled after they moved

  // ── textures, targets, and the two stand-ins ───────────────────────────────────────────────────
  function texture(w, h, { float = false, filter = gl.NEAREST, wrap = gl.CLAMP_TO_EDGE, pixels = null }) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    if (float && floatOK) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, pixels);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return tex;
  }

  function target(w, h) {
    const tex = texture(w, h, { float: true });
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, ok };
  }

  /** 1x1 black: what an unbound channel reads, so a shader never samples nothing. */
  const blackTex = (() => { const t = texture(1, 1, { pixels: new Uint8Array([0, 0, 0, 255]) }); return { tex: t, w: 1, h: 1 }; })();

  /** A visible stand-in for a picture that is not here: a magenta checker, impossible to mistake for
   *  the artwork, and one line in the Log saying how to get the real one back. */
  const placeholder = (() => {
    const px = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const on = (x < 4) !== (y < 4);
      const at = (y * 8 + x) * 4;
      px[at] = on ? 255 : 24; px[at + 1] = 24; px[at + 2] = on ? 255 : 24; px[at + 3] = 255;
    }
    const t = texture(8, 8, { filter: gl.NEAREST, wrap: gl.REPEAT, pixels: px });
    return { tex: t, w: 8, h: 8 };
  })();

  /** The engine's own audio, as a texture: 512 columns, and two rows -- the FFT on top of the
   *  waveform. THIS IS SHADERTOY'S LAYOUT, deliberately, so a shader written there reads the same
   *  numbers here: `texture(iChannel0, vec2(f, 0.25)).x` is the frequency band at `f`, and
   *  `texture(iChannel0, vec2(t, 0.75)).x` is the waveform at `t`, both in 0..1.
   *
   *  Silence is what it starts as, and what it goes back to when the engine has not been run: a
   *  piece that samples audio before anything is playing draws a flat line rather than a black hole. */
  const AUDIO_W = 512, AUDIO_H = 2;
  const audioPixels = new Uint8Array(AUDIO_W * AUDIO_H * 4);
  for (let i = 3; i < audioPixels.length; i += 4) audioPixels[i] = 255;      // opaque, whatever is in it
  const audioTex = texture(AUDIO_W, AUDIO_H, { filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE, pixels: audioPixels });
  const audio = { tex: audioTex, w: AUDIO_W, h: AUDIO_H };

  // ── buffers ────────────────────────────────────────────────────────────────────────────────────
  function ensureBuffer(name) {
    let b = buffers.get(name);
    if (b && b.targets.every((t) => t.ok)) return b;
    if (b) for (const t of b.targets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    const targets = [target(W, H), target(W, H)];
    if (!targets.every((t) => t.ok)) say(`${name} could not be rendered to as a texture: this browser will not give a float target, and 8 bits may lose a feedback trail.`);
    b = { targets, cur: 0, write: 1, written: false };
    buffers.set(name, b);
    return b;
  }

  function dropBuffer(name) {
    const b = buffers.get(name);
    if (!b) return;
    for (const t of b.targets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    buffers.delete(name);
  }

  function resize(w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (w === W && h === H) return;
    W = w; H = h;
    for (const name of [...buffers.keys()]) { dropBuffer(name); ensureBuffer(name); }   // contents are lost: say so?
  }

  // ── what a channel draws from ──────────────────────────────────────────────────────────────────
  function resolve(ref) {
    if (ref?.kind === "audio") return audio;
    if (ref?.kind === "image") {
      const img = images.get(ref.name);
      if (img) return img;
      say(`the picture "${ref.name}" is not here — a picture lives in this session only and is never saved with the code. Upload it again; a placeholder is drawn until then.`);
      return placeholder;
    }
    if (ref?.kind === "buffer") {
      const b = buffers.get(ref.buffer);
      if (!b) {
        say(`${ref.buffer} is empty, so a channel that draws from it has nothing: that pass has no code.`);
        return blackTex;
      }
      return b.written ? b.targets[b.write] : b.targets[b.cur];      // this frame's, or last frame's
    }
    return blackTex;
  }

  /** Ten seconds of the same warning, not one per frame. */
  const chanRes = new Float32Array(CHANNELS * 3);

  // ── compiling ──────────────────────────────────────────────────────────────────────────────────
  /**
   * Compile the document's passes. A pass that fails keeps whatever it had -- including nothing --
   * and the failure comes back in `failures` for the editor to show, per pass, with its own lines.
   * `diagnostics` rides along with the readable `report`: the editor marks lines, and re-reading its
   * own line numbers back out of a block of text is how a "line 12" ends up pointing at line 1.
   */
  function compile(doc) {
    const failures = [], compiled = [];
    const given = Array.isArray(doc.channels) ? doc.channels : [];      // the document's, not a pass's
    if (given.length) lastChannels = given;      // so a pass compiled later still gets the wiring
    const channels = lastChannels;
    for (const name of PASS_ORDER) {
      const source = doc.passes[name] ?? "";
      const off = source.trim() === "";
      const existing = passes.get(name);
      if (off) {
        if (existing) { existing.program.dispose(); passes.delete(name); }
        if (isBuffer(name)) dropBuffer(name);
        continue;
      }
      const entry = existing ?? { program: createProgram(gl, { name }), channels: [] };
      passes.set(name, entry);
      entry.channels = channels;                  // the document's four, the same for every pass
      const r = entry.program.compile({ source, common: doc.common ?? "" });
      if (r.ok) compiled.push(name);
      else failures.push({ pass: name, report: r.report, diagnostics: r.diagnostics ?? [], where: r.where });
      if (isBuffer(name)) ensureBuffer(name);
    }
    for (const name of BUFFER_PASSES) if (!passes.has(name)) dropBuffer(name);
    return { ok: failures.length === 0, compiled, failures, float: floatOK };
  }

  /**
   * What the engine is playing, as the two rows of that texture. The upper layer hands over the same
   * numbers it already takes for `uLevel`/`uBands`, so there is one reading of the audio in the page
   * and not two that can disagree.
   *
   * `fft` and `wave` are both 0..1 and 512 long, and are read at the NEXT draw -- the audio is
   * sampled once a frame, not once a pass, so a pass that reads it twice reads the same numbers.
   */
  function setAudio(fft, wave) {
    if (!fft && !wave) return;
    for (let x = 0; x < AUDIO_W; x++) {
      const at = x * 4;                                                  // row 0, from the bottom: v=0.25
      const v = fft ? fft[x] : 0;
      audioPixels[at] = audioPixels[at + 1] = audioPixels[at + 2] = Math.max(0, Math.min(255, Math.round(v * 255)));
      const wt = (AUDIO_W + x) * 4;                                      // row 1: v=0.75
      const w2 = wave ? wave[x] : 0;
      audioPixels[wt] = audioPixels[wt + 1] = audioPixels[wt + 2] = Math.max(0, Math.min(255, Math.round(w2 * 255)));
    }
    gl.bindTexture(gl.TEXTURE_2D, audioTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, AUDIO_W, AUDIO_H, gl.RGBA, gl.UNSIGNED_BYTE, audioPixels);
  }

  /** Does any pass that is going to draw read the audio? Then uploading it is worth doing at all. */
  function audioWanted() {
    for (const [, entry] of passes) {
      if (!entry.program.program) continue;
      for (const r of entry.channels ?? []) if (r?.kind === "audio") return true;
    }
    return false;
  }

  // ── drawing ────────────────────────────────────────────────────────────────────────────────────
  /** state: { time, delta, frame, mouse: [x,y,downX,downY], down, date: Float32Array(4), sampleRate } */
  function render(state) {
    // once a frame, and only if a pass that draws actually reads it: an audio texture nobody samples
    // is a texture upload per frame for nothing
    if (state.audio && audioWanted()) setAudio(state.audio.fft, state.audio.wave);
    for (const name of BUFFER_PASSES) {
      const b = buffers.get(name);
      if (b) { b.write = 1 - b.cur; b.written = false; }               // this frame draws into the other one
    }

    for (const name of PASS_ORDER) {
      const entry = passes.get(name);
      if (!entry?.program.program) continue;
      const p = entry.program;
      p.use();

      if (p.uniforms.has("iTime")) p.setIfPresent("iTime", [state.time]);
      p.setIfPresent("iTimeDelta", [state.delta]);
      p.setIfPresent("iFrame", [state.frame]);
      p.setIfPresent("iResolution", [W, H, 1]);
      // Shadertoy's iMouse: xy where the pointer is, zw where it was pressed, and zw NEGATIVE while
      // the button is down. Code that checks for the sign to mean "dragging" is common, so it is
      // followed exactly rather than approximated.
      const m = state.mouse;
      p.setIfPresent("iMouse", [m[0], m[1], state.down ? -Math.abs(m[2]) : Math.abs(m[2]), m[3]]);
      p.setIfPresent("iDate", state.date);
      p.setIfPresent("iSampleRate", [state.sampleRate]);

      for (let i = 0; i < CHANNELS; i++) {
        const r = resolve(entry.channels[i]);
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, r.tex);
        p.setSampler(`iChannel${i}`, i);
        chanRes[i * 3] = r.w; chanRes[i * 3 + 1] = r.h; chanRes[i * 3 + 2] = 1;
      }
      p.setArray("iChannelResolution", chanRes);

      const buffer = isBuffer(name) ? ensureBuffer(name) : null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffer ? buffer.targets[buffer.write].fbo : null);
      gl.viewport(0, 0, W, H);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (buffer) buffer.written = true;                                // later passes see THIS frame
    }

    for (const name of BUFFER_PASSES) {
      const b = buffers.get(name);
      if (b?.written) b.cur = b.write;
    }
  }

  // ── the player's values, and the editor's questions ────────────────────────────────────────────
  const own = (name) => BUILTIN_NAMES.includes(name);

  /** A value from a program, sent to every pass that declares it -- and to none that does not. */
  function set(name, values) {
    if (own(name)) return { ok: false, error: `"${name}" is one of the frame's own values, not one a program sets` };
    let took = 0; const refused = [];
    for (const [pass, entry] of passes) {
      if (!entry.program.uniforms.has(name)) continue;
      const r = entry.program.set(name, values);
      if (r.ok) took++; else refused.push(`${pass}: ${r.error}`);
    }
    if (took) {
      if (refused.length) say(`"${name}" was set, but not everywhere: ${refused.join("; ")}`);
      return { ok: true };
    }
    if (refused.length) return { ok: false, error: refused[0] };
    return { ok: false, error: `no pass declares "${name}"` };
  }

  /** Our own feeds (the audio): silent wherever a pass does not want them. */
  function setIfPresent(name, values) { for (const [, e] of passes) e.program.setIfPresent(name, values); }

  /** What a program can drive: declared by some pass, and not one of the frame's own values. */
  function userUniforms() {
    const names = new Set();
    for (const [, e] of passes) for (const n of e.program.usable) if (!own(n)) names.add(n);
    return [...names].sort();
  }

  return {
    compile,
    render,
    resize,
    set,
    setIfPresent,
    userUniforms,
    builtins: BUILTIN_NAMES,
    get float() { return floatOK; },
    get size() { return { w: W, h: H }; },
    get passes() { return [...passes.keys()]; },
    /** Which passes have a program that is actually drawing right now. */
    get live() { return [...passes].filter(([, e]) => !!e.program.program).map(([n]) => n); },
    /** What the four channels read -- the document's, so every pass answers the same. */
    channelsOf() { return lastChannels; },
    /** The size of the audio texture, so the editor can say what a shader is reading. */
    get audioSize() { return { w: AUDIO_W, h: AUDIO_H }; },

    /**
     * Point the four channels somewhere else. A separate act from compiling, because it is: which
     * texture `iChannel0` samples is a binding, not a line of GLSL, so the editor can change it
     * while the picture keeps running instead of making the player recompile to move a cable.
     *
     * ALL FOUR GO TO ALL THE PASSES AT ONCE. There is one set of inputs for the piece and not one per
     * tab (gfx-document.js says why), so this cannot be per pass even if a caller asked it to be.
     */
    setChannels(refs) {
      lastChannels = refs ?? [];
      for (const entry of passes.values()) entry.channels = lastChannels;
      return true;
    },

    /** A picture for a channel. Kept in memory for this session and never written anywhere. */
    addImage(name, source) {
      const old = images.get(name);
      if (old) gl.deleteTexture(old.tex);
      const w = source.width, h = source.height;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      // flipped on the way in, so uv (0,0) is the picture's bottom-left as it is displayed -- which
      // is what Shadertoy's own textures do, and what a ported shader's uv maths assumes
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      images.set(name, { tex, w, h });
      return { name, w, h };
    },
    removeImage(name) {
      const img = images.get(name);
      if (img) gl.deleteTexture(img.tex);
      images.delete(name);
    },
    get images() { return [...images].map(([name, i]) => ({ name, w: i.w, h: i.h })); },
    hasImage: (name) => images.has(name),

    dispose() {
      for (const [, e] of passes) e.program.dispose();
      passes.clear();
      for (const name of [...buffers.keys()]) dropBuffer(name);
      for (const [, i] of images) gl.deleteTexture(i.tex);
      images.clear();
      gl.deleteTexture(blackTex.tex);
      gl.deleteTexture(placeholder.tex);
    },
  };
}
