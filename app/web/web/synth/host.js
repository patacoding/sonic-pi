// Our adapter: the only part of the synth integration that is ours.
//
// Soundgineer is the engine (vendor/soundgineer, built into ./vendor/); this file is the bridge between it and
// Sonic Pi, and it does exactly four things:
//
//   1. waits for the app's engine (it boots lazily on the first Run) instead of guessing when it exists,
//   2. starts Soundgineer ON THE ENGINE'S OWN AudioContext, so the two share one clock,
//   3. connects its node into engine.node.input -- the input bus the app already provides for the microphone --
//      so whatever the music reads with `synth :sound_in_stereo` gets with_fx, the mixer, the scope and the
//      Recorder for free (the contract our injection probes already measure 3/3),
//   4. leaves `connectToDestination` alone (we route; it must NOT also play straight to the speakers).
//
// Published as `window.sonicPiSynth`. Nothing here touches the app's DOM, and nothing is persisted.
import { SynthEngine } from "./vendor/soundgineer.js";
import * as parts from "./parts.js";
import { patchByProgram, PATCHES, guide } from "./patches.js";
import { parseSynthDirective, numbers, strings } from "./directives.js";
import { createSynthWindow } from "./window.js";   // several timbres at once: one instance per named part

export const SYNTH_ENABLED = true;

const say = (t, bad = false) => (bad ? console.error : console.info)(`Synth — ${t}`);

let sg = null;
let inputNode = null;
let booting = null;
let lastError = null;

