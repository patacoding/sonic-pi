// The scanner both language layers share: a line of Sonic Pi's `puts` syntax turned into words.
// It lives in a file of its own so that neither layer owns it -- the synthesizer's parser used to import the
// graphics one purely to borrow this, which is a coupling with nothing behind it.

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
const SPACE = /[\s,\[\]{}]/;

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
export function readWords(s) {
  const toks = [];
  for (const w of s.trim().split(/\s+/)) {
    if (!w) continue;
    const t = classify(w);
    toks.push(t.kind === "unknown" ? { kind: "symbol", value: w } : t);
  }
  return toks;
}

export const num = (t) => t.kind === "int" || t.kind === "float";

/**
 * The shape of a value list, which is what decides the GLSL type it can fit:
 * `float`, `int`, `bool`, `vec2`, `vec3`, `vec4`; `mixed` when they disagree.
 * Singletons keep their own kind so an `int` uniform can be told from a float.
 */
export const word = (t) => (t.kind === "symbol" || t.kind === "string" ? t.value : null);

/**
 * Read one line of the log as a directive.
 *
 * Returns null when the line is not ours — most `puts` output is the player's
 * own and must pass through untouched. Otherwise `{ ok, verbose, name, values,
 * shape }` or `{ ok: false, error, raw }`.
 */
export function describe(t) {
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
