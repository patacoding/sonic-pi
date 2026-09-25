// SPDX-License-Identifier: AGPL-3.0-or-later
// The lower layer: a WebGL2 canvas behind the interface, the shader, and the uniforms.
//
// This half knows about GL and nothing about Sonic Pi. What it offers upwards is
//   createCanvas({ source, onProblem })  -> { set, setIfPresent, uniforms, destroy }
// where `set` is told a name and a value list, decides whether the shader declared a uniform
// that can hold them, and uploads it. Whether that name came from a player's `puts` or from the
// audio tap is not its business.
//
// Two things it does NOT do, on purpose:
//
//   * It does not trust the shader's SOURCE for the uniform list. A declared-but-unused uniform
//     is not in `glGetActiveUniform` at all -- measured on the desktop side, where a program
//     declared `uUnused` and the driver never reported it (see dev-discipline.md §7). Reading
//     the source would "find" uniforms the linker threw away, and the player would be told a
//     name was accepted when nothing could ever receive it. The list comes from the link.
//   * It does not silently coerce a value that does not fit. `fits()` in gfx-directive.js says
//     yes or no; a no travels back as an error the player is shown.
//
// The shader's shape is Shadertoy's: the player writes `mainImage(out vec4, in vec2)` and the
// prelude declares the frame's own values. Those are declared only if the player has not
// declared them, so a shader that spells out `uniform float iTime;` still compiles.

import { fits } from "./gfx-directive.js";

