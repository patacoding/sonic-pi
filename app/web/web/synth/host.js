// The bridge: the app's MIDI -> our instruments -> the app engine's input bus.
//
// Two rules shape this file.
//
//   1. We never run the user's code. The app runs the buffer when the user presses Run; enabling the synthesiser is
//      not a reason to execute anything, so enable() only attaches to the engine, and waits for it if it is not there
//      yet. The user keeps Run for themselves.
//   2. Nothing hangs. Our instruments are not nodes in Sonic Pi's tree, so the app's Stop cannot reach them; we listen
//      for it and clear every note, and the reader is started exactly once.
import { patchByProgram, PATCHES, guide, DEFAULT_PROGRAM } from "./patches.js";
import * as parts from "./parts.js";
import { createSynthWindow } from "./window.js";

const say = (t, bad = false) => (bad ? console.error : console.info)(`Synth — ${t}`);
const trace = [];        // every record the app handed this layer, parsed or not
const midiTrace = [];    // every performance signal, mapped or not

const CC_MAP = { 7: "master.volume", 71: "filter1.resonance", 72: "env1.release", 73: "env1.attack", 74: "filter1.cutoff" };

export async function applyPatch(part, program) {
  const made = await parts.ensurePart(part);
  const patch = patchByProgram(program);
  if (!patch) { say(`there is no instrument numbered ${program}`, true); return false; }
  for (const [id, v] of Object.entries(patch.params)) made.engine.setParamById(id, v);
  parts.rememberPatch(part, patch.n, patch.name);
  parts.rememberPreset(part, patch.name);      // the table shows what the music selected too
  say(`"${part}" is playing ${patch.n} ${patch.name}`);
  return true;
}

/** MIDI channel = instrument: /clockwork/midi/out/<kind> <port> <channel> <values…> */
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
    if (patch) { parts.silence(part); applyPatch(part, program); }   // a new instrument must not inherit the old one's sound
  } else if (/control|cc/i.test(path)) {
    const [, cc, value] = nums;
    const id = CC_MAP[cc];
    entry.mapped = { cc, value, param: id ?? null };
    if (id && typeof value === "number") parts.setParam(part, id, value / 127);
  }
  midiTrace.push(entry); if (midiTrace.length > 60) midiTrace.shift();
  return true;
}

// ── the link ─────────────────────────────────────────────────────────────────────────────────────────────
let requested = false;      // the user turned it on
let enabled = false;        // the engine exists and the instruments are attached to it
let linkError = null;
let readerStarted = false;

function panic(reason = "stop") {
  const names = parts.list();
  for (const n of names) parts.silence(n);        // release the voices AND drop the gain briefly: no stuck sound survives
  readerStarted = false;    // the app's Stop kills the reader too (it is one of its synths): do not claim otherwise
  if (names.length) say(`${reason} — all notes off on ${names.join(", ")}; start a reader again to be heard`);
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
  if (b && !b.__sgrWrapped) { b.__sgrWrapped = true; b.addEventListener("click", () => panic("stop")); }
}
setTimeout(watchForStop, 1500);
setInterval(watchForStop, 5000);

async function startReader(tries = 8) {
  for (let i = 0; i < tries && !readerStarted; i++) {
    try {
      await globalThis.sonicPi?.session?.run?.("synth :sound_in_stereo, sustain: 3600, amp: 1", { group: 0 });
      readerStarted = true;
      say("reader started — the synth is heard through the engine");
      return true;
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  say("the reader did not start — press 'start a reader' in the window", true);
  return false;
}
export async function startReaderOnce() {
  if (readerStarted) { say("a reader is already running"); return true; }
  return startReader();
}

async function attachWhenPossible() {
  const node = globalThis.sonicPi?.engine?.node?.input;
  if (!node?.context) return false;
  try {
    await parts.attachToEngine(5000);
    enabled = true; linkError = null;
    say("the engine is up — the instruments are on its context");
    parts.restoreRemembered().catch(() => {});      // a channel's preset must not wait for a click to come back
    startReader();
    return true;
  } catch (e) { linkError = String(e?.message ?? e); return false; }
}

/** Turn the synthesiser on. It runs nothing: if the engine is not up yet, we wait for the user's Run. */
export async function enable() {
  if (enabled) return true;
  requested = true; linkError = null;
  // Start the engine on purpose, inside this click, and run nothing: __sonicPiBootEngine is the app's own
  // ensureSession (the path its onboarding tap uses). A browser only lets audio start inside a gesture, which is why
  // this call happens here and not later.
  if (!globalThis.sonicPi?.engine?.node?.input && typeof globalThis.__sonicPiBootEngine === "function") {
    try { globalThis.__sonicPiBootEngine(); say("asked the app to boot its engine — no code is run"); }
    catch (e) { say(`the engine boot call failed: ${e?.message ?? e}`, true); }
  } else if (!globalThis.__sonicPiBootEngine) {
    say("this build has no engine-boot hook: press Run once (that will also run your music)", true);
  }
  if (await attachWhenPossible()) return true;
  say("Soundgineer is on, waiting for the app's engine. Press Run when you are ready — it will run your music as usual");
  for (let i = 0; i < 600 && requested && !enabled; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await attachWhenPossible()) return true;
  }
  return enabled;
}

export function disable() {
  parts.detach();
  requested = false; enabled = false; readerStarted = false;
  say("Soundgineer disabled — the instruments are released");
  return true;
}

const linkState = () => ({
  state: linkError ? "error"
    : !requested ? "off"
      : !enabled ? "waiting for the engine (press Run when ready)"
        : !readerStarted ? "starting (no reader yet)" : "ready",
  reason: linkError, requested, enabled, reader: readerStarted, out: parts.outState(),
  instruments: parts.list(), cap: parts.capOf(),
});

const api = {
  get ready() { return enabled; },
  get error() { return linkError; },
  state: () => ({ ...parts.state(), enabled, requested, reader: readerStarted, link: linkState().state }),
  link: linkState, enable, disable, enabled: () => enabled, panic, startReader: startReaderOnce,
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
    const f = (r && typeof r === "object") ? r : {};
    trace.push({ at: Date.now(), kind: f.kind ?? null, keys: Object.keys(f).slice(0, 10),
                 strings: Object.values(f).filter((v) => typeof v === "string").map((v) => v.slice(0, 50)).slice(0, 4) });
    if (trace.length > 40) trace.shift();
    return false;                       // the `:sgr` sigil was withdrawn; MIDI is the control path
  },
};

api.window = createSynthWindow({
  state: parts.state, patches: () => PATCHES, guide, midiTrace: () => midiTrace.slice(),
  applyPatch, defaultProgram: DEFAULT_PROGRAM, link: linkState,
  enable, disable, enabled: () => enabled, panic, startReader: startReaderOnce,
  engineOf: parts.engineOf, ensurePart: (n) => parts.ensurePart(n).then(() => true),
});

globalThis.sonicPiSynth = api;
globalThis.sonicPiParts = {
  list: parts.list, has: parts.has, engineOf: parts.engineOf, ensure: parts.ensurePart, state: parts.state,
  noteOn: parts.noteOn, noteOff: parts.noteOff, setParam: parts.setParam, allNotesOff: parts.allNotesOff,
  free: parts.free, silence: parts.silence, rememberPreset: parts.rememberPreset, outState: parts.outState, cap: parts.capOf, attachToEngine: parts.attachToEngine, detach: parts.detach,
};
export { api as synthHost };
