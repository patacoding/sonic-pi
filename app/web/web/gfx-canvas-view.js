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
export const PREVIEW = "preview";
export const FULL = "fullscreen";
export const HIDDEN = "hidden";
const ORDER = [PREVIEW, FULL, HIDDEN];
export const PASS_ORDER = ["Buffer A", "Buffer B", "Buffer C", "Buffer D", "Image"];

const VERT = `#version 300 es
in vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }`;
const HEADER = (extra = "") => `#version 300 es
precision highp float;
precision highp int;
uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform int iFrame;
uniform vec4 iMouse;
uniform float iAudioLevel;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
${extra}
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
  #gfx-canvas-btn { position: fixed; right: 0; top: calc(50% + 58px); transform: translateY(-50%); z-index: 101;
    writing-mode: vertical-rl; padding: 10px 6px; cursor: pointer; font: 12px/1 system-ui, sans-serif;
    letter-spacing: .04em; color: var(--WindowForeground); border: 1px solid var(--WindowBorder); border-right: 0;
    border-radius: 8px 0 0 8px; background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); }
  #gfx-canvas-btn:hover { background: color-mix(in srgb, var(--WindowBackground) 78%, transparent); }
  #gfx-canvas-btn[data-state="fullscreen"] { border-color: #f80; }
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
  const extra = new Map();                 // uniforms the music set
  const programs = new Map(), targets = new Map(), imageCache = new Map();
  let blackTex = null, audioTex = null, analyser = null, wave = null, spectrum = null, level = 0;

  const shader = (type, src) => {
    const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = (gl.getShaderInfoLog(sh) ?? "shader error").trim().split("\n").slice(0, 3).join("\n");
      gl.deleteShader(sh); throw new Error(log);
    }
    return sh;
  };
  function build(pass) {
    const decl = [...extra.keys()].map((n) => `uniform float ${n};`).join("\n");
    const vs = shader(gl.VERTEX_SHADER, VERT);
    const fs = shader(gl.FRAGMENT_SHADER, `${HEADER(decl)}\n${passes.Common ?? ""}\n${passes[pass] ?? ""}\n${BODY}`);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link failed");
    gl.deleteShader(vs); gl.deleteShader(fs);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const i of [0, 1, 2, 3]) gl.uniform1i(gl.getUniformLocation(prog, `iChannel${i}`), i);
    programs.set(pass, { prog, u: {
      res: gl.getUniformLocation(prog, "iResolution"), time: gl.getUniformLocation(prog, "iTime"),
      delta: gl.getUniformLocation(prog, "iTimeDelta"), frame: gl.getUniformLocation(prog, "iFrame"),
      mouse: gl.getUniformLocation(prog, "iMouse"), level: gl.getUniformLocation(prog, "iAudioLevel"),
      extra: new Map([...extra.keys()].map((n) => [n, gl.getUniformLocation(prog, n)])),
    } });
  }
  function targetFor(pass, w, h) {
    const t = targets.get(pass);
    if (t && t.w === w && t.h === h) return t;
    if (t) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const made = { fb, tex, w, h }; targets.set(pass, made); return made;
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
      if (t) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t.tex); return; }
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
    updateAudio(); resize();
    for (const pass of PASS_ORDER) {
      if (!(passes[pass] ?? "").trim() || !programs.has(pass)) continue;
      const { prog, u } = programs.get(pass);
      if (pass === "Image") { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); }
      else { const t = targetFor(pass, canvas.width, canvas.height); gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.viewport(0, 0, t.w, t.h); }
      gl.useProgram(prog);
      gl.uniform3f(u.res, canvas.width, canvas.height, 1);
      gl.uniform1f(u.time, (now - t0) / 1000);
      gl.uniform1f(u.delta, (now - prev) / 1000);
      gl.uniform1i(u.frame, frames);
      gl.uniform4f(u.mouse, 0, 0, 0, 0);
      gl.uniform1f(u.level, level);
      for (const [name, loc] of u.extra) if (loc) gl.uniform1f(loc, extra.get(name) ?? 0);
      for (const i of [0, 1, 2, 3]) bindChannel(i);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
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

  /** A variable from the audio side: `puts :gfx, :set, :name, 0.5` in the music. */
  function setVariable(name, value) {
    const n = String(name).replace(/[^A-Za-z0-9_]/g, "");
    if (!n) return false;
    extra.set(n, Number(value) || 0);
    programs.clear();
    for (const pass of PASS_ORDER) if ((passes[pass] ?? "").trim()) { try { build(pass); } catch (e) { lastError = String(e.message ?? e); } }
    return true;
  }

  /** The app hands records to whoever is at window.sonicPiGfx: this is the audio side's way in. */
  function record(r) {
    const text = typeof r === "string" ? r : (r?.text ?? r?.message ?? "");
    const m = /:gfx\w*\s*,\s*:set\s*,\s*:([A-Za-z_][A-Za-z0-9_]*)\s*,\s*(-?[\d.]+)/.exec(text);
    if (m) setVariable(m[1], Number(m[2]));
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

  return { canvas, button: btn, setPasses, setVariable, record,
    audio: () => ({ attached: !!analyser, level: Number(level.toFixed(4)), samples: !!audioTex }),
    variables: () => Object.fromEntries(extra),
    state: () => state, set, next: () => set(ORDER[(ORDER.indexOf(state) + 1) % ORDER.length]),
    lastError: () => lastError, compiled: () => [...programs.keys()] };
}
