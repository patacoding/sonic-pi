import { tokenize, readWords, word, num, describe } from "./text-scan.js";
// SPDX-License-Identifier: AGPL-3.0-or-later
// The `:gfx` directive: what one of the player's `puts` lines means.
//
// Why this file exists at all. On the desktop the graphics feature drives a
// shader with OSC:
//
//     osc "/graphics/uniform", "uGain", 0.5
//
// On the web there is no OSC: `osc`, `osc_send`, `use_osc` and `with_osc` are
// all deliberately removed (runtime/lib/sonic_pi/lang.rb:1310,1311,1323-1327 —
// "a browser cannot send or receive OSC (it travels over UDP)"). The channel
// that DOES exist is the runtime's GUI stream, and user code already reaches
// the page through it: `puts` -> `Scheduler#output_line` ->
// `Native.gui(:output, ...)` (scheduler.rb:1455-1457). So `puts` is the
// transport, and this file is the meaning we give its text.
//
// Two forms are accepted, and the difference matters:
//
//   puts :gfx, :uGain, 0.5        ->  `:gfx :uGain 0.5`          (canonical)
//   puts "gfx uGain 0.5"          ->  `"gfx uGain 0.5"`          (also read)
//
// The canonical one is the symbols, because of how `puts` builds its text:
//
//     msgs.map { |m| SonicPi.log_inspect(m) }.join(" ")           (lang.rb:95)
//
// and `log_inspect` runs a String through `str_inspect` (ring.rb:166), which
// puts quotes round it and escapes \" \\ \n \t \r \e. A Symbol goes through
// `inspect` instead and comes out as `:uGain` — no quotes, no escapes, nothing
// for the reader to undo. Measured on this checkout:
//
//     puts "gfx uGain 0.5"      ->  "gfx uGain 0.5"     (quotes are in the text)
//     puts :gfx, :uGain, 0.5    ->  :gfx :uGain 0.5
//     puts [70, 100, 8]         ->  [70, 100, 8]
//     puts :"odd name"          ->  :"odd name"
//
// The string form is read too, since it is the friendlier thing to type; it
// pays for that with the unescaping below.
//
// What this file is NOT: it has no DOM, no WebGL and no knowledge of GLSL
// types. It turns text into `{ name, values }` and says what shape the values
// are. Whether that name exists, and whether the shape fits what the shader
// declared, is decided against the compiled program in gfx-canvas.js — which
// is the only place that can know (`glGetActiveUniform`).

export const SIGIL = ":gfx";
export const SIGIL_VERBOSE = ":gfxv";

// The same two, as they arrive in the string form (no colon), plus the colons
// so `puts "gfx …"` and `puts ":gfx …"` both read.
const SIGILS = new Map([
  ["gfx", false], [":gfx", false],
  ["gfxv", true], [":gfxv", true],
]);



// The names that are orders rather than uniforms: `puts :gfx, :document, "rings"`. Everything else
// after the sigil is a value for a name the shader declared.
export const COMMANDS = new Set(["document"]);

const SPACE = /[\s,\[\]{}]/;

/** A quoted run starting at `i` (just past the opening quote): [text, next]. */
export function shapeOf(values) {
  if (!values.length) return "empty";
  if (values.length === 1) {
    const t = values[0];
    return t.kind === "int" ? "int" : t.kind === "float" ? "float" : t.kind === "bool" ? "bool" : "bad";
  }
  if (values.length > 4) return "tooMany";
  if (!values.every(num)) return "mixed";
  return `vec${values.length}`;
}

export function parseDirective(text) {
  if (typeof text !== "string") return null;
  const raw = text;
  let toks = tokenize(text);
  // The string form is ONE quoted run; read its inside as plain words instead.
  if (toks.length === 1 && toks[0].kind === "string" && SIGILS.has(toks[0].value.trim().split(/\s+/)[0])) {
    toks = readWords(toks[0].value);
  }
  if (!toks.length) return null;

  const sigil = word(toks[0]);
  if (sigil == null || !SIGILS.has(sigil)) return null;      // not a directive: leave it alone
  const verbose = SIGILS.get(sigil);

  if (toks.length < 2) return { ok: false, verbose, raw, error: `${sigil} needs a name` };
  const name = word(toks[1]);
  if (name == null || !name) return { ok: false, verbose, raw, error: `the name after ${sigil} is not a symbol or string` };

  const values = toks.slice(2);
  // ── the words ─────────────────────────────────────────────────────────────
  // A few names are not uniforms but orders: `:document` is which one is on screen, which is how the
  // music changes the look without anyone touching the editor. They take a word where a uniform takes
  // numbers, so they are read before the shapes below and never reach them.
  if (COMMANDS.has(name)) {
    if (values.length !== 1) return { ok: false, verbose, raw, error: `${name}: one word after it, as in :gfx, :document, "rings" (or :next)` };
    const arg = word(values[0]);
    if (arg == null) return { ok: false, verbose, raw, error: `${name}: ${describe(values[0])} is not a name — :gfx, :document, "rings"` };
    return { ok: true, verbose, raw, name, command: name, arg, values: [arg], shape: "word" };
  }

  const open = values.find((t) => t.kind === "open" || t.kind === "close");
  if (open) {
    // An array would arrive as `[a, b]`; it is how a player sends a list by
    // accident (`puts :gfx, :uColor, [...]`). Say so rather than guess.
    return { ok: false, verbose, raw, error: `${name}: pass the values separately, not as an array — :gfx, :${name}, 1.0, 0.2, 0.8` };
  }
  if (!values.length) return { ok: false, verbose, raw, error: `${name}: no value` };

  const shape = shapeOf(values);
  if (shape === "bad") return { ok: false, verbose, raw, error: `${name}: ${describe(values[0])} is not a number or true/false` };
  if (shape === "mixed") return { ok: false, verbose, raw, error: `${name}: mixes numbers and true/false, or ints with non-numbers` };
  if (shape === "tooMany") return { ok: false, verbose, raw, error: `${name}: ${values.length} values, but a uniform takes at most 4` };

  return { ok: true, verbose, raw, name, values: values.map((t) => t.value), shape };
}

export function fits(glType, shape) {
  const scalar = { float: ["float", "int", "bool"], int: ["int", "float", "bool"], bool: ["bool", "int", "float"] };
  if (glType in scalar) return scalar[glType].includes(shape);
  const vec = { vec2: 2, vec3: 3, vec4: 4 }[glType];
  return vec != null && shape === `vec${vec}`;
}

/** The whole-vector kinds, in the order `values` holds them. */
export const VEC_SIZE = { vec2: 2, vec3: 3, vec4: 4 };

export { tokenize, readWords, word, num, describe };
