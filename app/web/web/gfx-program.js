// SPDX-License-Identifier: AGPL-3.0-or-later
// One pass's fragment program, swapped at runtime and never left broken.
//
// This is the piece that makes an editor possible at all. Until now the shader was compiled once, at
// startup, from a file -- changing it meant reloading the page. An editor has to compile WHILE the
// picture is on screen, and that means a compile can fail while something is being drawn. What must
// hold then is the desktop side's rule (docs/shader-buffer-design.md): a failed compile reports and
// changes NOTHING -- the program that is running carries on running. A black canvas on a typo, in
// front of an audience, is the failure this file exists to prevent.
//
// It is also the piece that decides where a line number points. A pass's source is not what GLSL
// compiles: a prelude of built-ins is put in front of it (assemble, below), and in the Shadertoy
// structure a shared Common block goes in front of that. So a driver's "ERROR: 0:37" has to be
// rebased onto the lines the player actually wrote -- and, when the error is in Common, said to be in
// Common rather than in this pass. `report` does the rebasing; the caller says which block it is.
//
// And a recompile must not throw away what is already set. The player has sent `puts :gfx, :uGain,
// 0.5`; a recompile that forgot it would make every edit reset the look of the piece. So values live
// in this object, keyed by name, and are re-applied after a successful swap to whatever the new
// program still declares.

import { fits } from "./gfx-directive.js";

