// The render canvas, with the logic: passes, channels, and variables coming in from the audio side.
//
// Level 0 of the page: its own layer, three display states, no knowledge of which interface is showing.
//
//   * PASSES  Buffer A..D render into their own textures, Image draws the screen last, Common is prepended to
//             every pass (Shadertoy's own arrangement). Passes with no code are skipped.
//   * CHANNELS iChannel0..3 per set: `buffer` binds another pass's texture, `image` a picture the player chose,
//             `audio` 512x2 of the engine's signal (row 0 spectrum, row 1 waveform), `none` a black pixel.
//   * VARIABLES from the audio side: `puts :gfx, :set, :name, 0.5` in the music sets a uniform the shaders can
//             declare (`uniform float name;`), and iAudioLevel follows the output's RMS with nothing asked for.
import { parseDirective, fits } from "./graphics/gfx-directive.js";

export const PREVIEW = "preview";
export const FULL = "fullscreen";
export const HIDDEN = "hidden";
const ORDER = [PREVIEW, FULL, HIDDEN];
export const PASS_ORDER = ["Buffer A", "Buffer B", "Buffer C", "Buffer D", "Image"];

const VERT = `#version 300 es
in vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }`;
const HEADER = () => `#version 300 es
precision highp float;
precision highp int;
// Shadertoy's own set, all of it, plus the one this host adds (iAudioLevel): a shader written for Shadertoy
// compiles here as it is, and every one of these is filled with a real value each frame.
uniform vec3  iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform float iFrameRate;
uniform int   iFrame;
uniform float iChannelTime[4];
uniform vec3  iChannelResolution[4];
uniform vec4  iMouse;
uniform vec4  iDate;
uniform float iSampleRate;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
uniform float iAudioLevel;
out vec4 sp_out;
`;
const BODY = `
void main() {
  vec4 c = vec4(0.0);
  mainImage(c, gl_FragCoord.xy);
  sp_out = c;
}`;
const STYLE = `
  /* level 0: the canvas is its own layer, above both interfaces, and neither of them can place it */
  #gfx-canvas { position: fixed; z-index: 100; background: #000; display: block; }
  body[data-gfx-canvas="preview"] #gfx-canvas { inset: auto 8px 8px auto; width: 25vw; height: 25vh;
    border: 1px solid var(--WindowBorder); border-radius: 8px; box-shadow: 0 6px 24px rgb(0 0 0 / 35%); }
  body[data-gfx-canvas="fullscreen"] #gfx-canvas { inset: 0; width: 100vw; height: 100vh; border: 0; border-radius: 0; }
  body[data-gfx-canvas="hidden"] #gfx-canvas { display: none !important; }
  /* the same pair of buttons as the page's (gfx-shadertoy-page.js defines the shared box): this one sits
     directly below it, and only its state colour differs */
  #gfx-canvas-btn { position: fixed; right: 0; top: calc(50% + 0.2em); z-index: 101; writing-mode: vertical-rl;
    height: 5.4em; overflow: hidden; padding: 10px 6px; cursor: pointer; font: 12px/1.1 system-ui, sans-serif;
    letter-spacing: .04em; text-align: center; color: var(--WindowForeground);
    border: 1px solid var(--WindowBorder); border-right: 0; border-radius: 8px 0 0 8px;
    background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); }
  #gfx-canvas-btn:hover { background: color-mix(in srgb, var(--WindowBackground) 78%, transparent); }
  #gfx-canvas-btn[data-state="fullscreen"] { border-color: #f80; color: #f80; }
  #gfx-canvas-btn[data-state="hidden"] { opacity: .6; }
`;

