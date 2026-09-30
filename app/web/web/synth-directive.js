// SPDX-License-Identifier: AGPL-3.0-or-later
// The `:synth` language: how the music plays our own synthesizer (synth.js).
//
//     puts :synth, :note, 69                 a note (velocity 1, held 0.5 s)
//     puts :synth, :note, 69, 0.8, 2         velocity 0.8, held 2 s
//     puts :synth, :off, 69                  release it now
//     puts :synth, :alloff                   release everything
//     puts :synth, :cutoff, 900              its filter, from the music
//     puts :synth, :res, 0.8   #  :gain, 0.2
//     puts :synthv, …                        the same, into the Log as well
//
// A sigil of its own, deliberately: the orders include `cutoff`, `res` and `gain`, which a shader may well
// declare as a uniform, so `:gfx` (the shader's language, gfx-directive.js) must not have to know about
// them. The text helpers are shared -- tokenising a log line is neither the shader's nor the synth's.
//
// Returns `null` for anything that is not a `:synth` line (the player's own output, or a `:gfx` line), and
// otherwise `{ ok, verbose, raw, name, command, … }` or `{ ok: false, verbose, raw, error }`.
import { tokenize, readWords, word } from "./gfx-directive.js";

export const SYNTH_SIGIL = ":synth";
export const SYNTH_SIGIL_VERBOSE = ":synthv";

const SIGILS = new Map([
  ["synth", false], [":synth", false],
  ["synthv", true], [":synthv", true],
]);

/** The names that play the synthesizer rather than set one of its values. */
export const SYNTH_COMMANDS = new Set(["note", "off", "alloff", "cutoff", "res", "gain", "use"]);

/** Is this name an order for our synthesizer? (gfx.js uses it to answer a `puts :gfx, :note, …` helpfully.) */
export const isSynthOrder = (name) => SYNTH_COMMANDS.has(name);

const NUM = (t) => (t && (t.kind === "int" || t.kind === "float") ? t.value : null);

export function parseSynthDirective(text) {
  if (typeof text !== "string") return null;
  const raw = text;
  let toks = tokenize(text);
  // the string form is ONE quoted run: `puts "synth note 69"` reads as words inside it
  if (toks.length === 1 && toks[0].kind === "string" && SIGILS.has(toks[0].value.trim().split(/\s+/)[0])) {
    toks = readWords(toks[0].value);
  }
  if (!toks.length) return null;
  const sigil = word(toks[0]);
  if (sigil == null || !SIGILS.has(sigil)) return null;      // not ours: leave it alone
  const verbose = SIGILS.get(sigil);

  if (toks.length < 2) return { ok: false, verbose, raw, error: `${sigil} needs a name` };
  const name = word(toks[1]);
  if (!name) return { ok: false, verbose, raw, error: `the name after ${sigil} is not a symbol or string` };
  const values = toks.slice(2);

  if (name === "alloff") {
    if (values.length) return { ok: false, verbose, raw, error: "alloff takes nothing after it" };
    return { ok: true, verbose, raw, name, command: "alloff", values: [] };
  }
  // `use` takes a NAME (a symbol or a string), not a number: the music says which synth it wants and the PAGE
  // decides where it comes from -- so no service URL ever appears in a piece of music somebody shares.
  if (name === "use") {
    if (values.length !== 1) return { ok: false, verbose, raw, error: "use: one name after it, as in :synth, :use, :sqfm" };
    const wanted = word(values[0]);
    if (!wanted) return { ok: false, verbose, raw, error: `use: ${describe(values[0])} is not a name — :synth, :use, :sqfm` };
    return { ok: true, verbose, raw, name, command: "use", synth: wanted, values: [wanted] };
  }
  if (!SYNTH_COMMANDS.has(name)) {
    return { ok: false, verbose, raw, error: `${name} is not one of ours — note, off, alloff, cutoff, res, gain` };
  }
  const nums = values.map(NUM);
  if (nums.some((v) => v == null)) {
    return { ok: false, verbose, raw, error: `${name}: numbers only — e.g. :synth, :${name}, 69${name === "note" ? ", 0.8, 2" : ""}` };
  }
  if (name === "note") {
    if (nums.length < 1 || nums.length > 3) return { ok: false, verbose, raw, error: "note: :synth, :note, <midi> [, <velocity> [, <seconds held>]]" };
    if (nums[0] < 0 || nums[0] > 127) return { ok: false, verbose, raw, error: `note: ${nums[0]} is not a MIDI note (0–127)` };
    const velocity = nums.length > 1 ? nums[1] : 1;
    if (velocity < 0 || velocity > 1) return { ok: false, verbose, raw, error: `note: velocity ${velocity} is not between 0 and 1` };
    const hold = nums.length > 2 ? nums[2] : 0.5;
    if (hold <= 0) return { ok: false, verbose, raw, error: `note: held for ${hold}s — say a positive number, or use :off` };
    return { ok: true, verbose, raw, name, command: "note", note: nums[0], velocity, hold, values: nums };
  }
  if (nums.length !== 1) return { ok: false, verbose, raw, error: `${name}: one number after it, as in :synth, :${name}, ${name === "off" ? 69 : 900}` };
  if (name === "off") {
    if (nums[0] < 0 || nums[0] > 127) return { ok: false, verbose, raw, error: `off: ${nums[0]} is not a MIDI note (0–127)` };
    return { ok: true, verbose, raw, name, command: "off", note: nums[0], values: nums };
  }
  return { ok: true, verbose, raw, name, command: "param", param: name, value: nums[0], values: nums };
}
