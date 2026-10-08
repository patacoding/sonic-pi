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
};

globalThis.sonicPiSynth = api;
export { api as synthHost };