export function createCanvasView({ store = globalThis.localStorage ?? null, onSay = null } = {}) {
  if (!document.getElementById("gfx-canvas-style")) {
    const style = document.createElement("style");
    style.id = "gfx-canvas-style";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  const canvas = document.createElement("canvas");
  canvas.id = "gfx-canvas";
  document.body.appendChild(canvas);
  const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });

  const t0 = performance.now();
  let frames = 0, raf = 0, prev = performance.now(), lastError = null;
  let passes = {}, channels = [];
  const values = new Map();                // name -> { value: number[], shape }, exactly as the music sent it, for
                                           // a program compiled later (the old layer's `remembered`)
  const GLSL_TYPE = () => ({
    [gl.FLOAT]: "float", [gl.INT]: "int", [gl.BOOL]: "bool",
    [gl.FLOAT_VEC2]: "vec2", [gl.FLOAT_VEC3]: "vec3", [gl.FLOAT_VEC4]: "vec4",
    [gl.INT_VEC2]: "vec2", [gl.INT_VEC3]: "vec3", [gl.INT_VEC4]: "vec4",
    [gl.BOOL_VEC2]: "vec2", [gl.BOOL_VEC3]: "vec3", [gl.BOOL_VEC4]: "vec4",
  });
  /** Shadertoy's own uniforms: the host provides them, they are not the music's to set. */
  const SHADERTOY_UNIFORMS = new Set(["iResolution", "iTime", "iTimeDelta", "iFrame", "iMouse", "iAudioLevel",
    "iChannel0", "iChannel1", "iChannel2", "iChannel3", "iFrameRate", "iSampleRate", "iDate", "iChannelTime",
    "iChannelResolution"]);
  const programs = new Map(), targets = new Map(), imageCache = new Map();
  let blackTex = null, audioTex = null, analyser = null, wave = null, spectrum = null, level = 0;
  let rate = 0, sampleRate = 48000;
  const frameTimes = [];      // the last second or so, for a readout that does not flicker
  const channelTime = new Float32Array([0, 0, 0, 0]);
  const channelResolution = new Float32Array(12);
  const date = [1970, 0, 0, 0];
  // iMouse, Shadertoy's way: xy = where the pointer is now, zw = where it was pressed, with the sign of z saying
  // whether the button is still down (positive) or has been released (negative). y counts from the BOTTOM.
  const mouse = { x: 0, y: 0, downX: 0, downY: 0, down: false };
  const toCanvas = (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / Math.max(1, r.width), sy = canvas.height / Math.max(1, r.height);
    return { x: (e.clientX - r.left) * sx, y: canvas.height - (e.clientY - r.top) * sy };
  };
  canvas.addEventListener("pointermove", (e) => { const p = toCanvas(e); mouse.x = p.x; mouse.y = p.y; });
  canvas.addEventListener("pointerdown", (e) => { const p = toCanvas(e); mouse.x = mouse.downX = p.x; mouse.y = mouse.downY = p.y; mouse.down = true; canvas.setPointerCapture?.(e.pointerId); });
  canvas.addEventListener("pointerup", (e) => { const p = toCanvas(e); mouse.x = p.x; mouse.y = p.y; mouse.down = false; });
  canvas.addEventListener("pointerleave", () => { mouse.down = false; });

  const shader = (type, src) => {
    const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = (gl.getShaderInfoLog(sh) ?? "shader error").trim().split("\n").slice(0, 3).join("\n");
      gl.deleteShader(sh); throw new Error(log);
    }
    return sh;
  };
  function build(pass) {
    const vs = shader(gl.VERTEX_SHADER, VERT);
    const fs = shader(gl.FRAGMENT_SHADER, `${HEADER()}\n${passes.Common ?? ""}\n${passes[pass] ?? ""}\n${BODY}`);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link failed");
    gl.deleteShader(vs); gl.deleteShader(fs);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    // the program must be CURRENT before its uniforms can be set: without this the sampler bindings were
    // rejected with INVALID_OPERATION ("location is not from the associated program") and every iChannel read
    // whatever texture unit happened to be left over
    gl.useProgram(prog);
    for (const i of [0, 1, 2, 3]) {
      const loc = gl.getUniformLocation(prog, `iChannel${i}`);
      if (loc) gl.uniform1i(loc, i);      // null when the shader does not use that channel: nothing to bind
    }
    programs.set(pass, { prog, u: {
      res: gl.getUniformLocation(prog, "iResolution"), time: gl.getUniformLocation(prog, "iTime"),
      delta: gl.getUniformLocation(prog, "iTimeDelta"), frame: gl.getUniformLocation(prog, "iFrame"),
      mouse: gl.getUniformLocation(prog, "iMouse"), level: gl.getUniformLocation(prog, "iAudioLevel"),
      rate: gl.getUniformLocation(prog, "iFrameRate"), date: gl.getUniformLocation(prog, "iDate"),
      sampleRate: gl.getUniformLocation(prog, "iSampleRate"), chTime: gl.getUniformLocation(prog, "iChannelTime"),
      chRes: gl.getUniformLocation(prog, "iChannelResolution"),
      // what the shader itself declares -- nothing else is known, and nothing is invented
      declared: (() => {
        const out = new Map();
        const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i++) {
          const info = gl.getActiveUniform(prog, i);
          if (!info) continue;
          const name = info.name.replace(/\[0\]$/, "");
          out.set(name, { loc: gl.getUniformLocation(prog, name), size: info.size, type: info.type });
        }
        return out;
      })(),
    } });
  }
  /**
   * A pass's two textures: the one this frame READS (last frame's output) and the one it WRITES. Shadertoy's
   * feedback -- a Buffer reading its own iChannel0 to accumulate -- is the reason: reading and writing one
   * texture in the same pass is undefined, and it is how "everything is black, or noise" happens.
   */
  function targetFor(pass, w, h) {
    const t = targets.get(pass);
    if (t && t.w === w && t.h === h) return t;
    if (t) { for (const k of ["read", "write"]) { gl.deleteFramebuffer(t[k].fb); gl.deleteTexture(t[k].tex); } }
    const make = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { fb, tex };
    };
    const made = { read: make(), write: make(), w, h };
    // both start black, so a pass that reads before anything has drawn reads black rather than garbage
    for (const k of ["read", "write"]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, made[k].fb);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    targets.set(pass, made); return made;
  }
  const onePixel = (r, g, b) => {
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, 255]));
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR);
    return tex;
  };

  /** The engine's own signal: the analyser sits where the app's scope reads, so a shader sees what is heard. */
  function attachAudio() {
    try {
      const engine = globalThis.sonicPi?.engine, ctx = engine?.audioContext, node = engine?.node;
      if (!ctx || !node || analyser) return false;
      analyser = ctx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.6;
      node.connect(analyser);
      wave = new Uint8Array(analyser.frequencyBinCount);
      spectrum = new Uint8Array(analyser.frequencyBinCount);
      audioTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, audioTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 512, 2, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(1024));
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR);
      onSay?.("listening to the engine: iAudioLevel and the audio channels are live");
      return true;
    } catch (e) { onSay?.(`could not listen to the engine: ${e?.message ?? e}`); return false; }
  }
  function updateAudio() {
    if (!analyser) { attachAudio(); return; }
    analyser.getByteFrequencyData(spectrum);
    analyser.getByteTimeDomainData(wave);
    const row = new Uint8Array(1024);
    row.set(spectrum.subarray(0, 512), 0);
    row.set(wave.subarray(0, 512), 512);
    gl.bindTexture(gl.TEXTURE_2D, audioTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 2, gl.LUMINANCE, gl.UNSIGNED_BYTE, row);
    let sum = 0;
    for (let i = 0; i < 512; i++) { const v = (wave[i] - 128) / 128; sum += v * v; }
    level = Math.sqrt(sum / 512);
  }

  function resize() {
    const dpr = Math.min(globalThis.devicePixelRatio ?? 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  function bindChannel(i) {
    const ch = channels[i] ?? { kind: "none" };
    if (ch.kind === "buffer") {
      const t = targets.get(ch.buffer);
      if (t) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t.read.tex); return; }
    } else if (ch.kind === "image" && ch.data) {
      let tex = imageCache.get(ch.data);
      if (!tex) {
        tex = gl.createTexture(); imageCache.set(ch.data, tex);
        const img = new Image();
        img.onload = () => {
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR);
          for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
        };
        img.src = ch.data;
      }
      gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex); return;
    } else if (ch.kind === "audio" && audioTex) {
      gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, audioTex); return;
    }
    blackTex ??= onePixel(0, 0, 0);
    gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, blackTex);
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    if (document.body.dataset.gfxCanvas === HIDDEN) return;    // hidden is a display state; the loop runs on
    const now = performance.now();
    const deltaMs = now - prev;
    updateAudio(); resize();
    if (deltaMs > 0 && deltaMs < 1000) { frameTimes.push(deltaMs); if (frameTimes.length > 60) frameTimes.shift(); }
    rate = frameTimes.length ? 1000 / (frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length) : 0;
    sampleRate = globalThis.sonicPi?.engine?.audioContext?.sampleRate ?? sampleRate;
    const nowDate = new Date();
    date[0] = nowDate.getFullYear(); date[1] = nowDate.getMonth(); date[2] = nowDate.getDate();
    date[3] = nowDate.getHours() * 3600 + nowDate.getMinutes() * 60 + nowDate.getSeconds();
    for (let i = 0; i < 4; i++) {
      const ch = channels[i] ?? { kind: "none" };
      const t = ch.kind === "buffer" ? targets.get(ch.buffer) : null;
      channelResolution[i * 3] = t ? t.w : ch.kind === "audio" ? 512 : 0;
      channelResolution[i * 3 + 1] = t ? t.h : ch.kind === "audio" ? 2 : 0;
      channelResolution[i * 3 + 2] = 1;
      channelTime[i] = frames / 60;
    }
    for (const pass of PASS_ORDER) {
      if (!(passes[pass] ?? "").trim() || !programs.has(pass)) continue;
      const { prog, u } = programs.get(pass);
      if (pass === "Image") { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); }
      else { const t = targetFor(pass, canvas.width, canvas.height); gl.bindFramebuffer(gl.FRAMEBUFFER, t.write.fb); gl.viewport(0, 0, t.w, t.h); }
      gl.useProgram(prog);
      gl.uniform3f(u.res, canvas.width, canvas.height, 1);
      gl.uniform1f(u.time, (now - t0) / 1000);
      gl.uniform1f(u.delta, (now - prev) / 1000);
      gl.uniform1i(u.frame, frames);
      gl.uniform4f(u.mouse, mouse.x, mouse.y, mouse.down ? mouse.downX : -mouse.downX, mouse.downY);
      gl.uniform1f(u.level, level);
      gl.uniform1f(u.rate, rate);
      gl.uniform1f(u.sampleRate, sampleRate);
      gl.uniform4f(u.date, date[0], date[1], date[2], date[3]);
      gl.uniform1fv(u.chTime, channelTime);
      gl.uniform3fv(u.chRes, channelResolution);
      // "sent to every pass that declares it -- and to none that does not" (the old layer's own words)
      for (const [name, d] of u.declared) {
        if (SHADERTOY_UNIFORMS.has(name)) continue;         // the host's own, set above
        const set = values.get(name);
        if (!set || !d.loc) continue;
        const v = set.value;
        if (v.length === 1) gl.uniform1f(d.loc, v[0]);
        else if (v.length === 2) gl.uniform2f(d.loc, v[0], v[1]);
        else if (v.length === 3) gl.uniform3f(d.loc, v[0], v[1], v[2]);
        else gl.uniform4f(d.loc, v[0], v[1], v[2], v[3]);
      }
      for (const i of [0, 1, 2, 3]) bindChannel(i);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    // this frame's output becomes next frame's input: without the swap a pass reading itself would sample the
    // texture it is writing into
    for (const t of targets.values()) { const tmp = t.read; t.read = t.write; t.write = tmp; }
    prev = now; frames++;
  }
  const ensureLoop = () => { if (!raf) loop(); };

  /** Take the editor's model: every pass's code and the channels. Compiles what is there. */
  function setPasses(next = {}, nextChannels = []) {
    passes = { Common: next.Common ?? "", ...Object.fromEntries(PASS_ORDER.map((p) => [p, next[p] ?? ""])) };
    channels = nextChannels ?? [];
    programs.clear();
    const failed = [];
    for (const pass of PASS_ORDER) {
      if (!(passes[pass] ?? "").trim()) continue;
      try { build(pass); } catch (e) { failed.push(`${pass}: ${e.message}`); }
    }
    const ok = [...programs.keys()];
    lastError = failed.length ? failed.join("\n") : null;
    if (ok.length) ensureLoop();
    onSay?.(failed.length ? `compiled ${ok.length}; did not compile:\n${lastError}`
      : (ok.length ? `compiled ${ok.length} pass(es): ${ok.join(", ")}` : "no pass has any code yet"));
    return { ok, failed };
  }

  /**
   * A value from the music: `:gfx, :name, 1` .. `:gfx, :name, 1, 2, 3, 4`.
   *
   * The shader declares its own uniforms -- any names the player likes -- and a value goes to every pass that
   * declares that name and to no pass that does not. If NO pass declares it, that is an error worth saying out
   * loud (the old layer's own wording: `no pass declares "name"`), because otherwise a typo in a live loop is
   * indistinguishable from a shader that ignores it.
   */
  function setVariable(name, value, shape = null) {
    const n = String(name).replace(/[^A-Za-z0-9_]/g, "");
    if (!n) return false;
    const v = (Array.isArray(value) ? value : [value]).map(Number).filter((x) => Number.isFinite(x));
    if (!v.length || v.length > 4) {
      lastError = `${n}: ${v.length} values, but a uniform takes at most 4`;
      onSay?.(lastError, true); console.info(`Shadertoy — ${lastError}`);
      return false;
    }
    const want = shape ?? (v.length === 1 ? "float" : `vec${v.length}`);
    if (SHADERTOY_UNIFORMS.has(n)) {                   // the frame's own values are not a program's to set
      lastError = `"${n}" is one of the frame's own values, not one a program sets`;
      onSay?.(lastError, true); console.info(`Shadertoy — ${lastError}`);
      return false;
    }

    const took = [], refused = [];
    for (const [pass, p] of programs) {
      const d = p.u.declared.get(n);
      if (!d) continue;                                // "sent to every pass that declares it -- and to none that does not"
      const glType = GLSL_TYPE()[d.type];
      // a vec2 wants exactly 2, a vec3 exactly 3, a vec4 exactly 4; float/int/bool accept each other
      if (!fits(glType, want)) { refused.push(`${pass}: ${n} is ${glType}, given ${want}`); continue; }
      took.push(pass);
    }
    if (took.length) {
      // remembered only when it was TAKEN, as the old layer does (`if (took) remembered.set(...)`): a value that
      // fits nothing must not replace a good one a pass is still using
      values.set(n, { value: v, shape: want });
      lastError = refused.length ? `"${n}" was set, but not everywhere: ${refused.join("; ")}` : null;
      if (refused.length) { onSay?.(lastError, true); console.info(`Shadertoy — ${lastError}`); }
      return true;
    }
    if (refused.length) { lastError = refused[0]; onSay?.(lastError, true); console.info(`Shadertoy — ${lastError}`); return false; }
    lastError = `no pass declares "${n}"`;
    onSay?.(`${lastError} — the value is kept, and will be used by any pass that does after a compile`);
    console.info(`Shadertoy — ${lastError}`);
    return false;
  }

  const seen = [];
  /** The same path as a record, for anyone calling it directly (a probe, the console). */
  function applyDirectives(text) {
    const d = parseDirective(String(text));
    if (!d.ok || d.command) return [];
    return setVariable(d.name, d.values, d.shape) ? [[d.name, d.values]] : [];
  }

  function record(r) {
    const text = typeof r === "string" ? r : (r?.text ?? r?.message ?? r?.output ?? "");
    if (!/^\s*:?gfx/i.test(String(text).trim())) return false;
    const d = parseDirective(String(text));
    if (!d.ok) {                                  // never silent: the parser's own words
      onSay?.(`the music said something I could not read: ${d.error}`);
      console.info(`Shadertoy — ${d.error}`);
      seen.push({ text: String(text).slice(0, 120), error: d.error });
      if (seen.length > 6) seen.shift();
      return false;
    }
    if (d.command === "document") {                // which set is on screen: not wired to the canvas yet
      onSay?.(`the music asked for the "${d.arg}" set (not wired to the canvas yet)`);
      seen.push({ text: String(text).slice(0, 120), command: "document", arg: d.arg });
      if (seen.length > 6) seen.shift();
      return false;
    }
    const ok = setVariable(d.name, d.values, d.shape);
    seen.push({ text: String(text).slice(0, 120), name: d.name, values: d.values, ok });
    if (seen.length > 6) seen.shift();
    if (d.verbose || !ok) {                        // :gfxv says each one, and a failure always does
      const line = ok ? `${d.name} = ${d.values.join(", ")}` : `${d.name}: ${d.error ?? "not usable"}`;
      onSay?.(`from the music: ${line}`);
      console.info(`Shadertoy — from the music: ${line}`);
    }
    return ok;
  }

  globalThis.sonicPiGfx = Object.assign(globalThis.sonicPiGfx ?? {}, { record, canvas });

  const btn = document.createElement("button");
  btn.id = "gfx-canvas-btn";
  btn.type = "button";
  btn.addEventListener("click", () => set(ORDER[(ORDER.indexOf(state) + 1) % ORDER.length]));
  document.body.appendChild(btn);
  // ALWAYS preview on load, never restored: a remembered "hidden" is a black rectangle nobody can explain,
  // and remembering it is how this project already lost an interface once. The state is per session.
  let state = PREVIEW;
  const LABEL = { [PREVIEW]: "Preview", [FULL]: "Fullscreen", [HIDDEN]: "Hidden" };
  function set(next) {
    if (!ORDER.includes(next)) return false;
    state = next;
    document.body.dataset.gfxCanvas = state;
    btn.dataset.state = state; btn.textContent = LABEL[state];
    btn.title = `the rendered picture: ${LABEL[state].toLowerCase()} — click to change (preview / fullscreen / hidden)`;
    resize(); return true;
  }
  set(state);

  return { canvas, button: btn, setPasses, setVariable, record, applyDirectives, seen: () => [...seen],
    audio: () => ({ attached: !!analyser, level: Number(level.toFixed(4)), samples: !!audioTex }),
    /** What drawing costs, for the status line: frames per second, milliseconds a frame, and the GPU time when
     *  the browser is willing to give one (it usually is not -- then it says null rather than inventing a
     *  number, which is the only honest thing a readout can do). */
    perf: () => ({
      fps: Number(rate.toFixed(1)),
      ms: rate > 0 ? Number((1000 / rate).toFixed(2)) : null,
      frames,
      gpuMs: null,
      passed: [...programs.keys()].length,
    }),
    /**
     * What the canvas is showing, as data: the size, a mean brightness and a PNG data URL. The old layer had
     * this (probes and a "save the picture" both used it) and it is the only way to assert on a picture without
     * looking at it.
     */
    capture: ({ scale = 1 } = {}) => {
      const w = Math.max(1, Math.round(canvas.width * scale));
      const h = Math.max(1, Math.round(canvas.height * scale));
      const off = document.createElement("canvas");
      off.width = w; off.height = h;
      const ctx = off.getContext("2d");
      ctx.drawImage(canvas, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
      return { width: w, height: h, mean: sum / (w * h) / 255, dataUrl: off.toDataURL("image/png") };
    },
    mouse: () => ({ ...mouse }),
    get usable() { return [...new Set([...programs.values()].flatMap((p) => [...p.u.declared.keys()]))].filter((n) => !SHADERTOY_UNIFORMS.has(n)); },
    variables: () => Object.fromEntries([...values].map(([n, v]) => [n, v.value])),
    declared: () => [...new Set([...programs.values()].flatMap((p) => [...p.u.declared.keys()]))].filter((n) => !SHADERTOY_UNIFORMS.has(n)),
    state: () => state, set, next: () => set(ORDER[(ORDER.indexOf(state) + 1) % ORDER.length]),
    lastError: () => lastError, compiled: () => [...programs.keys()] };
}