const VERT = `#version 300 es
// a full-screen triangle from gl_VertexID: no buffers, no attributes, one draw
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// What the page's own values are, as Shadertoy names them. `iChannel*` is NOT here: a channel is a
// sampler whose texture the renderer binds, so it is declared by whichever pass wants it and the
// renderer tells it which unit to read.
const BUILTINS = [
  { type: "float", name: "iTime" },        // seconds since the first frame
  { type: "float", name: "iTimeDelta" },   // the last frame's own duration
  { type: "int", name: "iFrame" },         // frames drawn
  { type: "vec3", name: "iResolution" },   // x, y, and 1.0 (Shadertoy's pixelAspect is always 1 here)
  // xy the pointer, zw the press -- and NEGATED while dragging, as Shadertoy has it
  { type: "vec4", name: "iMouse" },
  { type: "vec4", name: "iDate" },         // year, month, day, seconds
  { type: "float", name: "iSampleRate" },
  // The channels are declared HERE, not left to each pass, because Shadertoy's shaders use
  // `texture(iChannel0, uv)` without declaring anything -- a ported shader that did not compile
  // would be a shader that "does not work on the web" for no good reason. Which texture each one
  // reads is the renderer's business, per pass.
  { type: "sampler2D", name: "iChannel0" },
  { type: "sampler2D", name: "iChannel1" },
  { type: "sampler2D", name: "iChannel2" },
  { type: "sampler2D", name: "iChannel3" },
  // an array: declared with its size, deduped (and looked up) by the base name
  { type: "vec3", name: "iChannelResolution[4]", base: "iChannelResolution" },
];

// glGetActiveUniform's type enum -> the name gfx-directive.js reasons in.
const GL_TYPES = new Map([
  [0x1406, "float"], [0x1404, "int"], [0x8b56, "bool"],
  [0x8b50, "vec2"], [0x8b51, "vec3"], [0x8b52, "vec4"],
]);

/**
 * The whole shader GLSL is given for one pass: the prelude, the shared block, the pass's own source,
 * and the entry point. Returns how many lines came first, so a driver's line numbers can be rebased.
 *
 * @param {{source: string, common?: string, header?: string}} parts
 *        `common` is prepended to every pass (Shadertoy's Common); `header` is anything the caller
 *        wants in front of the prelude (used by the probe to stand in for one).
 */
export function assemble({ source, common = "", header = "" }) {
  const declared = BUILTINS
    .filter((b) => !new RegExp(`\\buniform\\s+\\w+\\s+${b.base ?? b.name}\\b`).test(source))
    .map((b) => `uniform ${b.type} ${b.name};`)
    .join("\n");
  const lines = [
    ...(header ? header.split("\n") : []),
    "#version 300 es",
    "precision highp float;",
    "precision highp int;",
    ...(declared ? declared.split("\n") : []),
    "out vec4 spFragColor;",
    "",
  ];
  const commonAt = lines.length;                       // where Common begins, if there is one
  if (common) lines.push(...common.split("\n"), "");
  const sourceAt = lines.length;                       // where the pass's own first line is
  lines.push(source, "", "void main() {", "  vec4 c = vec4(0.0, 0.0, 0.0, 1.0);",
             "  mainImage(c, gl_FragCoord.xy);", "  spFragColor = c;", "}");
  return { shader: lines.join("\n"), offset: sourceAt, commonAt, sourceAt };
}

/**
 * A driver's compile or link log, with its line numbers read back as the player's:
 * `{ pass: { line } }` for a line of the pass's own source, `{ common: { line } }` for a line of the
 * shared block, `null` for a line inside the prelude (which is nobody's code to fix).
 */
export function locate(text, places) {
  const { offset, commonAt } = places;
  return String(text).trim().split("\n").map((raw) => {
    const line = raw.trim();
    const m = /^(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/.exec(line);
    if (!m) return { where: "driver", line, message: line };
    const at = Number(m[1]);
    const message = m[2];
    if (at > offset) return { where: "pass", line: at - offset, message };
    if (commonAt < offset && at > commonAt) return { where: "common", line: at - commonAt, message };
    return { where: "prelude", line: null, message };
  }).filter((d) => d.message);
}

/** The same, as one readable block for the Log -- the shape the desktop side prints. */
export function describe(diagnostics) {
  return diagnostics.map((d) => {
    if (d.where === "pass") return `line ${d.line}: ${d.message}`;
    if (d.where === "common") return `Common, line ${d.line}: ${d.message}`;
    return d.message;
  }).join("\n");
}

/**
 * One pass's program, with its uniform table and its values.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {{name?: string, onSwap?: Function}} opts
 */
/** The names the prelude declares: ours to set every frame, and not the player's to send. */
export const BUILTIN_NAMES = BUILTINS.map((b) => b.base ?? b.name);

export function createProgram(gl, { name = "pass", onSwap } = {}) {
  let program = null;
  let uniforms = new Map();          // name -> { type, size, location }
  const values = new Map();          // name -> the value list last set, kept across a swap

  function introspect() {
    const found = new Map();
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const base = info.name.replace(/\[0\]$/, "");       // an array is reported as u[0]
      const type = GL_TYPES.get(info.type);
      // A sampler: no type of ours, but the renderer still has to set its unit, so it is kept.
      const sampler = info.type === 0x8b5e || info.type === 0x8b60;
      found.set(base, { type: type ?? (sampler ? "sampler" : null), size: info.size, location: gl.getUniformLocation(program, info.name), sampler, array: info.name !== base });
    }
    return found;
  }

  function upload(name, values) {
    const u = uniforms.get(name);
    if (!u) return { ok: false, error: `the running shader declares no uniform "${name}"` };
    if (u.sampler) return { ok: false, error: `"${name}" is a texture, not a value: bind it as a channel` };
    const shape = values.length === 1
      ? (typeof values[0] === "boolean" ? "bool" : Number.isInteger(values[0]) ? "int" : "float")
      : `vec${values.length}`;
    if (!fits(u.type, shape)) {
      return { ok: false, error: `"${name}" is ${u.type} in the shader, but ${shape} (${values.length} value${values.length > 1 ? "s" : ""}) was given` };
    }
    // A uniform belongs to a program, and `gl.uniform*` writes to the program IN USE. With one pass
    // that was invisible; with several it silently did nothing to every pass but the one bound last
    // -- found by reading a pixel back in tools/webgl-multipass-probe, not by reading this code.
    gl.useProgram(program);
    switch (u.type) {
      case "float": gl.uniform1f(u.location, Number(values[0])); break;
      case "int": gl.uniform1i(u.location, Math.round(Number(values[0]))); break;
      case "bool": gl.uniform1i(u.location, values[0] ? 1 : 0); break;
      case "vec2": gl.uniform2fv(u.location, values.slice(0, 2)); break;
      case "vec3": gl.uniform3fv(u.location, values.slice(0, 3)); break;
      case "vec4": gl.uniform4fv(u.location, values.slice(0, 4)); break;
    }
    // and check at the boundary: a refused upload must not come back as success. (dev-discipline §4.1:
    // an error has to be checked where it happens, or it is attributed to the next call instead.)
    const err = gl.getError();
    if (err) return { ok: false, error: `the driver refused "${name}" (GL error 0x${err.toString(16)})` };
    return { ok: true };
  }

  const api = {
    get name() { return name; },
    get program() { return program; },
    get uniforms() { return uniforms; },
    get usable() { return [...uniforms].filter(([, u]) => u.type && u.type !== "sampler").map(([n]) => n); },
    /** The values the player has set, so a caller can show or re-send them. */
    get values() { return new Map(values); },

    /**
     * Compile `source` and swap to it. On failure NOTHING changes: the report comes back, the
     * program that is running keeps running, and the uniform table and the values are untouched.
     */
    compile({ source, common = "", header = "" }) {
      const places = assemble({ source, common, header });
      const sh = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(sh, places.shader);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const diagnostics = locate(gl.getShaderInfoLog(sh), places);
        gl.deleteShader(sh);
        return { ok: false, where: "compile", diagnostics, report: describe(diagnostics) };
      }
      const next = gl.createProgram();
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, VERT);
      gl.compileShader(vs);
      gl.attachShader(next, vs);
      gl.attachShader(next, sh);
      gl.linkProgram(next);
      if (!gl.getProgramParameter(next, gl.LINK_STATUS)) {
        const diagnostics = locate(gl.getProgramInfoLog(next), places);
        gl.deleteShader(sh); gl.deleteShader(vs); gl.deleteProgram(next);
        return { ok: false, where: "link", diagnostics, report: describe(diagnostics) };
      }

      // from here on the swap cannot fail, so this is the point of no return
      const old = program;
      program = next;
      uniforms = introspect();
      gl.useProgram(program);
      let kept = 0, dropped = [];
      for (const [n, v] of values) {
        const r = upload(n, v);
        if (r.ok) kept++; else dropped.push(n);
      }
      for (const n of dropped) values.delete(n);          // the new program does not have it
      gl.deleteProgram(old ?? null);
      gl.deleteShader(sh); gl.deleteShader(vs);
      onSwap?.(api, { kept, dropped });
      return { ok: true, kept, dropped, uniforms: api.usable };
    },

    /** Point a channel at a texture unit. Ours, every frame -- not something a program sends. */
    setSampler(name, unit) {
      const u = uniforms.get(name);
      if (!u?.sampler) return false;
      gl.uniform1i(u.location, unit);
      return true;
    },

    /** Set an array uniform whole (iChannelResolution: four vec3s, so twelve floats). */
    setArray(name, floats) {
      const u = uniforms.get(name);
      if (!u || !u.array) return false;
      const components = { vec2: 2, vec3: 3, vec4: 4 }[u.type];
      if (!components) return false;
      gl.uniform3fv(u.location, floats.slice(0, u.size * components));
      return true;
    },

    /** Set a value, as a directive would. Remembered, so a recompile keeps it. */
    set(name, list) {
      const r = upload(name, list);
      if (r.ok) values.set(name, list.slice());
      return r;
    },

    /** Set it if the program has it, silently otherwise -- for our own feeds (the audio). */
    setIfPresent(name, list) { if (uniforms.get(name)?.type) upload(name, list); },

    use() { if (program) gl.useProgram(program); },

    dispose() { if (program) gl.deleteProgram(program); program = null; uniforms = new Map(); values.clear(); },
  };

  return api;
}