/** The engine boots lazily on the first Run; wait for it rather than guessing when it exists. */
async function waitForEngine(timeoutMs = 20000) {
  const t0 = performance.now();
  for (;;) {
    const node = globalThis.sonicPi?.engine?.node?.input;
    if (node?.context) return node;
    if (performance.now() - t0 > timeoutMs) {
      throw new Error("the app's engine never appeared -- has anything been Run yet?");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function boot() {
  if (sg) return sg;
  if (booting) return booting;
  booting = (async () => {
    try {
      inputNode = await waitForEngine();
      const ctx = inputNode.context;                        // THE ENGINE'S context: one clock, sample-accurate
      sg = new SynthEngine();
      await sg.start({ ctx, connectToDestination: false });  // we route it, it must not also hit the speakers
      const node = sg.audioNode;
      if (!node) throw new Error("the engine handed back no node");
      node.connect(inputNode);
      sg.primeTables();                                      // the built-in wavetables: something for a note to play
      sg.setParamById("master.volume", 0.8);
      lastError = null;
      say(`connected into the engine's input bus (${ctx.sampleRate} Hz, ${inputNode.channelCount} channel(s))`);
      return sg;
    } catch (e) {
      lastError = String(e?.message ?? e);
      booting = null;
      say(`${lastError} — nothing will be heard until this is fixed`, true);
      return null;
    }
  })();
  return booting;
}

const trace = [];      // the last few records as they arrived: the instrument for "what does a puts look like here"

/**
 * A record from the app's music. We only read `:synth` lines, and we act on them immediately -- this instrument
 * does not keep time (see the multipart argument, 5.8).
 */
function handleRecord(r) {
  // The record's real shape (measured, not assumed): kind, t, beat, thread, name, event, line, output...
  // There is no field called `time`; `t` and `beat` are what the music knows about when it meant this.
  const fields = (r && typeof r === "object") ? r : {};
  const candidates = [fields.output, fields.text, fields.message, fields.value, fields.line, fields.name, fields.event,
    ...Object.values(fields)].filter((v) => typeof v === "string");
  // One `output` record can carry SEVERAL lines (three puts in one run arrived as one record), so split by line
  // and parse each: taking only the first line was why the other two directives silently did nothing.
  let d = null, text = "";
  for (const c of candidates) {
    for (const line of String(c).split(/\r?\n/)) {
      const q = parseSynthDirective(line);
      if (q) { d = q; text = line; break; }
    }
    if (d) break;
  }
  // Record EVERY record we are handed, parsed or not: "nothing arrived" and "what arrived did not parse" are
  // different problems, and the first version could not tell them apart (it recorded only on success).
  if (!d) {
    trace.push({ at: Date.now(), parsed: false, kind: fields.kind ?? null, keys: Object.keys(fields).slice(0, 12),
                 text: candidates.filter((c) => /synth/i.test(String(c))).map((c) => String(c).slice(0, 60)).join(" | ") || null,
                 strings: candidates.map((c) => String(c).slice(0, 40)).slice(0, 6), t: fields.t ?? null, beat: fields.beat ?? null });
    if (trace.length > 40) trace.shift();
    return false;
  }
  const entry = { at: Date.now(), clock: globalThis.sonicPi?.session?.clockNow?.() ?? null,
                  t: fields.t ?? null, beat: fields.beat ?? null, kind: fields.kind ?? null,
                  thread: fields.thread ?? null, line: fields.line ?? null, event: fields.event ?? null,
                  text: String(text).slice(0, 80),
                  part: d.part ?? null, command: d.command ?? null, args: numbers(d.args), strings: strings(d.args),
                  error: d.error ?? null };
  trace.push(entry); if (trace.length > 40) trace.shift();
  if (d.error) { say(`the music asked for something I do not understand: ${d.error}`, true); return false; }
  const n = numbers(d.args), str = strings(d.args);
  switch (d.command) {
    case "note": parts.noteOn(d.part, n[0], n[1] ?? 1); break;
    case "off": parts.noteOff(d.part, n[0]); break;
    case "alloff": case "panic": parts.allNotesOff(n.length ? d.part : null); break;
    case "param": if (str[0] != null && n.length) parts.setParam(d.part, str[0], n[n.length - 1]); break;
    case "mod": { const e = parts.engineOf(d.part); if (e && str[0] && str[1]) e.addModRoute?.(str[0], str[1], n[n.length - 1] ?? 0.25); break; }
    case "fx": { const e = parts.engineOf(d.part); if (e) e.setFxOrder?.(n); break; }
    case "free": parts.free(d.part); break;
    case "gate": say("`:synth, …, :gate` is not implemented yet", true); break;
    default: break;
  }
  return true;
}

/**
 * A performance signal on its way out to MIDI: `{ path, args, time }` (see midiSend in the app). Matching MIDI to
 * timbres is the natural scheme -- channel is the part -- but the argument order is measured, not assumed, so this
 * records what it sees before it acts on it.
 */
function handleMidi(...a) {
  const r = a[0] ?? {};
  const nums = (r.args ?? []).filter((x) => typeof x === "number");   // [channel, values…]
  const entry = { at: Date.now(), clock: globalThis.sonicPi?.session?.clockNow?.() ?? null, path: r.path ?? null,
                  args: (r.args ?? []).map((x) => (typeof x === "number" ? x : String(x).slice(0, 20))), time: r.time ?? null };
  const path = String(r.path ?? "");
  // The app documents the shape: "/clockwork/midi/out/<kind> <port> <channel> <values…>", so the first NUMBER is the
  // channel -- which is the natural part selector (channel 0 -> main, channel n -> chN).
  const channel = typeof nums[0] === "number" ? nums[0] : 0;
  const part = channel <= 0 ? "main" : `ch${channel}`;
  if (/note_on|noteon/i.test(path)) {
    const [, note, velocity] = nums;                      // [channel, note, velocity]
    entry.mapped = { command: "note", note, velocity };
    if (typeof note === "number") parts.noteOn(part, note, typeof velocity === "number" ? velocity / 127 : 1);
  } else if (/note_off|noteoff/i.test(path)) {
    const [, note] = nums; entry.mapped = { command: "off", note };
    if (typeof note === "number") parts.noteOff(part, note);
  } else if (/program_change|program/i.test(path)) {
    const [, program] = nums;                             // [channel, program]
    const patch = patchByProgram(program);
    entry.mapped = { command: "patch", program, patch: patch?.name ?? null };
    if (patch) { Promise.resolve(parts.ensurePart(part)).then(() => { for (const [id, v] of Object.entries(patch.params)) parts.setParam(part, id, v); }); }
  } else if (/control|cc/i.test(path)) {
    const [, cc, value] = nums;                           // [channel, cc, value]
    const PARAM_BY_CC = { 7: "master.volume", 74: "filter1.cutoff", 71: "filter1.resonance", 72: "env1.release", 73: "env1.attack" };
    const id = PARAM_BY_CC[cc];
    entry.mapped = { command: "cc", cc, value, param: id ?? null };
    if (id && typeof value === "number") parts.setParam(part, id, value / 127);
  } else {
    entry.mapped = null;
  }
  midiTrace.push(entry); if (midiTrace.length > 40) midiTrace.shift();
  return true;
}

const midiTrace = [];
/**
 * Watch the app's public engine boundary instead of asking upstream for a hook.
 *
 * Everything the music does reaches the engine as OSC through `window.sonicPi.engine.sendOSC` -- including the MIDI
 * it emits -- so wrapping that one public method gives us the performance signals with no edit to any upstream file.
 * Nothing else of ours touches the app: remove this layer and the synth is gone, which is the point.
 */
function installEngineObserver() {
  const wrap = () => {
    const e = globalThis.sonicPi?.engine;
    if (!e || typeof e.sendOSC !== "function" || e.__sgrObserved) return;
    const original = e.sendOSC.bind(e);
    e.sendOSC = (msg, ...rest) => {
      try {
        const address = msg?.address ?? msg?.path ?? (Array.isArray(msg) ? msg[0] : null);
        const args = msg?.args ?? (Array.isArray(msg) ? msg.slice(1) : []);
        if (address) observeOsc(String(address), args, msg?.time ?? null);
      } catch (err) { console.error(`Synth — observing the engine threw: ${err?.message ?? err}`); }
      return original(msg, ...rest);
    };
    e.__sgrObserved = true;
    console.info("Synth — watching the engine's OSC for performance signals");
  };
  wrap();
  setInterval(wrap, 2000);            // the engine is rebuilt on some runs; keep watching the current one
}

/** `/clockwork/midi/out/<kind> <port> <channel> <values…>` and friends -> the same mapping the direct hook used. */
function observeOsc(address, args, time) {
  const kind = address.includes("/midi/out/") ? address.split("/midi/out/")[1] : address;
  const path = kind ? `/${kind}` : address;
  if (!/note_on|note_off|control_change|program_change|pitch_bend|channel_pressure/i.test(path)) return false;
  return handleMidi({ path, args, time });
}

const api = {
  get ready() { return !!sg; },
  get error() { return lastError; },
  node: () => sg?.audioNode ?? null,
  engine: () => sg,
  /** What a probe or the window needs to know: is it running, how loud, how many voices, and why not. */
  state: () => ({
    running: !!sg,
    error: lastError,
    sampleRate: inputNode?.context?.sampleRate ?? null,
    connected: !!sg && !!inputNode,
    voices: sg?.voiceCount ?? 0,
    peak: Math.max(sg?.peakL ?? 0, sg?.peakR ?? 0),
    params: sg ? { volume: sg.getParamById?.("master.volume"), polyphony: sg.getParamById?.("master.polyphony") } : null,
  }),
  start: async () => !!(await boot()),
  noteOn: async (note, velocity = 1) => (await boot())?.noteOn(note, velocity),
  noteOff: (note) => sg?.noteOff(note),
  allNotesOff: () => sg?.allNotesOff?.(),
  /** By Soundgineer's own stable id (plan: native ids, so there is no mapping table of ours). */
  setParam: (id, value) => sg?.setParamById(id, value),
  params: () => sg?.values ?? null,
  handleRecord,
  trace: () => trace.slice(),
  handleMidi,
  midiTrace: () => midiTrace.slice(),
  watchEngine: installEngineObserver,
  /** What the window shows: how the music addresses this synth, and which number is which instrument. */
  guide,
  patches: () => PATCHES.map((p) => ({ ...p })),
};

// Multi-timbre: the music names the part explicitly, every time (`puts :synth, :bass, :note, 60`), so there is no
// "current part" to get out of step between live loops (docs/plan/soundgineer-multipart-argument.md §5.5).
api.parts = {
  ensure: (name) => parts.ensurePart(name).then(() => true),
  list: parts.list,
  has: parts.has,
  engine: parts.engineOf,
  noteOn: parts.noteOn,
  noteOff: parts.noteOff,
  setParam: parts.setParam,
  allNotesOff: parts.allNotesOff,
  free: parts.free,
  state: parts.state,
};
globalThis.sonicPiParts = api.parts;
// the window is ours: a button on the audio page and a popup that covers rather than rearranges (window.js)
api.window = createSynthWindow({
  state: parts.state, patches: () => PATCHES, guide, midiTrace: () => midiTrace.slice(),
});
globalThis.sonicPiSynth = api;
export { api as synthHost };
