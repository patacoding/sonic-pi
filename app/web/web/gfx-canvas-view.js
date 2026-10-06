// The render canvas: the Image pass and Common, turned into a real WebGL shader, in three display states.
//
// Self-contained like the editor -- no imports, no bundle -- because the previous canvas lived inside the layer
// that kept hiding the audio interface, and that is not a thing to bring back. This one is a canvas, one button
// and a render loop:
//
//   preview     bottom right, a quarter of the window in each direction
//   fullscreen  the whole window
//   hidden      nothing on screen; the loop keeps running, so coming back is instant
//
// The button sits at the right edge, halfway down, BELOW the editor's button. Compiling in the editor hands the
// code here (Image is the pass that draws the screen, Common is prepended, as Shadertoy does it); a compile that
// does not compile says so and leaves the last working shader on screen.
export const PREVIEW = "preview";
export const FULL = "fullscreen";
export const HIDDEN = "hidden";
const ORDER = [PREVIEW, FULL, HIDDEN];

const VERT = `#version 300 es
in vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }`;

/** Shadertoy's header: what a shader is allowed to expect from the host. */
const HEADER = `#version 300 es
precision highp float;
precision highp int;
uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform int iFrame;
uniform vec4 iMouse;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
out vec4 sp_out;
`;

const BODY = `
void main() {
  vec4 c = vec4(0.0, 0.0, 0.0, 1.0);
  mainImage(c, gl_FragCoord.xy);
  sp_out = c;
}`;

const STYLE = `
  #gfx-canvas { position: fixed; z-index: 94; background: #000; display: block; }
  body[data-gfx-canvas="preview"] #gfx-canvas { inset: auto 8px 8px auto; width: 25vw; height: 25vh;
    border: 1px solid var(--WindowBorder); border-radius: 8px; box-shadow: 0 6px 24px rgb(0 0 0 / 35%); }
  body[data-gfx-canvas="fullscreen"] #gfx-canvas { inset: 0; width: 100vw; height: 100vh; border: 0; border-radius: 0; }
  body[data-gfx-canvas="hidden"] #gfx-canvas { display: none !important; }

  #gfx-canvas-btn { position: fixed; right: 0; top: calc(50% + 58px); transform: translateY(-50%); z-index: 99;
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
  let prog = null, uniforms = null, raf = 0;
  const t0 = performance.now();
  let frames = 0, lastError = null, lastGoodSource = null;

  const compileShader = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) ?? "unknown shader error";
      gl.deleteShader(sh);
      throw new Error(log.trim().split("\n").slice(0, 3).join("\n"));
    }
    return sh;
  };

  function build(userSource) {
    const vs = compileShader(gl.VERTEX_SHADER, VERT);
    const fs = compileShader(gl.FRAGMENT_SHADER, `${HEADER}\n${userSource}\n${BODY}`);
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link failed");
    gl.deleteShader(vs); gl.deleteShader(fs);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    prog = p;
    uniforms = {
      res: gl.getUniformLocation(p, "iResolution"),
      time: gl.getUniformLocation(p, "iTime"),
      delta: gl.getUniformLocation(p, "iTimeDelta"),
      frame: gl.getUniformLocation(p, "iFrame"),
      mouse: gl.getUniformLocation(p, "iMouse"),
    };
    for (const i of [0, 1, 2, 3]) gl.uniform1i(gl.getUniformLocation(p, `iChannel${i}`), i);
  }

  function resize() {
    const dpr = Math.min(globalThis.devicePixelRatio ?? 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  let prev = performance.now();
  function loop() {
    raf = requestAnimationFrame(loop);
    if (document.body.dataset.gfxCanvas === HIDDEN) return;      // hidden is a display state: the loop runs on
    resize();
    const now = performance.now();
    gl.useProgram(prog);
    gl.uniform3f(uniforms.res, canvas.width, canvas.height, 1);
    gl.uniform1f(uniforms.time, (now - t0) / 1000);
    gl.uniform1f(uniforms.delta, (now - prev) / 1000);
    gl.uniform1i(uniforms.frame, frames);
    gl.uniform4f(uniforms.mouse, 0, 0, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    frames++; prev = now;
  }

  /** Compile the Image pass (with Common in front of it, as Shadertoy does) and show it. */
  function setCode({ image = "", common = "" } = {}) {
    const source = `${common}\n${image}`;
    if (!/void\s+mainImage\s*\(/.test(image)) { lastError = "the Image pass has no void mainImage(out vec4 c, in vec2 p)"; onSay?.(lastError); return false; }
    try {
      build(source);
      lastGoodSource = source; lastError = null; frames = 0;
      if (!raf) loop();
      onSay?.("shader compiled: the picture is live");
      return true;
    } catch (e) {
      lastError = String(e?.message ?? e);
      onSay?.(`the shader did not compile, so the last working one stays on screen:\n${lastError}`);
      return false;
    }
  }

  const btn = document.createElement("button");
  btn.id = "gfx-canvas-btn";
  btn.type = "button";
  btn.addEventListener("click", () => set(ORDER[(ORDER.indexOf(state) + 1) % ORDER.length]));
  document.body.appendChild(btn);

  let state = (() => { try { const v = store?.getItem("sp-gfx-canvas"); return ORDER.includes(v) ? v : PREVIEW; } catch { return PREVIEW; } })();
  const LABEL = { [PREVIEW]: "Preview", [FULL]: "Fullscreen", [HIDDEN]: "Hidden" };
  function set(next) {
    if (!ORDER.includes(next)) return false;
    state = next;
    try { store?.setItem("sp-gfx-canvas", state); } catch {}
    document.body.dataset.gfxCanvas = state;
    btn.dataset.state = state;
    btn.textContent = LABEL[state];
    btn.title = `the rendered picture: ${LABEL[state].toLowerCase()} — click to change (preview / fullscreen / hidden)`;
    resize();
    return true;
  }
  set(state);

  return { canvas, button: btn, setCode, state: () => state, set, next: () => set(ORDER[(ORDER.indexOf(state) + 1) % ORDER.length]), lastError: () => lastError };
}
