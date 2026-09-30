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

// Our own synthesizer gets a sigil of its own -- `puts :synth, :note, 69`. It has to be a separate one:
// the orders below include names a shader may well declare as a uniform (`cutoff`, `res`, `gain`), and a
// player's existing document must not change behaviour because we added a synth.
export const SYNTH_SIGIL = ":synth";
const SYNTH_SIGILS = new Map([["synth", false], [":synth", false], ["synthv", true], [":synthv", true]]);

// The names that are orders rather than uniforms: `puts :gfx, :document, "rings"`. Everything else
// after the sigil is a value for a name the shader declared.
export const COMMANDS = new Set(["document"]);

// The names that play OUR OWN synthesizer (web/gfx-synth.js) instead of setting a shader uniform. They are
// read before the shapes below because they take MIDI numbers, not vector values:
//
//     puts :gfx, :note, 69               a note (velocity 1, held 0.5 s)
//     puts :gfx, :note, 69, 0.8, 2       velocity 0.8, held 2 s
//     puts :gfx, :off, 69                release it now
//     puts :gfx, :alloff                 release everything
//     puts :gfx, :cutoff, 900            its filter, from the music
//     puts :gfx, :res, 0.8  /  :gain, 0.2
//
// The instant they land on is the record's own `time` (the engine clock), which is the same instant a
// `synth`/`sample` on that line lands on -- measured to 1.5 ms: docs/web-synth-engine.md §7.
export const SYNTH_COMMANDS = new Set(["note", "off", "alloff", "cutoff", "res", "gain"]);
const NUM = (t) => (t && (t.kind === "int" || t.kind === "float") ? t.value : null);

const SPACE = /[\s,\[\]{}]/;

/** A quoted run starting at `i` (just past the opening quote): [text, next]. */
function readQuoted(text, i) {
  let out = "";
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      const e = text[i + 1];
      out += { '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r", e: "\x1b" }[e] ?? e;
      i += 2;
      continue;
    }
    if (c === '"') return [out, i + 1];
    out += c;
    i++;
  }
  return [out, i];     // unterminated: take the rest rather than throw
}

/** One bare word as the literal it is, or `unknown`. */
function classify(word) {
  if (word === "true" || word === "false") return { kind: "bool", value: word === "true" };
  if (word === "nil") return { kind: "nil", value: null };
  if (/^[+-]?\d+$/.test(word)) return { kind: "int", value: Number(word) };
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(word)) return { kind: "float", value: Number(word) };
  return { kind: "unknown", value: word };
}

/** The tokens of the text `log_inspect` produced. */
export function tokenize(text) {
  const toks = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === ":") {
      if (text[i + 1] === '"') {
        const [s, j] = readQuoted(text, i + 2);
        toks.push({ kind: "symbol", value: s });
        i = j;
      } else {
        let j = i + 1;
        while (j < text.length && !SPACE.test(text[j])) j++;
        toks.push({ kind: "symbol", value: text.slice(i + 1, j) });
        i = j;
      }
      continue;
    }
    if (c === '"') {
      const [s, j] = readQuoted(text, i + 1);
      toks.push({ kind: "string", value: s });
      i = j;
      continue;
    }
    if (c === ",") { i++; continue; }
    if (c === "[" || c === "{") { toks.push({ kind: "open", value: c }); i++; continue; }
    if (c === "]" || c === "}") { toks.push({ kind: "close", value: c }); i++; continue; }
    let j = i;
    while (j < text.length && !SPACE.test(text[j])) j++;
    toks.push(classify(text.slice(i, j)));
    i = j;
  }
  return toks;
}

/** The words of the string form: plain text, so a name is any bare word. */
function readWords(s) {
  const toks = [];
  for (const w of s.trim().split(/\s+/)) {
    if (!w) continue;
    const t = classify(w);
    toks.push(t.kind === "unknown" ? { kind: "symbol", value: w } : t);
  }
  return toks;
}

const num = (t) => t.kind === "int" || t.kind === "float";

/**
 * The shape of a value list, which is what decides the GLSL type it can fit:
 * `float`, `int`, `bool`, `vec2`, `vec3`, `vec4`; `mixed` when they disagree.
 * Singletons keep their own kind so an `int` uniform can be told from a float.
 */
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

const word = (t) => (t.kind === "symbol" || t.kind === "string" ? t.value : null);

