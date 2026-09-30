// SPDX-License-Identifier: AGPL-3.0-or-later
// Our own synthesizer's DSP, in an AudioWorklet: a per-voice wavetable oscillator -> state-variable
// filter -> amplitude envelope, with an LFO and a small modulation matrix.
//
// Why an AudioWorklet and not a SynthDef: a SynthDef's graph is frozen when it is compiled (and there is
// no SuperCollider compiler in a browser), so the structure cannot change while the music plays. Here the
// structure is ours, in this file, and the patch/notes arrive as messages.
//
// It is heard THROUGH Sonic Pi: the node's output is connected to engine.node.input, and the music reads
// it back with `synth :sound_in_stereo` -- so `with_fx`, the scope and the Recorder all apply (verified,
// see docs/web-synth-engine.md §5).
//
// The message protocol (from web/gfx-synth.js):
//   { type: "patch", patch: {…} }                  parameters, applied immediately
//   { type: "table", harmonics: [...] }            a wavetable, as harmonic amplitudes
//   { type: "noteOn", note, velocity, when }       `when` is absolute AudioContext seconds (or null = now)
//   { type: "noteOff", note, when }
//   { type: "allNotesOff" }
//
// Everything here is allocation-free after construction: this runs on the audio thread.

const TABLE_SIZE = 2048;          // samples per mipmap level
const LEVELS = 11;                // harmonics 1, 2, 4, … 1024: picked by the note's frequency
const VOICES = 12;
const TWO_PI = Math.PI * 2;
// NOTE: `structuredClone` does NOT exist in AudioWorkletGlobalScope (measured: "Uncaught
// ReferenceError: structuredClone is not defined", which left a silently silent processor).
// The patch is plain data, so a JSON copy is enough.
const clone = (o) => JSON.parse(JSON.stringify(o));

