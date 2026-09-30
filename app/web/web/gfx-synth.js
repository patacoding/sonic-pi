// SPDX-License-Identifier: AGPL-3.0-or-later
// Our own synthesizer, from the page's side: load the worklet, connect it to the engine's INPUT so Sonic
// Pi plays it, and expose an API a script or a panel can drive.
//
// Where it sits in the audio graph (the contract verified in docs/web-synth-engine.md §5):
//
//     gfx-synth-worklet.js  --connect-->  engine.node.input  --read by-->  synth :sound_in_stereo
//                                                                              |
//                                            mix / with_fx / scope / Recorder <
//
// So the sound is Sonic Pi's to process: `with_fx :reverb do synth :sound_in_stereo, sustain: 30 end`
// wraps it, and the Recorder captures it (it records the engine's output). No microphone is involved:
// connecting a node needs no permission.
//
// The engine boots lazily (on the first Run), so everything here waits for `window.sonicPi.engine`.

const WORKLET = new URL("gfx-synth-worklet.js", import.meta.url);

export const SYNTH_DEFAULTS = Object.freeze({
  gain: 0.25, wave: "saw", detune: 0,
  filter: { type: "lp", cutoff: 1200, q: 0.9, env: 0, keyTrack: 0 },
  amp: { a: 0.005, d: 0.12, s: 0.7, r: 0.3 },
  mod: { a: 0.001, d: 0.2, s: 0.3, r: 0.2 },
  lfo: { rate: 5, pitch: 0, cutoff: 0, amp: 0 },
});

/**
 * @param {{log?: (text: string) => void, say?: (text: string) => void}} opts
 */
export function createSynth({ log = null } = {}) {
  const say = (t) => (log ? log(`Graphics — ${t}`) : console.info(`Graphics — ${t}`));
  let node = null, ctx = null, loading = null, failed = null;
  const inbox = [];                    // the last few things the processor said (diagnostics)
  const patch = structuredClone(SYNTH_DEFAULTS);
  let inbound = false;      // is the output feeding the engine's input?
  let running = false;

  const engine = () => globalThis.sonicPi?.engine ?? null;

  /** The worklet needs an AudioContext, so this waits for the engine (first Run) to exist. */
  async function ensure() {
    if (node) return node;
    if (failed) throw failed;
    if (loading) return loading;
    loading = (async () => {
      const eng = engine();
      const context = eng?.audioContext ?? eng?.node?.context;
      if (!context) throw new Error("the engine is not up yet (press Run once)");
      if (!context.audioWorklet) throw new Error("this browser has no AudioWorklet");
      await context.audioWorklet.addModule(WORKLET);
      node = new AudioWorkletNode(context, "gfx-synth", {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      });
      ctx = context;
      // what the processor says back (its own stats, and any error it can tell us about)
      node.port.onmessage = (e) => { inbox.push(e.data); if (inbox.length > 24) inbox.shift(); };
      route(true);
      say("the synth is running (it feeds the engine's input; play it with `synth :sound_in_stereo`)");
      return node;
    })().catch((e) => { failed = e; loading = null; throw e; });
    return loading;
  }

  /** Our output belongs on the engine's input: that is what makes `with_fx`, the scope and the Recorder apply. */
  function route(on) {
    if (!node || !ctx) return false;
    const target = engine()?.node?.input ?? engine()?.node;
    try { node.disconnect(); } catch { /* not connected: fine */ }
    if (on && target) { node.connect(target); inbound = true; }
    else inbound = false;
    return inbound;
  }

  /** Absolute AudioContext seconds for a note, or null for "now". `lead` schedules it a little ahead. */
  const when = (secondsFromNow) => (secondsFromNow == null || !ctx ? null : ctx.currentTime + secondsFromNow);

  const send = (m) => { node?.port.postMessage(m); };

  return {
    get node() { return node; },
    get ready() { return !!node; },
    get inbound() { return inbound; },
    get context() { return ctx; },
    /** The processor's recent messages (its `stat` reports, voice notices): diagnostics for probes and the panel. */
    get messages() { return inbox; },
    ensure,
    route,
    /** `when` is seconds from NOW (the UI's natural unit); null = as soon as it arrives. */
    noteOn(note, { velocity = 1, when: at = null } = {}) { send({ type: "noteOn", note, velocity, when: when(at) }); return true; },
    noteOff(note, { when: at = null } = {}) { send({ type: "noteOff", note, when: when(at) }); return true; },
    allNotesOff({ when: at = null } = {}) { send({ type: "allNotesOff", when: when(at) }); return true; },
    /** Patch parameters, merged into the running patch: `set({ filter: { cutoff: 400 } })`. */
    set(part) {
      if (!part || typeof part !== "object") return patch;
      for (const [k, v] of Object.entries(part)) {
        if (v && typeof v === "object" && patch[k]) Object.assign(patch[k], v);
        else patch[k] = v;
      }
      send({ type: "patch", patch: part });
      return patch;
    },
    get patch() { return patch; },
    /** A wavetable, as harmonic amplitudes (additive: this is what the oscillator reads). */
    loadHarmonics(list) {
      if (!Array.isArray(list) && !(list instanceof Float32Array)) return false;
      send({ type: "table", harmonics: Array.from(list) });
      return true;
    },
    /** Re-route after an engine restart (the audio-restart overlay does exactly that to the engine). */
    restart() { const old = ctx; if (old && old.state === "closed") { node = null; loading = null; } return ensure(); },
  };
}
