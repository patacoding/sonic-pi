// `puts` -> performance signals. Parsing only; the instrument itself does not keep time.
//
// The music names the part explicitly, every time:   puts :synth, :bass, :note, 60
// (part, then command, then arguments). A form with no part -- puts :synth, :note, 60 -- goes to the default part
// `main`, so older lines keep working; a part name that collides with a command is read as the command.
//
// Nothing here schedules anything: a note sounds when the signal arrives. When Sonic Pi sends that signal is Sonic
// Pi's own business (docs/plan/soundgineer-multipart-argument.md 5.8).
import { tokenize, word, num } from "../graphics/text-scan.js";

export const DEFAULT_PART = "main";
export const COMMANDS = new Set(["note", "off", "alloff", "param", "mod", "fx", "gate", "free", "panic"]);

const bare = (t) => String(t).replace(/^:/, "").replace(/^"|"$/g, "");

/**
 * One record's text -> { part, command, args } or { error }.
 * Accepts the canonical `:synth :bass :note 60` and the string form `"synth bass note 60"`.
 */
export function parseSynthDirective(text) {
  const raw = String(text ?? "");
  // The sigil is `sgr` (Soundgineer). Measured, not chosen by taste: the app suppresses an output record whose text
  // begins with `synth` OR `sg` (both are names it reserves), so lines written with either never reach us at all --
  // `puts :synth, …` and `puts :sg, …` produce no record, while `:sgr`, `:snd`, `:sgi`, `:synthx` and our own `:gfx`
  // all do. Anything written with the old names is accepted here and reported as a sigil that cannot arrive.
  const m = /^\s*:?"?\s*([A-Za-z_]\w*)\b/.exec(raw);
  if (!m) return null;
  const sigil = m[1].toLowerCase();
  if (sigil === "synth" || sigil === "sg") {
    return { error: `"${sigil}" cannot be used as a sigil: the app filters output that starts with it -- write :sgr instead` };
  }
  if (sigil !== "sgr" && sigil !== "soundgineer") return null;
  const words = tokenize(raw).filter((t) => t.kind !== "space");
  const parts = words.map(bare);
  if (parts.length < 2) return { error: "a :synth line needs at least a command" };
  const rest = words.slice(1);
  let part = DEFAULT_PART, command, args;
  if (COMMANDS.has(parts[1])) { command = parts[1]; args = rest.slice(1); }
  else { part = parts[1]; if (!/^[A-Za-z_][\w-]*$/.test(part)) return { error: `"${parts[1]}" is not a part name` };
         command = parts[2]; args = rest.slice(2); }
  if (!command) return { error: `part "${part}" was named but no command followed` };
  if (!COMMANDS.has(command)) return { error: `"${command}" is not a :synth command (${[...COMMANDS].join(", ")})` };
  return { part, command, args, raw };
}

/** The numbers in a directive's arguments, in order (strings stay strings). */
export const numbers = (args) => args.filter((t) => t.kind === "num").map((t) => Number(word(t)));
export const strings = (args) => args.filter((t) => t.kind === "string").map((t) => bare(word(t)));
