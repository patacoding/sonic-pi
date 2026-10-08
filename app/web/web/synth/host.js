// The bridge: MIDI from the app -> instruments -> the engine's input bus. Enabled on purpose, and only then.
import { patchByProgram, PATCHES, guide, DEFAULT_PROGRAM } from "./patches.js";
import * as parts from "./parts.js";
import { createSynthWindow } from "./window.js";

const say = (t, bad = false) => (bad ? console.error : console.info)(`Synth — ${t}`);
const trace = [];        // every record the app handed us, parsed or not: the instrument for "did anything arrive"
const midiTrace = [];    // every performance signal, mapped or not

export async function applyPatch(part, program) {
  const made = await parts.ensurePart(part);
  const patch = patchByProgram(program);
  if (!patch) { say(`there is no instrument numbered ${program}`, true); return false; }
  for (const [id, v] of Object.entries(patch.params)) made.engine.setParamById(id, v);
  parts.rememberPatch(part, patch.n, patch.name);
  say(`"${part}" is playing ${patch.n} ${patch.name}`);
  return true;
}

/** MIDI channel = instrument; the first number the app sends is the channel (/clockwork/midi/out/<kind> <port> <ch> …). */
function handleMidi(...a) {
  const r = a[0] ?? {};
  const nums = (r.args ?? []).filter((x) => typeof x === "number");
  const path = String(r.path ?? "");
  const channel = typeof nums[0] === "number" ? nums[0] : 0;
  const part = channel <= 0 ? "main" : `ch${channel}`;
  const entry = { at: Date.now(), path, args: r.args ?? [], channel, part, mapped: null };
  if (/note_on|noteon/i.test(path)) {
    const [, note, velocity] = nums;
    entry.mapped = { note, velocity };
    if (typeof note === "number") parts.noteOn(part, note, typeof velocity === "number" ? velocity / 127 : 1);
  } else if (/note_off|noteoff/i.test(path)) {
    const [, note] = nums; entry.mapped = { note };
    if (typeof note === "number") parts.noteOff(part, note);
  } else if (/program_change|program/i.test(path)) {
    const [, program] = nums; const patch = patchByProgram(program);
    entry.mapped = { program, patch: patch?.name ?? null };
    if (patch) applyPatch(part, program);
  } else if (/control|cc/i.test(path)) {
    const [, cc, value] = nums;
    const MAP = { 7: "master.volume", 71: "filter1.resonance", 72: "env1.release", 73: "env1.attack", 74: "filter1.cutoff" };
    const id = MAP[cc];
    entry.mapped = { cc, value, param: id ?? null };
    if (id && typeof value === "number") parts.setParam(part, id, value / 127);
  }
  midiTrace.push(entry); if (midiTrace.length > 60) midiTrace.shift();
  return true;
}

// ── enabling: the one deliberate step that touches audio ─────────────────────────────────────────────────
let enabled = false, linkError = null, readerStarted = false;