/** A wavetable from harmonic amplitudes: tables[i] holds `2^i` harmonics (so a note reads a band-limited one). */
function buildTables(harmonics) {
  const tables = [];
  for (let level = 0; level < LEVELS; level++) {
    const max = Math.min(1 << level, harmonics.length);
    const t = new Float32Array(TABLE_SIZE + 1);       // +1: the guard point for linear interpolation
    let peak = 0;
    for (let i = 0; i < TABLE_SIZE; i++) {
      let v = 0;
      for (let h = 0; h < max; h++) {
        const a = harmonics[h];
        if (a) v += a * Math.sin(TWO_PI * (h + 1) * i / TABLE_SIZE);
      }
      t[i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
    if (peak > 0) for (let i = 0; i < TABLE_SIZE; i++) t[i] /= peak;   // normalise, whatever the spectrum
    t[TABLE_SIZE] = t[0];
    tables.push(t);
  }
  return tables;
}

/** The classic harmonic profiles, as amplitude-per-harmonic arrays (additive: this IS the wavetable). */
function profile(kind, count = 512) {
  const a = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const h = i + 1;
    if (kind === "saw") a[i] = 1 / h;
    else if (kind === "square") a[i] = h % 2 ? 1 / h : 0;
    else if (kind === "triangle") a[i] = h % 2 ? 1 / (h * h) * (h % 4 === 1 ? 1 : -1) : 0;
    else if (kind === "sine") a[i] = h === 1 ? 1 : 0;
  }
  return a;
}

const DEFAULTS = {
  gain: 0.25,
  wave: "saw",
  detune: 0,            // cents
  filter: { type: "lp", cutoff: 1200, q: 0.9, env: 0, keyTrack: 0 },
  amp: { a: 0.005, d: 0.12, s: 0.7, r: 0.3 },
  mod: { a: 0.001, d: 0.2, s: 0.3, r: 0.2, toFilter: 0 },
  lfo: { rate: 5, pitch: 0, cutoff: 0, amp: 0 },
};

class GfxSynth extends AudioWorkletProcessor {
  constructor() {
    super();
    this.patch = clone(DEFAULTS);
    this.tables = buildTables(profile("saw"));
    this.harmonics = null;
    this.voices = Array.from({ length: VOICES }, () => ({
      active: false, note: 60, velocity: 1, phase: 0,
      amp: 0, ampStage: "idle", mod: 0, modStage: "idle",
      ic1: 0, ic2: 0, age: 0, freq: 440, freqTarget: 440,
    }));
    this.lfoPhase = 0;
    this.age = 0;
    this.blocks = 0; this.peakSeen = 0;      // diagnostics: reported back to the page every ~60 blocks
    this.events = [];                     // scheduled note events: [{ when, run }]
    this.port.onmessage = (e) => this.#message(e.data);
  }

  #message(m) {
    if (!m || typeof m !== "object") return;
    if (m.type === "patch") {
      const p = m.patch ?? {};
      for (const [k, v] of Object.entries(p)) {
        if (k === "filter" || k === "amp" || k === "mod" || k === "lfo") Object.assign(this.patch[k], v);
        else this.patch[k] = v;
      }
      if (p.wave && !this.harmonics) this.tables = buildTables(profile(p.wave));
      return;
    }
    if (m.type === "table") {                                  // a wavetable the player supplied
      const h = m.harmonics;
      if (h && h.length) { this.harmonics = Float32Array.from(h); this.tables = buildTables(this.harmonics); }
      return;
    }
    if (m.type === "noteOn") return this.#schedule(m.when, () => this.#noteOn(m.note, m.velocity ?? 1));
    if (m.type === "noteOff") return this.#schedule(m.when, () => this.#noteOff(m.note));
    if (m.type === "allNotesOff") return this.#schedule(m.when, () => this.voices.forEach((v) => this.#release(v)));
  }

  #schedule(when, run) {
    if (when == null || when <= currentTime) { this.port.postMessage({ type: "sched", when: when ?? null, now: Number(currentTime.toFixed(4)), immediate: true }); return run(); }
    this.port.postMessage({ type: "sched", when: Number(when.toFixed(4)), now: Number(currentTime.toFixed(4)), immediate: false });
    this.events.push({ when, run });
    if (this.events.length > 256) this.events.splice(0, this.events.length - 256);
  }

  #noteOn(note, velocity) {
    let v = this.voices.find((x) => !x.active);
    if (!v) v = this.voices.reduce((a, b) => (a.age <= b.age ? a : b));   // steal the oldest
    v.active = true; v.note = note; v.velocity = velocity; v.age = ++this.age;
    v.freqTarget = 440 * Math.pow(2, (note - 69) / 12);
    if (!v.freq) v.freq = v.freqTarget;
    v.ampStage = "a"; v.modStage = "a";
    if (v.amp <= 0) { v.phase = 0; v.ic1 = 0; v.ic2 = 0; v.mod = 0; }
    this.port.postMessage({ type: "voice", note, on: true, at: Number(currentTime.toFixed(4)),
                            voices: this.voices.filter((x) => x.active).length });
  }

  #release(v) { if (v.active) { v.ampStage = "r"; v.modStage = "r"; } }

  #noteOff(note) {
    for (const v of this.voices) if (v.active && v.note === note && v.ampStage !== "r") this.#release(v);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const L = out[0], R = out.length > 1 ? out[1] : out[0];
    const n = L.length;
    L.fill(0);
    if (R !== L) R.fill(0);

    // scheduled events: applied at the block boundary (within one render quantum of their time)
    if (this.events.length) {
      const limit = currentTime + n / sampleRate;
      let keep = 0;
      for (let i = 0; i < this.events.length; i++) {
        const e = this.events[i];
        if (e.when <= limit) { this.port.postMessage({ type: "fired", when: Number(e.when.toFixed(4)), now: Number(currentTime.toFixed(4)) }); e.run(); }
        else this.events[keep++] = e;
      }
      this.events.length = keep;
    }

    const P = this.patch, sr = sampleRate;
    const amp = P.amp, mod = P.mod, lfo = P.lfo, f = P.filter;
    const lfoStep = lfo.rate / sr;
    const gTarget = Math.pow(10, P.detune / 1200);
    // ONE LFO, one phase: block-rate here (a value per 128 samples is smooth enough for vibrato and
    // tremolo; a per-sample LFO is a later refinement). It MUST advance once per block, not once per
    // voice, or its rate multiplies by the number of voices.
    const lfoValue = Math.sin(TWO_PI * this.lfoPhase);
    this.lfoPhase += lfoStep * n;
    this.lfoPhase -= Math.floor(this.lfoPhase);

    for (const v of this.voices) {
      if (!v.active) continue;
      // frequency (with portamento off: set at note-on; detune is a patch value)
      v.freq = v.freqTarget * gTarget;
      // the envelopes (amp + mod) are advanced INSIDE the sample loop below: their increments are
      // per-sample, and running them once per block made every stage 128x too long (a 0.1 s release took
      // 12.8 s, which is what made `noteOff` look broken). The FILTER coefficients stay per block, using
      // the modulation envelope's value at the start of the block: recomputing `tan()` per sample per voice
      // would cost more than the block-rate stepping is worth.

      // the mipmap level a band-limited table for this frequency needs
      const harmonicsWanted = Math.max(1, Math.floor(sr / (2 * Math.max(1, v.freq))));
      let level = 0;
      while (level < LEVELS - 1 && (1 << (level + 1)) <= harmonicsWanted) level++;
      const table = this.tables[level] ?? this.tables[this.tables.length - 1];

      // the per-voice filter's coefficients: cutoff from the patch, opened by the mod envelope, moved by
      // the LFO, tracked by the note (keyTrack 0..1 closes it as the note rises)
      const track = f.keyTrack ? Math.pow(2, (v.freq / 440 - 1) * f.keyTrack) : 1;
      let cutoff = f.cutoff * track * (1 + (f.env || 0) * v.mod * 6)
                 * Math.pow(2, (lfo.cutoff || 0) * lfoValue * 4);
      cutoff = Math.min(sr * 0.45, Math.max(20, cutoff));
      const g = Math.tan(Math.PI * cutoff / sr);
      const k = 1 / Math.max(0.05, f.q);
      const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;

      const inc = v.freq / sr;
      const pitchMod = Math.pow(2, (lfo.pitch || 0) * lfoValue);
      const ampMod = 1 + (lfo.amp || 0) * lfoValue;
      const step = 1 / sr;
      for (let i = 0; i < n; i++) {
        // envelopes, per sample (linear segments: cheap and predictable)
        switch (v.ampStage) {
          case "a": v.amp += step / Math.max(0.0005, amp.a); if (v.amp >= 1) { v.amp = 1; v.ampStage = "d"; } break;
          case "d": v.amp -= step / Math.max(0.0005, amp.d) * (1 - amp.s); if (v.amp <= amp.s) { v.amp = amp.s; v.ampStage = "s"; } break;
          case "s": v.amp = amp.s; break;
          case "r": v.amp -= step / Math.max(0.0005, amp.r) * Math.max(0.0001, amp.s); if (v.amp <= 0) { v.amp = 0; v.active = false; } break;
        }
        switch (v.modStage) {
          case "a": v.mod += step / Math.max(0.0005, mod.a); if (v.mod >= 1) { v.mod = 1; v.modStage = "d"; } break;
          case "d": v.mod -= step / Math.max(0.0005, mod.d) * (1 - mod.s); if (v.mod <= mod.s) { v.mod = mod.s; v.modStage = "s"; } break;
          case "s": v.mod = mod.s; break;
          case "r": v.mod -= step / Math.max(0.0005, mod.r) * Math.max(0.0001, mod.s); if (v.mod <= 0) { v.mod = 0; v.modStage = "idle"; } break;
        }
        if (!v.active) break;                       // the release finished mid-block: nothing more to add
        // wavetable read, linear interpolation, pitch modulation per sample
        v.phase += inc * pitchMod;
        if (v.phase >= 1) v.phase -= Math.floor(v.phase);
        const x = v.phase * TABLE_SIZE, i0 = x | 0, frac = x - i0;
        const s = table[i0] + (table[i0 + 1] - table[i0]) * frac;
        // TPT state-variable filter
        const hp = (s - (k + g) * v.ic1 - v.ic2) / (1 + g * (g + k));
        const bp = g * hp + v.ic1; v.ic1 = g * hp + bp;
        const lp = g * bp + v.ic2; v.ic2 = g * bp + lp;
        const y = f.type === "hp" ? hp : f.type === "bp" ? bp : lp;
        const a = v.amp * v.velocity * (ampMod) * P.gain;
        L[i] += y * a;
        if (R !== L) R[i] += y * a;
      }
    }

    // a gentle limiter, so a loud patch cannot clip the engine's input
    let blockPeak = 0;
    for (let i = 0; i < n; i++) {
      const l = Math.tanh(L[i]);
      if (R !== L) { const r = Math.tanh(R[i]); R[i] = r; }
      L[i] = l;
      const a = Math.abs(l);
      if (a > blockPeak) blockPeak = a;
    }
    this.peakSeen = Math.max(this.peakSeen, blockPeak);
    if (++this.blocks % 60 === 0) {
      this.port.postMessage({ type: "stat", blocks: this.blocks, active: this.voices.filter((v) => v.active).length,
                              peak: Number(this.peakSeen.toFixed(4)), sr: sampleRate, events: this.events.length });
      this.peakSeen = 0;
    }
    return true;
  }
}

registerProcessor("gfx-synth", GfxSynth);
