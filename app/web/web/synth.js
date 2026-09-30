// SPDX-License-Identifier: AGPL-3.0-or-later
// Our own synthesizer, from the page's side (window.sonicPiSynth; the glue is synth-host.js): load the worklet, connect it to the engine's INPUT so Sonic
// Pi plays it, and expose an API a script or a panel can drive.
//
// Where it sits in the audio graph (the contract verified in docs/web-synth-engine.md §5):
//
//     synth-worklet.js  --connect-->  engine.node.input  --read by-->  synth :sound_in_stereo
//                                                                              |
//                                            mix / with_fx / scope / Recorder <
//
// So the sound is Sonic Pi's to process: `with_fx :reverb do synth :sound_in_stereo, sustain: 30 end`
// wraps it, and the Recorder captures it (it records the engine's output). No microphone is involved:
// connecting a node needs no permission.
//
// The engine boots lazily (on the first Run), so everything here waits for `window.sonicPi.engine`.

const WORKLET = new URL("synth-worklet.js", import.meta.url);

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
  const say = (t) => (log ? log(`Synth — ${t}`) : console.info(`Synth — ${t}`));
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
      if (context.state !== "running") await context.resume().catch(() => {});   // a suspended context is silence with no error
      await context.audioWorklet.addModule(WORKLET);
      node = new AudioWorkletNode(context, "synth", {
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
    /**
     * A WAVETABLE the player supplies: a single-cycle .wav (or any audio file, squeezed into one cycle).
     *
     * Why it becomes harmonics instead of raw samples: the oscillator's tables are built additively, one
     * mipmap per bandwidth, so a table given as harmonic amplitudes arrives BAND-LIMITED for free (the
     * alternative -- shipping raw samples into the worklet -- would need its own anti-aliasing). The
     * conversion is a DFT of the cycle on this (non-audio) thread: 2048 samples x 512 harmonics.
     *
     * @param {File|Blob|Float32Array|AudioBuffer} source
     * @returns {Promise<{harmonics: Float32Array, samples: number, cycle: number, peak: number}>}
     */
    async loadWaveform(source) {
      const context = ctx ?? engine()?.audioContext ?? engine()?.node?.context;
      if (!context) throw new Error("the engine is not up yet (press Run once)");
      let data = null, name = "waveform";
      if (source instanceof AudioBuffer) data = source.getChannelData(0);
      else if (source instanceof Float32Array) data = source;
      else if (source && (source instanceof Blob || source instanceof File)) {
        name = source.name ?? name;
        const bytes = await source.arrayBuffer();
        const buffer = await context.decodeAudioData(bytes.slice(0));
        data = buffer.getChannelData(0);
      } else throw new Error("loadWaveform wants a File, a Blob, an AudioBuffer or a Float32Array");
      if (!data || !data.length) throw new Error(`${name}: no samples in it`);

      // One cycle, 2048 samples: a single-cycle file is used as it is; anything longer is squeezed into one
      // cycle (a wavetable is periodic by definition -- a proper period search is a later refinement).
      const CYCLE = 2048;
      let cycle = new Float32Array(CYCLE);
      let peak = 0;
      for (let i = 0; i < CYCLE; i++) {
        const x = (i / CYCLE) * data.length;
        const i0 = Math.floor(x), frac = x - i0;
        const a = data[i0 % data.length], b = data[(i0 + 1) % data.length];
        const v = a + (b - a) * frac;
        cycle[i] = v;
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
      if (peak > 0) for (let i = 0; i < CYCLE; i++) cycle[i] /= peak;

      // the harmonic amplitudes: a straight DFT, up to Nyquist/2 of the table (512 harmonics is plenty)
      const HARMONICS = 512;
      const harmonics = new Float32Array(HARMONICS);
      const cos = new Float32Array(HARMONICS + 1), sin = new Float32Array(HARMONICS + 1);
      for (let h = 1; h <= HARMONICS; h++) {
        const w = (2 * Math.PI * h) / CYCLE;
        cos[h] = Math.cos(w); sin[h] = Math.sin(w);
      }
      for (let h = 1; h <= HARMONICS; h++) {
        // Goertzel-style accumulation, one harmonic at a time (no complex bookkeeping)
        let re = 0, im = 0;
        let c = 1, s2 = 0;                       // cos(h*w*i), sin(h*w*i) by rotation
        for (let i = 0; i < CYCLE; i++) {
          re += cycle[i] * c;
          im += cycle[i] * s2;
          const nc = c * cos[h] - s2 * sin[h];
          s2 = c * sin[h] + s2 * cos[h];
          c = nc;
        }
        harmonics[h - 1] = (2 * Math.sqrt(re * re + im * im)) / CYCLE;
      }
      this.loadHarmonics(harmonics);
      say(`wavetable "${name}": ${data.length} samples -> one cycle of ${CYCLE}, ${HARMONICS} harmonics`);
      return { harmonics, samples: data.length, cycle: CYCLE, peak };
    },

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