async function ensureEngineExists() {
  if (globalThis.sonicPi?.engine?.node?.input) return true;
  say("pressing the app's Run once so its engine exists — that also runs the current buffer");
  document.getElementById("btn-run")?.click();
  for (let i = 0; i < 40; i++) { if (globalThis.sonicPi?.engine?.node?.input) return true; await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
async function startReader(tries = 8) {
  for (let i = 0; i < tries && !readerStarted; i++) {
    try { await globalThis.sonicPi?.session?.run?.("synth :sound_in_stereo, sustain: 3600, amp: 1", { group: 0 });
          readerStarted = true; say("reader started — the synth is heard through the engine"); return true; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  say("the reader did not start — press 'start a reader' in the window", true);
  return false;
}
export async function enable() {
  if (enabled) return true;
  linkError = null;
  try {
    if (!(await ensureEngineExists())) throw new Error("the app's engine did not appear");
    await parts.attachToEngine(15000);
    enabled = true;
    say("Soundgineer enabled — instruments are on the engine's context");
    startReader();
    return true;
  } catch (e) { linkError = String(e?.message ?? e); enabled = false; say(`could not enable: ${linkError}`, true); return false; }
}
export function disable() {
  parts.detach(); enabled = false; readerStarted = false;
  say("Soundgineer disabled — the instruments are released");
  return true;
}
/**
 * Stop must reach us too. Our instruments are not nodes in Sonic Pi's tree, so when the app's Stop kills the music --
 * a loop interrupted between note_on and note_off -- their notes hang and the synth keeps playing by itself. That is
 * the leak: we are outside the thing being stopped, so we have to listen for it.
 */
export function panic(reason = "stop") {
  const names = parts.list();
  for (const n of names) parts.allNotesOff(n);
  // The app's Stop also kills the reader (it is one of its own synths), so claiming "ready" afterwards would be a lie
  // and the player would hear nothing with no explanation. Notes cleared, reader forgotten: press the button again.
  readerStarted = false;
  if (names.length) say(`${reason} — all notes off on ${names.join(", ")}; the reader was stopped too, start it again`);
  return names.length;
}

function watchForStop() {
  const stop = globalThis.sonicPi?.session?.stop;
  if (typeof stop === "function" && !stop.__sgrWrapped) {
    const wrapped = function (...a) { panic("stop"); return stop.apply(this, a); };
    wrapped.__sgrWrapped = true;
    globalThis.sonicPi.session.stop = wrapped;
    say("listening for the app's Stop");
  }
  const b = document.getElementById("btn-stop");
  if (b && !b.__sgrWrapped) { b.__sgrWrapped = true; b.addEventListener("click", () => panic("stop")); say("listening to the Stop button"); }
}
setTimeout(watchForStop, 1500);
setInterval(watchForStop, 5000);          // the session is rebuilt on some runs; keep watching the current one

/** The only way a reader is started: a second one would read the same bus twice. */
export async function startReaderOnce() {
  if (readerStarted) { say("a reader is already running"); return true; }
  return startReader();
}

const linkState = () => ({ state: linkError ? "error" : !enabled ? "off" : !readerStarted ? "starting (no reader yet)" : "ready",
  reason: linkError, enabled, reader: readerStarted, out: parts.outState(), instruments: parts.list(), cap: parts.capOf() });

const api = {
  get ready() { return enabled; },
  get error() { return linkError; },
  state: () => ({ ...parts.state(), enabled, reader: readerStarted, link: linkState().state }),
  link: linkState,
  enable, disable, enabled: () => enabled, panic, startReader: startReaderOnce,
  engineOf: parts.engineOf,
  ensurePart: (n) => parts.ensurePart(n).then(() => true),
  noteOn: (part, note, velocity = 1) => parts.noteOn(part ?? "main", note, velocity),
  noteOff: (part, note) => parts.noteOff(part ?? "main", note),
  allNotesOff: (part) => parts.allNotesOff(part ?? null),
  setParam: (part, id, value) => parts.setParam(part ?? "main", id, value),
  applyPatch, handleMidi, guide,
  patches: () => PATCHES.map((p) => ({ ...p })),
  midiTrace: () => midiTrace.slice(),
  trace: () => trace.slice(),
  handleRecord(r) {
    // Kept as the diagnostic tap: every record the app hands this layer is remembered, parsed or not.
    const fields = (r && typeof r === "object") ? r : {};
    trace.push({ at: Date.now(), kind: fields.kind ?? null, keys: Object.keys(fields).slice(0, 10),
                 strings: Object.values(fields).filter((v) => typeof v === "string").map((v) => v.slice(0, 50)).slice(0, 4) });
    if (trace.length > 40) trace.shift();
    return false;                       // the `:sgr` sigil was withdrawn; MIDI is the control path
  },
};

api.window = createSynthWindow({
  state: parts.state, patches: () => PATCHES, guide, midiTrace: () => midiTrace.slice(),
  applyPatch, defaultProgram: DEFAULT_PROGRAM, link: linkState, enable, disable, panic, startReader: startReaderOnce,
  enabled: () => enabled,          // the window gates its editor on this; forgetting it made the editor never mount
  engineOf: parts.engineOf, ensurePart: (n) => parts.ensurePart(n).then(() => true),
});

globalThis.sonicPiSynth = api;
// the instruments, for the window's neighbours and for the probes (the rewrite dropped this and broke both)
globalThis.sonicPiParts = {
  list: parts.list, has: parts.has, engineOf: parts.engineOf, ensure: parts.ensurePart, state: parts.state,
  noteOn: parts.noteOn, noteOff: parts.noteOff, setParam: parts.setParam, allNotesOff: parts.allNotesOff,
  free: parts.free, outState: parts.outState, cap: parts.capOf, attachToEngine: parts.attachToEngine, detach: parts.detach,
};
export { api as synthHost };