const VERT = `#version 300 es
// a full-screen triangle from gl_VertexID: no buffers, no attributes, one draw
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// What the page's own values are, as Shadertoy names them. `iChannel*` is absent: there are no
// textures to sample yet, and declaring a sampler that is never set is worse than not offering it.
const BUILTINS = [
  ["float", "iTime"],        // seconds since the first frame
  ["float", "iTimeDelta"],   // the last frame's own duration
  ["int", "iFrame"],         // frames drawn
  ["vec3", "iResolution"],   // x, y, and 1.0 (Shadertoy's pixelAspect is always 1 here)
  ["vec4", "iMouse"],        // xy the pointer, zw the press, as Shadertoy has them
  ["vec4", "iDate"],         // year, month, day, seconds
  ["float", "iSampleRate"],
];

// glGetActiveUniform's type enum -> the name gfx-directive.js reasons in.
const GL_TYPES = new Map([
  [0x1406, "float"], [0x1404, "int"], [0x8b56, "bool"],
  [0x8b50, "vec2"], [0x8b51, "vec3"], [0x8b52, "vec4"],
]);

/**
 * The fragment shader: the prelude, the player's source, and the entry point GLSL wants.
 * Returns the source and how many lines the player's own code starts at, so a driver's
 * `ERROR: 0:<line>` can be reported against the line the player wrote.
 */
export function assemble(source) {
  const declared = BUILTINS
    .filter(([, name]) => !new RegExp(`\\buniform\\s+\\w+\\s+${name}\\b`).test(source))
    .map(([type, name]) => `uniform ${type} ${name};`)
    .join("\n");
  const head = [
    "#version 300 es",
    "precision highp float;",
    "precision highp int;",
    ...(declared ? declared.split("\n") : []),
    "out vec4 spFragColor;",
    "",
  ];
  const tail = [
    "",
    "void main() {",
    "  vec4 c = vec4(0.0, 0.0, 0.0, 1.0);",
    "  mainImage(c, gl_FragCoord.xy);",
    "  spFragColor = c;",
    "}",
  ];
  return { shader: [...head, source, ...tail].join("\n"), offset: head.length };
}

/** A compile or link log with the prelude's own lines rebased onto the player's code. */
function report(text, offset) {
  return String(text).trim().split("\n").map((line) => {
    const m = /^(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/.exec(line.trim());
    if (!m) return line.trim();
    const own = Number(m[1]) - offset;
    return own > 0 ? `line ${own}: ${m[2]}` : `in the prelude: ${m[2]}`;
  }).filter(Boolean).join("\n");
}

/**
 * A canvas behind the interface, drawing `source` every frame.
 *
 * @param {{source: string, onProblem?: (text: string) => void, alpha?: () => number}} opts
 */
export function createCanvas({ source, onProblem = () => {} }) {
  const canvas = document.createElement("canvas");
  canvas.id = "gfx-canvas";
  const gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: "low-power" });
  if (!gl) {
    onProblem("this browser has no WebGL2, so the shader canvas cannot run");
    return null;
  }

  const { shader, offset } = assemble(source);

  const program = gl.createProgram();
  for (const [type, text] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, shader]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, text);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      onProblem(`the shader did not compile.\n${report(gl.getShaderInfoLog(sh), offset)}`);
      return null;
    }
    gl.attachShader(program, sh);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    onProblem(`the shader did not link.\n${report(gl.getProgramInfoLog(program), offset)}`);
    return null;
  }
  gl.useProgram(program);

  // The link's own word on what can be set: see the header on why this, not the source.
  const uniforms = new Map();
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, "");          // uBands[0] is how an array is reported
    const type = GL_TYPES.get(info.type);
    uniforms.set(name, { type: type ?? null, size: info.size, location: gl.getUniformLocation(program, info.name) });
  }
  const usable = [...uniforms].filter(([, u]) => u.type).map(([n]) => n);

  const state = {
    time: 0, delta: 0, frame: 0, w: 1, h: 1,
    mouse: [0, 0, 0, 0],          // x, y, down-x, down-y — Shadertoy's convention
    down: false,
  };
  const bands = [0, 0, 0, 0];
  let raf = 0, last = 0, disposed = false;
  const dates = new Float32Array(4);

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);   // 2 is plenty: a background, not a game
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    state.w = w; state.h = h;
  }

  function upload(name, values) {
    const u = uniforms.get(name);
    if (!u || !u.type) return { ok: false, error: `the running shader declares no uniform "${name}"` };
    const shape = values.length === 1
      ? (typeof values[0] === "boolean" ? "bool" : Number.isInteger(values[0]) ? "int" : "float")
      : `vec${values.length}`;
    if (!fits(u.type, shape)) {
      return { ok: false, error: `"${name}" is ${u.type} in the shader, but ${shape} (${values.length} value${values.length > 1 ? "s" : ""}) was given` };
    }
    switch (u.type) {
      case "float": gl.uniform1f(u.location, Number(values[0])); break;
      case "int": gl.uniform1i(u.location, Math.round(Number(values[0]))); break;
      case "bool": gl.uniform1i(u.location, values[0] ? 1 : 0); break;
      case "vec2": gl.uniform2fv(u.location, values.slice(0, 2)); break;
      case "vec3": gl.uniform3fv(u.location, values.slice(0, 3)); break;
      case "vec4": gl.uniform4fv(u.location, values.slice(0, 4)); break;
    }
    return { ok: true };
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

    const d = new Date();
    dates[0] = d.getFullYear(); dates[1] = d.getMonth() + 1; dates[2] = d.getDate();
    dates[3] = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();

    setBuiltin("iTime", [state.time]);
    setBuiltin("iTimeDelta", [state.delta]);
    setBuiltin("iFrame", [state.frame]);
    setBuiltin("iResolution", [state.w, state.h, 1]);
    setBuiltin("iMouse", state.mouse);
    setBuiltin("iDate", dates);
    setBuiltin("iSampleRate", [sampleRate()]);

    feed?.(state.time, state.delta);     // the upper layer's own values (the audio), before the draw
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // A built-in is ours to set: never reported as an error, since the shader not using it is normal.
  function setBuiltin(name, values) {
    const u = uniforms.get(name);
    if (!u || !u.type) return;
    switch (u.type) {
      case "float": gl.uniform1f(u.location, values[0]); break;
      case "int": gl.uniform1i(u.location, values[0]); break;
      case "vec3": gl.uniform3fv(u.location, values); break;
      case "vec4": gl.uniform4fv(u.location, values); break;
    }
  }

  let sampleRate = () => 48000;
  let feed = null;

  // The pointer, from the window: the canvas is behind the interface, so it is never the target.
  const move = (e) => { state.mouse[0] = e.clientX; state.mouse[1] = canvas.clientHeight - e.clientY; };
  const down = (e) => { state.down = true; move(e); state.mouse[2] = state.mouse[0]; state.mouse[3] = state.mouse[1]; };
  const up = () => { state.down = false; };
  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("pointerdown", down, { passive: true });
  window.addEventListener("pointerup", up, { passive: true });

  raf = requestAnimationFrame(frame);

  return {
    canvas,
    uniforms,
    usable,
    set: (name, values) => upload(name, values),
    /** For our own feeds (the audio): a shader that does not want them is not a mistake. */
    setIfPresent: (name, values) => { const u = uniforms.get(name); if (u?.type) upload(name, values); },
    onFeed: (fn) => { feed = fn; },
    setSampleRate: (fn) => { sampleRate = fn; },
    bands,
    destroy() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      canvas.remove();
    },
  };
}