/**
 * Read one line of the log as a directive.
 *
 * Returns null when the line is not ours — most `puts` output is the player's
 * own and must pass through untouched. Otherwise `{ ok, verbose, name, values,
 * shape }` or `{ ok: false, error, raw }`.
 */
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
  const isSynth = sigil != null && SYNTH_SIGILS.has(sigil);
  if (sigil == null || (!SIGILS.has(sigil) && !isSynth)) return null;   // not a directive: leave it alone
  const verbose = isSynth ? SYNTH_SIGILS.get(sigil) : SIGILS.get(sigil);

  if (toks.length < 2) return { ok: false, verbose, raw, error: `${sigil} needs a name` };
  const name = word(toks[1]);
  if (name == null || !name) return { ok: false, verbose, raw, error: `the name after ${sigil} is not a symbol or string` };

  const values = toks.slice(2);
  // ── the words ─────────────────────────────────────────────────────────────
  // A few names are not uniforms but orders: `:document` is which one is on screen, which is how the
  // music changes the look without anyone touching the editor. They take a word where a uniform takes
  // numbers, so they are read before the shapes below and never reach them.
  if (SYNTH_COMMANDS.has(name) && !isSynth) {
    return { ok: false, verbose, raw, error: `${name} is an order for our synthesizer: say :synth, :${name} (the :gfx sigil is for the shader's own values)` };
  }
  if (SYNTH_COMMANDS.has(name)) {
    if (name === "alloff") {
      if (values.length) return { ok: false, verbose, raw, error: "alloff takes nothing after it" };
      return { ok: true, verbose, raw, name, command: "alloff", values: [] };
    }
    const nums = values.map(NUM);
    if (nums.some((v) => v == null)) {
      return { ok: false, verbose, raw, error: `${name}: numbers only — e.g. :gfx, :${name}, 69${name === "note" ? ", 0.8, 2" : ""}` };
    }
    if (name === "note") {
      if (nums.length < 1 || nums.length > 3) return { ok: false, verbose, raw, error: "note: :gfx, :note, <midi> [, <velocity> [, <seconds held>]]" };
      if (nums[0] < 0 || nums[0] > 127) return { ok: false, verbose, raw, error: `note: ${nums[0]} is not a MIDI note (0–127)` };
      const velocity = nums.length > 1 ? nums[1] : 1;
      if (velocity < 0 || velocity > 1) return { ok: false, verbose, raw, error: `note: velocity ${velocity} is not between 0 and 1` };
      const hold = nums.length > 2 ? nums[2] : 0.5;
      if (hold <= 0) return { ok: false, verbose, raw, error: `note: held for ${hold}s — say a positive number, or use :off` };
      return { ok: true, verbose, raw, name, command: "note", note: nums[0], velocity, hold, values: nums };
    }
    if (nums.length !== 1) return { ok: false, verbose, raw, error: `${name}: one number after it, as in :gfx, :${name}, ${name === "off" ? 69 : 900}` };
    if (name === "off") {
      if (nums[0] < 0 || nums[0] > 127) return { ok: false, verbose, raw, error: `off: ${nums[0]} is not a MIDI note (0–127)` };
      return { ok: true, verbose, raw, name, command: "off", note: nums[0], values: nums };
    }
    return { ok: true, verbose, raw, name, command: "param", param: name, value: nums[0], values: nums };
  }

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

function describe(t) {
  switch (t.kind) {
    case "unknown": return `'${t.value}'`;
    case "nil": return "nil";
    case "open": return "[";
    case "close": return "]";
    default: return `${t.kind} ${t.value}`;
  }
}

/**
 * Does a value list fit the type the shader declared? `glType` is what
 * `glGetActiveUniform` reported, as the name the canvas layer uses.
 *
 * An int fits a `float` (GLSL widens it) and a float with no fraction fits an
 * `int`; anything else is a mismatch the player is told about, because
 * silently truncating a vec3 into a float is the kind of help nobody wants.
 */
export function fits(glType, shape) {
  const scalar = { float: ["float", "int", "bool"], int: ["int", "float", "bool"], bool: ["bool", "int", "float"] };
  if (glType in scalar) return scalar[glType].includes(shape);
  const vec = { vec2: 2, vec3: 3, vec4: 4 }[glType];
  return vec != null && shape === `vec${vec}`;
}

/** The whole-vector kinds, in the order `values` holds them. */
export const VEC_SIZE = { vec2: 2, vec3: 3, vec4: 4 };
