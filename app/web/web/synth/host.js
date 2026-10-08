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
import { parseSynthDirective, numbers, strings, COMMANDS } from "./directives.js";   // several timbres at once: one instance per named part

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
  let d = null, text = "";
  for (const c of candidates) { const q = parseSynthDirective(c); if (q) { d = q; text = c; break; } }
  // Record EVERY record we are handed, parsed or not: "nothing arrived" and "what arrived did not parse" are
  // different problems, and the first version could not tell them apart (it recorded only on success).
  if (!d) {
    trace.push({ at: Date.now(), parsed: false, kind: fields.kind ?? null, keys: Object.keys(fields).slice(0, 12),
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
globalThis.sonicPiSynth = api;
export { api as synthHost };
