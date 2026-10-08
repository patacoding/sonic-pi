"use strict";
(() => {
  // ../soundgineer/src/shared/params.ts
  var FILTER_TYPES = ["LP 12", "LP 24", "HP 12", "HP 24", "BP 12", "BP 24", "Notch", "Comb", "Formant"];
  var SUB_SHAPES = ["Sine", "Triangle", "Saw", "Square"];
  var NOISE_TYPES = ["White", "Pink", "Sample"];
  var DIST_TYPES = ["Off", "Soft Clip", "Hard Clip", "Wavefold", "Bitcrush"];
  var FILTER_ROUTINGS = ["Series", "Parallel"];
  var LFO_MODES = ["Trigger", "Free", "Sync"];
  var SYNC_DIVISIONS = ["1/1", "1/2", "1/2T", "1/4.", "1/4", "1/4T", "1/8.", "1/8", "1/8T", "1/16.", "1/16", "1/16T", "1/32"];
  var WAVETABLE_NAMES = ["Basic Shapes", "Harmonic Sweep", "PWM", "Vocal", "FM Bell", "Digital", "Custom"];
  function divisionToBeats(divIndex) {
    const base = [4, 2, 2, 1, 1, 1, 0.5, 0.5, 0.5, 0.25, 0.25, 0.25, 0.125];
    const name = SYNC_DIVISIONS[divIndex] ?? "1/4";
    let b = base[divIndex] ?? 1;
    if (name.endsWith(".")) b *= 1.5;
    if (name.endsWith("T")) b *= 2 / 3;
    return b;
  }
  var defs = [];
  function p(d) {
    defs.push(d);
    return defs.length - 1;
  }
  var pct = (v) => `${Math.round(v * 100)}%`;
  var hz = (v) => v >= 1e3 ? `${(v / 1e3).toFixed(2)} kHz` : `${v.toFixed(1)} Hz`;
  var ms = (v) => v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1e3)} ms`;
  var st = (v) => `${v > 0 ? "+" : ""}${Math.round(v)} st`;
  var db = (v) => `${v.toFixed(1)} dB`;
  p({ id: "master.volume", name: "Master", group: "global", min: 0, max: 1.5, def: 0.7, moddable: true, fmt: pct });
  p({ id: "master.bpm", name: "BPM", group: "global", min: 20, max: 300, def: 120, step: 1 });
  p({ id: "master.polyphony", name: "Voices", group: "global", min: 1, max: 16, def: 16, step: 1 });
  p({ id: "master.bend_range", name: "Bend Rng", group: "global", min: 1, max: 48, def: 2, step: 1 });
  for (let o = 1; o <= 3; o++) {
    const g = `osc${o}`;
    p({ id: `${g}.enabled`, name: "On", group: g, min: 0, max: 1, def: o === 1 ? 1 : 0, step: 1 });
    p({ id: `${g}.wavetable`, name: "Table", group: g, min: 0, max: WAVETABLE_NAMES.length - 1, def: 0, choices: WAVETABLE_NAMES });
    p({ id: `${g}.morph`, name: "Morph", group: g, min: 0, max: 1, def: 0, moddable: true, fmt: pct });
    p({ id: `${g}.level`, name: "Level", group: g, min: 0, max: 1, def: 0.7, moddable: true, fmt: pct });
    p({ id: `${g}.pan`, name: "Pan", group: g, min: -1, max: 1, def: 0, moddable: true, fmt: (v) => Math.abs(v) < 0.01 ? "C" : v < 0 ? `${Math.round(-v * 100)}L` : `${Math.round(v * 100)}R` });
    p({ id: `${g}.unison`, name: "Unison", group: g, min: 1, max: 16, def: 1, step: 1, fmt: (v) => `${Math.round(v)}v` });
    p({ id: `${g}.detune`, name: "Detune", group: g, min: 0, max: 100, def: 12, moddable: true, fmt: (v) => `${v.toFixed(0)} ct` });
    p({ id: `${g}.blend`, name: "Blend", group: g, min: 0, max: 1, def: 0.7, moddable: true, fmt: pct });
    p({ id: `${g}.spread`, name: "Spread", group: g, min: 0, max: 1, def: 0.6, moddable: true, fmt: pct });
    p({ id: `${g}.phase`, name: "Phase", group: g, min: 0, max: 1, def: 0, moddable: true, fmt: (v) => `${Math.round(v * 360)}\xB0` });
    p({ id: `${g}.phase_rand`, name: "Rand", group: g, min: 0, max: 1, def: 1, fmt: pct });
    p({ id: `${g}.transpose`, name: "Pitch", group: g, min: -48, max: 48, def: 0, step: 1, moddable: true, fmt: st });
    p({ id: `${g}.fine`, name: "Fine", group: g, min: -100, max: 100, def: 0, moddable: true, fmt: (v) => `${v.toFixed(0)} ct` });
    p({ id: `${g}.sync`, name: "Sync", group: g, min: 1, max: 4, def: 1, moddable: true, fmt: (v) => `${v.toFixed(2)}x` });
  }
  p({ id: "sub.enabled", name: "On", group: "sub", min: 0, max: 1, def: 0, step: 1 });
  p({ id: "sub.shape", name: "Shape", group: "sub", min: 0, max: 3, def: 0, choices: SUB_SHAPES });
  p({ id: "sub.level", name: "Level", group: "sub", min: 0, max: 1, def: 0.6, moddable: true, fmt: pct });
  p({ id: "sub.pan", name: "Pan", group: "sub", min: -1, max: 1, def: 0, moddable: true });
  p({ id: "sub.octave", name: "Octave", group: "sub", min: -3, max: 0, def: -1, step: 1, fmt: (v) => `${Math.round(v)} oct` });
  p({ id: "noise.enabled", name: "On", group: "noise", min: 0, max: 1, def: 0, step: 1 });
  p({ id: "noise.type", name: "Type", group: "noise", min: 0, max: 2, def: 0, choices: NOISE_TYPES });
  p({ id: "noise.level", name: "Level", group: "noise", min: 0, max: 1, def: 0.5, moddable: true, fmt: pct });
  p({ id: "noise.pan", name: "Pan", group: "noise", min: -1, max: 1, def: 0, moddable: true });
  p({ id: "noise.pitch", name: "Pitch", group: "noise", min: -24, max: 24, def: 0, moddable: true, fmt: st });
  for (let f = 1; f <= 2; f++) {
    const g = `filter${f}`;
    p({ id: `${g}.enabled`, name: "On", group: g, min: 0, max: 1, def: f === 1 ? 1 : 0, step: 1 });
    p({ id: `${g}.type`, name: "Type", group: g, min: 0, max: FILTER_TYPES.length - 1, def: 1, choices: FILTER_TYPES });
    p({ id: `${g}.cutoff`, name: "Cutoff", group: g, min: 20, max: 2e4, def: 8e3, curve: "exp", moddable: true, fmt: hz });
    p({ id: `${g}.resonance`, name: "Res", group: g, min: 0, max: 1, def: 0.2, moddable: true, fmt: pct });
    p({ id: `${g}.drive`, name: "Drive", group: g, min: 0, max: 1, def: 0, moddable: true, fmt: pct });
    p({ id: `${g}.keytrack`, name: "Key Trk", group: g, min: 0, max: 1, def: 0, moddable: true, fmt: pct });
    p({ id: `${g}.mix`, name: "Mix", group: g, min: 0, max: 1, def: 1, moddable: true, fmt: pct });
  }
  p({ id: "filter.routing", name: "Routing", group: "filterRouting", min: 0, max: 1, def: 0, choices: FILTER_ROUTINGS });
  p({ id: "dist.type", name: "Type", group: "dist", min: 0, max: DIST_TYPES.length - 1, def: 0, choices: DIST_TYPES });
  p({ id: "dist.drive", name: "Drive", group: "dist", min: 0, max: 1, def: 0.3, moddable: true, fmt: pct });
  p({ id: "dist.mix", name: "Mix", group: "dist", min: 0, max: 1, def: 1, moddable: true, fmt: pct });
  p({ id: "dist.bits", name: "Bits", group: "dist", min: 1, max: 16, def: 8, moddable: true, fmt: (v) => `${v.toFixed(1)} bit` });
  p({ id: "dist.downsample", name: "Rate", group: "dist", min: 1, max: 64, def: 1, curve: "exp", moddable: true, fmt: (v) => `\xF7${v.toFixed(1)}` });
  for (let e = 1; e <= 6; e++) {
    const g = `env${e}`;
    p({ id: `${g}.delay`, name: "Delay", group: g, min: 0, max: 2, def: 0, fmt: ms });
    p({ id: `${g}.attack`, name: "Attack", group: g, min: 1e-3, max: 10, def: e === 1 ? 5e-3 : 0.05, curve: "exp", moddable: true, fmt: ms });
    p({ id: `${g}.hold`, name: "Hold", group: g, min: 0, max: 2, def: 0, fmt: ms });
    p({ id: `${g}.decay`, name: "Decay", group: g, min: 1e-3, max: 10, def: 0.5, curve: "exp", moddable: true, fmt: ms });
    p({ id: `${g}.sustain`, name: "Sustain", group: g, min: 0, max: 1, def: e === 1 ? 0.8 : 0.5, moddable: true, fmt: pct });
    p({ id: `${g}.release`, name: "Release", group: g, min: 2e-3, max: 15, def: 0.2, curve: "exp", moddable: true, fmt: ms });
    p({ id: `${g}.atk_curve`, name: "A Curve", group: g, min: -1, max: 1, def: 0.4 });
    p({ id: `${g}.dec_curve`, name: "D Curve", group: g, min: -1, max: 1, def: -0.4 });
    p({ id: `${g}.rel_curve`, name: "R Curve", group: g, min: -1, max: 1, def: -0.4 });
  }
  for (let l = 1; l <= 8; l++) {
    const g = `lfo${l}`;
    p({ id: `${g}.rate`, name: "Rate", group: g, min: 0.01, max: 40, def: 2, curve: "exp", moddable: true, fmt: hz });
    p({ id: `${g}.sync`, name: "Sync", group: g, min: 0, max: 1, def: 1, step: 1 });
    p({ id: `${g}.division`, name: "Div", group: g, min: 0, max: SYNC_DIVISIONS.length - 1, def: 4, choices: SYNC_DIVISIONS });
    p({ id: `${g}.mode`, name: "Mode", group: g, min: 0, max: 2, def: 0, choices: LFO_MODES });
    p({ id: `${g}.phase`, name: "Phase", group: g, min: 0, max: 1, def: 0, fmt: pct });
    p({ id: `${g}.smooth`, name: "Smooth", group: g, min: 0, max: 1, def: 0, fmt: pct });
  }
  for (let m = 1; m <= 4; m++) {
    p({ id: `macro${m}.value`, name: `Macro ${m}`, group: "macros", min: 0, max: 1, def: 0, moddable: true, fmt: pct });
  }
  p({ id: "chorus.enabled", name: "On", group: "chorus", min: 0, max: 1, def: 0, step: 1 });
  p({ id: "chorus.rate", name: "Rate", group: "chorus", min: 0.05, max: 8, def: 0.4, curve: "exp", moddable: true, fmt: hz });
  p({ id: "chorus.depth", name: "Depth", group: "chorus", min: 0, max: 1, def: 0.5, moddable: true, fmt: pct });
  p({ id: "chorus.mix", name: "Mix", group: "chorus", min: 0, max: 1, def: 0.5, moddable: true, fmt: pct });
  p({ id: "phaser.enabled", name: "On", group: "phaser", min: 0, max: 1, def: 0, step: 1 });
  p({ id: "phaser.rate", name: "Rate", group: "phaser", min: 0.02, max: 10, def: 0.3, curve: "exp", moddable: true, fmt: hz });
  p({ id: "phaser.depth", name: "Depth", group: "phaser", min: 0, max: 1, def: 0.7, moddable: true, fmt: pct });
  p({ id: "phaser.feedback", name: "Fdbk", group: "phaser", min: 0, max: 0.95, def: 0.4, moddable: true, fmt: pct });
  p({ id: "phaser.mix", name: "Mix", group: "phaser", min: 0, max: 1, def: 0.5, moddable: true, fmt: pct });
  p({ id: "flanger.enabled", name: "On", group: "flanger", min: 0, max: 1, def: 0, step: 1 });
  p({ id: "flanger.rate", name: "Rate", group: "flanger", min: 0.02, max: 10, def: 0.25, curve: "exp", moddable: true, fmt: hz });
  p({ id: "flanger.depth", name: "Depth", group: "flanger", min: 0, max: 1, def: 0.6, moddable: true, fmt: pct });
  p({ id: "flanger.feedback", name: "Fdbk", group: "flanger", min: 0, max: 0.95, def: 0.5, moddable: true, fmt: pct });
  p({ id: "flanger.mix", name: "Mix", group: "flanger", min: 0, max: 1, def: 0.5, moddable: true, fmt: pct });
  p({ id: "delay.enabled", name: "On", group: "delay", min: 0, max: 1, def: 0, step: 1 });
  p({ id: "delay.sync", name: "Sync", group: "delay", min: 0, max: 1, def: 1, step: 1 });
  p({ id: "delay.division", name: "Div", group: "delay", min: 0, max: SYNC_DIVISIONS.length - 1, def: 7, choices: SYNC_DIVISIONS });
  p({ id: "delay.time", name: "Time", group: "delay", min: 0.01, max: 2, def: 0.35, curve: "exp", moddable: true, fmt: ms });
  p({ id: "delay.feedback", name: "Fdbk", group: "delay", min: 0, max: 0.98, def: 0.4, moddable: true, fmt: pct });
  p({ id: "delay.pingpong", name: "PingPong", group: "delay", min: 0, max: 1, def: 0, step: 1 });
  p({ id: "delay.mix", name: "Mix", group: "delay", min: 0, max: 1, def: 0.3, moddable: true, fmt: pct });
  p({ id: "reverb.enabled", name: "On", group: "reverb", min: 0, max: 1, def: 0, step: 1 });
  p({ id: "reverb.size", name: "Size", group: "reverb", min: 0, max: 1, def: 0.7, moddable: true, fmt: pct });
  p({ id: "reverb.damp", name: "Damp", group: "reverb", min: 0, max: 1, def: 0.5, moddable: true, fmt: pct });
  p({ id: "reverb.width", name: "Width", group: "reverb", min: 0, max: 1, def: 1, moddable: true, fmt: pct });
  p({ id: "reverb.mix", name: "Mix", group: "reverb", min: 0, max: 1, def: 0.3, moddable: true, fmt: pct });
  p({ id: "eq.enabled", name: "On", group: "eq", min: 0, max: 1, def: 0, step: 1 });
  p({ id: "eq.low_gain", name: "Low", group: "eq", min: -18, max: 18, def: 0, moddable: true, fmt: db });
  p({ id: "eq.mid_gain", name: "Mid", group: "eq", min: -18, max: 18, def: 0, moddable: true, fmt: db });
  p({ id: "eq.mid_freq", name: "Mid Freq", group: "eq", min: 100, max: 8e3, def: 1e3, curve: "exp", moddable: true, fmt: hz });
  p({ id: "eq.high_gain", name: "High", group: "eq", min: -18, max: 18, def: 0, moddable: true, fmt: db });
  p({ id: "comp.enabled", name: "On", group: "comp", min: 0, max: 1, def: 0, step: 1 });
  p({ id: "comp.threshold", name: "Thresh", group: "comp", min: -60, max: 0, def: -18, moddable: true, fmt: db });
  p({ id: "comp.ratio", name: "Ratio", group: "comp", min: 1, max: 20, def: 4, curve: "exp", fmt: (v) => `${v.toFixed(1)}:1` });
  p({ id: "comp.attack", name: "Attack", group: "comp", min: 5e-4, max: 0.2, def: 0.01, curve: "exp", fmt: ms });
  p({ id: "comp.release", name: "Release", group: "comp", min: 0.01, max: 2, def: 0.2, curve: "exp", fmt: ms });
  p({ id: "comp.makeup", name: "Makeup", group: "comp", min: 0, max: 24, def: 0, fmt: db });
  p({ id: "fxdist.enabled", name: "On", group: "fxdist", min: 0, max: 1, def: 0, step: 1 });
  p({ id: "fxdist.drive", name: "Drive", group: "fxdist", min: 0, max: 1, def: 0.4, moddable: true, fmt: pct });
  p({ id: "fxdist.tone", name: "Tone", group: "fxdist", min: 200, max: 18e3, def: 8e3, curve: "exp", moddable: true, fmt: hz });
  p({ id: "fxdist.mix", name: "Mix", group: "fxdist", min: 0, max: 1, def: 1, moddable: true, fmt: pct });
  var PARAMS = defs;
  var NUM_PARAMS = PARAMS.length;
  var indexById = /* @__PURE__ */ new Map();
  PARAMS.forEach((d, i) => indexById.set(d.id, i));
  function paramIndex(id) {
    const i = indexById.get(id);
    if (i === void 0) throw new Error(`unknown param: ${id}`);
    return i;
  }
  function normToValue(d, n) {
    n = n < 0 ? 0 : n > 1 ? 1 : n;
    if (d.choices) return Math.round(n * (d.choices.length - 1));
    let v;
    if (d.curve === "exp") v = d.min * Math.pow(d.max / d.min, n);
    else v = d.min + (d.max - d.min) * n;
    if (d.step) v = Math.round(v / d.step) * d.step;
    return v;
  }
  function valueToNorm(d, v) {
    if (d.choices) return d.choices.length > 1 ? v / (d.choices.length - 1) : 0;
    let n;
    if (d.curve === "exp") n = Math.log(v / d.min) / Math.log(d.max / d.min);
    else n = (v - d.min) / (d.max - d.min);
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }
  function defaultNorm(d) {
    return valueToNorm(d, d.def);
  }
  function defaultValues() {
    const a = new Float32Array(NUM_PARAMS);
    for (let i = 0; i < NUM_PARAMS; i++) a[i] = defaultNorm(PARAMS[i]);
    return a;
  }

  // ../soundgineer/src/shared/messages.ts
  var MOD_SOURCES = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `env${i + 1}`, name: `Env ${i + 1}`, perVoice: true, bipolar: false })),
    ...Array.from({ length: 8 }, (_, i) => ({ id: `lfo${i + 1}`, name: `LFO ${i + 1}`, perVoice: true, bipolar: false })),
    { id: "velocity", name: "Velocity", perVoice: true, bipolar: false },
    { id: "keytrack", name: "Key Track", perVoice: true, bipolar: true },
    { id: "random", name: "Random", perVoice: true, bipolar: false },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `macro${i + 1}`, name: `Macro ${i + 1}`, perVoice: false, bipolar: false })),
    { id: "modwheel", name: "Mod Wheel", perVoice: false, bipolar: false },
    { id: "pitchwheel", name: "Pitch Whl", perVoice: false, bipolar: true },
    { id: "aftertouch", name: "Pressure", perVoice: false, bipolar: false }
  ];
  var NUM_MOD_SOURCES = MOD_SOURCES.length;
  var MAX_MOD_SLOTS = 32;
  var MAX_VOICES = 16;
  var MAX_UNISON = 16;
  var FX_IDS = ["chorus", "phaser", "flanger", "delay", "reverb", "eq", "comp", "fxdist"];
  var DEFAULT_FX_ORDER = FX_IDS.map((_, i) => i);
  function defaultLfoShape() {
    return [
      { x: 0, y: 0, power: 0 },
      { x: 0.5, y: 1, power: 0 },
      { x: 1, y: 0, power: 0 }
    ];
  }
  function evalLfoShape(points, phase) {
    if (points.length === 0) return 0;
    if (phase <= points[0].x) return points[0].y;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (phase <= b.x) {
        const span = b.x - a.x;
        if (span <= 1e-9) return b.y;
        let t = (phase - a.x) / span;
        const pow = Math.pow(2, a.power * 4);
        t = Math.pow(t, pow);
        return a.y + (b.y - a.y) * t;
      }
    }
    return points[points.length - 1].y;
  }

  // ../soundgineer/src/shared/wavetable-gen.ts
  var NUM_MIPS = 11;

  // ../soundgineer/src/worklet/dsp.ts
  var WavetableData = class {
    frameSize;
    numFrames;
    mips;
    constructor(mipData, frameSize, numFrames) {
      this.frameSize = frameSize;
      this.numFrames = numFrames;
      this.mips = new Array(numFrames * NUM_MIPS);
      for (let i = 0; i < numFrames * NUM_MIPS; i++) {
        this.mips[i] = mipData.subarray(i * frameSize, (i + 1) * frameSize);
      }
    }
    /** Pick the mip whose highest harmonic stays below Nyquist for phaseInc (cycles/sample). */
    mipForInc(phaseInc) {
      const audible = 0.5 / Math.max(phaseInc, 1e-9);
      let m = 0;
      while (m < NUM_MIPS - 1 && 1024 >> m > audible) m++;
      return m;
    }
    /** Read with frame morph (pos 0..1) and linear sample interpolation. */
    read(pos, phase, mip) {
      const fpos = pos * (this.numFrames - 1);
      let f0 = Math.floor(fpos);
      if (f0 >= this.numFrames - 1) f0 = this.numFrames - 2;
      if (f0 < 0) f0 = 0;
      const ft = this.numFrames > 1 ? fpos - f0 : 0;
      const n = this.frameSize;
      const idx2 = phase * n;
      const i0 = idx2 | 0;
      const st2 = idx2 - i0;
      const i1 = i0 + 1 >= n ? 0 : i0 + 1;
      const a = this.mips[f0 * NUM_MIPS + mip];
      const s0 = a[i0] + (a[i1] - a[i0]) * st2;
      if (ft === 0 || this.numFrames === 1) return s0;
      const b = this.mips[(f0 + 1) * NUM_MIPS + mip];
      const s1 = b[i0] + (b[i1] - b[i0]) * st2;
      return s0 + (s1 - s0) * ft;
    }
  };
  function curveShape(t, c) {
    return Math.pow(t, Math.pow(2, c * 3));
  }
  var Envelope = class {
    stage = 0 /* Idle */;
    t = 0;
    // seconds into current stage
    level = 0;
    releaseFrom = 0;
    dt;
    constructor(sr, blockSize) {
      this.dt = blockSize / sr;
    }
    trigger() {
      this.stage = 1 /* Delay */;
      this.t = 0;
    }
    gateOff() {
      if (this.stage !== 0 /* Idle */ && this.stage !== 7 /* Kill */ && this.stage !== 6 /* Release */) {
        this.releaseFrom = this.level;
        this.stage = 6 /* Release */;
        this.t = 0;
      }
    }
    /** Fast fade for voice stealing. */
    kill() {
      if (this.stage !== 0 /* Idle */) {
        this.releaseFrom = this.level;
        this.stage = 7 /* Kill */;
        this.t = 0;
      }
    }
    get idle() {
      return this.stage === 0 /* Idle */;
    }
    get releasing() {
      return this.stage === 6 /* Release */ || this.stage === 7 /* Kill */;
    }
    get value() {
      return this.level;
    }
    /** Advance one block and return the envelope level at the END of the block. */
    process(p2) {
      this.t += this.dt;
      switch (this.stage) {
        case 0 /* Idle */:
          this.level = 0;
          break;
        case 1 /* Delay */:
          this.level = 0;
          if (this.t >= p2.delay) {
            this.stage = 2 /* Attack */;
            this.t = 0;
          }
          break;
        case 2 /* Attack */:
          if (this.t >= p2.attack) {
            this.level = 1;
            this.stage = 3 /* Hold */;
            this.t = 0;
          } else this.level = curveShape(this.t / p2.attack, p2.atkCurve);
          break;
        case 3 /* Hold */:
          this.level = 1;
          if (this.t >= p2.hold) {
            this.stage = 4 /* Decay */;
            this.t = 0;
          }
          break;
        case 4 /* Decay */:
          if (this.t >= p2.decay) {
            this.level = p2.sustain;
            this.stage = 5 /* Sustain */;
            this.t = 0;
          } else this.level = p2.sustain + (1 - p2.sustain) * (1 - curveShape(this.t / p2.decay, -p2.decCurve));
          break;
        case 5 /* Sustain */:
          this.level = p2.sustain;
          break;
        case 6 /* Release */:
          if (this.t >= p2.release) {
            this.level = 0;
            this.stage = 0 /* Idle */;
          } else this.level = this.releaseFrom * (1 - curveShape(this.t / p2.release, -p2.relCurve));
          break;
        case 7 /* Kill */: {
          const killTime = 4e-3;
          if (this.t >= killTime) {
            this.level = 0;
            this.stage = 0 /* Idle */;
          } else this.level = this.releaseFrom * (1 - this.t / killTime);
          break;
        }
      }
      return this.level;
    }
  };
  var Lfo = class {
    phase = 0;
    smoothed = 0;
    dt;
    constructor(sr, blockSize) {
      this.dt = blockSize / sr;
    }
    trigger(startPhase) {
      this.phase = startPhase % 1;
      this.smoothed = 0;
    }
    /**
     * Advance one block.
     * mode: 0 = Trigger (own phase), 1 = Free (follow globalPhase), 2 = Sync (beat-locked).
     */
    process(points, freq, mode, globalPhase, beatPhase, smooth) {
      let ph;
      if (mode === 1) ph = globalPhase;
      else if (mode === 2) ph = beatPhase;
      else {
        this.phase = (this.phase + freq * this.dt) % 1;
        ph = this.phase;
      }
      const raw = evalLfoShape(points, ph);
      if (smooth <= 1e-3) {
        this.smoothed = raw;
        return raw;
      }
      const k = 1 - Math.exp(-this.dt / (smooth * 0.25));
      this.smoothed += (raw - this.smoothed) * k;
      return this.smoothed;
    }
  };
  var SvfChannel = class {
    ic1 = 0;
    ic2 = 0;
    process(x, g, k, mode) {
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const a3 = g * a2;
      const v3 = x - this.ic2;
      const v1 = a1 * this.ic1 + a2 * v3;
      const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
      this.ic1 = 2 * v1 - this.ic1;
      this.ic2 = 2 * v2 - this.ic2;
      const lp = v2;
      const bp = v1;
      const hp = x - k * v1 - v2;
      switch (mode) {
        case 0:
          return lp;
        case 1:
          return hp;
        case 2:
          return bp * k;
        // gain-compensated bandpass
        default:
          return x - k * bp;
      }
    }
    reset() {
      this.ic1 = 0;
      this.ic2 = 0;
    }
  };
  var COMB_SIZE = 4096;
  var VoiceFilter = class {
    s1 = [new SvfChannel(), new SvfChannel()];
    s2 = [new SvfChannel(), new SvfChannel()];
    formant = [
      [new SvfChannel(), new SvfChannel(), new SvfChannel()],
      [new SvfChannel(), new SvfChannel(), new SvfChannel()]
    ];
    comb = [new Float32Array(COMB_SIZE), new Float32Array(COMB_SIZE)];
    combPos = 0;
    combLp = [0, 0];
    sr;
    constructor(sr) {
      this.sr = sr;
    }
    reset() {
      for (const c of this.s1) c.reset();
      for (const c of this.s2) c.reset();
      for (const row of this.formant) for (const c of row) c.reset();
      this.comb[0].fill(0);
      this.comb[1].fill(0);
      this.combLp[0] = this.combLp[1] = 0;
      this.combPos = 0;
    }
    /**
     * Process a stereo block in place.
     * type: FILTER_TYPES index. drive 0..1, mix 0..1.
     */
    process(l, r, n, type, cutoff, res, drive, mix) {
      const driveGain = 1 + drive * 9;
      const driveComp = 1 / Math.sqrt(driveGain);
      const wet = mix;
      const dry = 1 - mix;
      if (type <= 6) {
        const mode = type <= 1 ? 0 : type <= 3 ? 1 : type <= 5 ? 2 : 3;
        const twoPole = type === 1 || type === 3 || type === 5;
        const fc = Math.min(Math.max(cutoff, 10), this.sr * 0.49);
        const g = Math.tan(Math.PI * fc / this.sr);
        const k2 = 2 - 1.98 * Math.min(res, 0.99);
        for (let ch = 0; ch < 2; ch++) {
          const buf = ch === 0 ? l : r;
          const f1 = this.s1[ch];
          const f2 = this.s2[ch];
          for (let i = 0; i < n; i++) {
            const x = drive > 1e-3 ? Math.tanh(buf[i] * driveGain) * driveComp : buf[i];
            let y = f1.process(x, g, k2, mode);
            if (twoPole) y = f2.process(y, g, Math.max(k2, 1), mode);
            buf[i] = dry * buf[i] + wet * y;
          }
        }
        return;
      }
      if (type === 7) {
        const delay = Math.min(COMB_SIZE - 2, Math.max(2, this.sr / Math.max(cutoff, 20)));
        const fb = 0.5 + res * 0.48;
        for (let i = 0; i < n; i++) {
          const readPos = (this.combPos - delay + COMB_SIZE) % COMB_SIZE;
          const ri = readPos | 0;
          const rf = readPos - ri;
          for (let ch = 0; ch < 2; ch++) {
            const buf = ch === 0 ? l : r;
            const cb = this.comb[ch];
            const dl = cb[ri] + (cb[(ri + 1) % COMB_SIZE] - cb[ri]) * rf;
            this.combLp[ch] += (dl - this.combLp[ch]) * 0.6;
            const x = drive > 1e-3 ? Math.tanh(buf[i] * driveGain) * driveComp : buf[i];
            const y = x + this.combLp[ch] * fb;
            cb[this.combPos] = y;
            buf[i] = dry * buf[i] + wet * y * 0.5;
          }
          this.combPos = (this.combPos + 1) % COMB_SIZE;
        }
        return;
      }
      const vowels = [
        [800, 1150, 2900],
        [400, 2e3, 2800],
        [250, 2300, 3e3],
        [400, 800, 2600],
        [350, 600, 2700]
      ];
      const norm = Math.min(Math.max(Math.log(cutoff / 20) / Math.log(1e3), 0), 1) * (vowels.length - 1);
      const v0 = Math.min(Math.floor(norm), vowels.length - 2);
      const vt = norm - v0;
      const k = 2 - 1.9 * Math.min(0.3 + res * 0.7, 0.99);
      for (let b = 0; b < 3; b++) {
        const f = vowels[v0][b] + (vowels[v0 + 1][b] - vowels[v0][b]) * vt;
        const g = Math.tan(Math.PI * Math.min(f, this.sr * 0.45) / this.sr);
        const gains = [1, 0.6, 0.35];
        for (let ch = 0; ch < 2; ch++) {
          const buf = ch === 0 ? l : r;
          const svf = this.formant[ch][b];
          for (let i = 0; i < n; i++) {
            const x = b === 0 ? drive > 1e-3 ? Math.tanh(buf[i] * driveGain) * driveComp : buf[i] : buf[i];
            const y = svf.process(x, g, k, 2) * gains[b] * 2.5;
            if (b === 0) buf[i] = dry * buf[i] + wet * y;
            else buf[i] += wet * y;
          }
        }
      }
    }
  };
  function noteToFreq(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  // ../soundgineer/src/worklet/voice.ts
  function idx(id) {
    return paramIndex(id);
  }
  var OSC_IDX = [1, 2, 3].map((o) => ({
    enabled: idx(`osc${o}.enabled`),
    wavetable: idx(`osc${o}.wavetable`),
    morph: idx(`osc${o}.morph`),
    level: idx(`osc${o}.level`),
    pan: idx(`osc${o}.pan`),
    unison: idx(`osc${o}.unison`),
    detune: idx(`osc${o}.detune`),
    blend: idx(`osc${o}.blend`),
    spread: idx(`osc${o}.spread`),
    phase: idx(`osc${o}.phase`),
    phaseRand: idx(`osc${o}.phase_rand`),
    transpose: idx(`osc${o}.transpose`),
    fine: idx(`osc${o}.fine`),
    sync: idx(`osc${o}.sync`)
  }));
  var SUB_IDX = {
    enabled: idx("sub.enabled"),
    shape: idx("sub.shape"),
    level: idx("sub.level"),
    pan: idx("sub.pan"),
    octave: idx("sub.octave")
  };
  var NOISE_IDX = {
    enabled: idx("noise.enabled"),
    type: idx("noise.type"),
    level: idx("noise.level"),
    pan: idx("noise.pan"),
    pitch: idx("noise.pitch")
  };
  var FILT_IDX = [1, 2].map((f) => ({
    enabled: idx(`filter${f}.enabled`),
    type: idx(`filter${f}.type`),
    cutoff: idx(`filter${f}.cutoff`),
    resonance: idx(`filter${f}.resonance`),
    drive: idx(`filter${f}.drive`),
    keytrack: idx(`filter${f}.keytrack`),
    mix: idx(`filter${f}.mix`)
  }));
  var FILTER_ROUTING_IDX = idx("filter.routing");
  var DIST_IDX = {
    type: idx("dist.type"),
    drive: idx("dist.drive"),
    mix: idx("dist.mix"),
    bits: idx("dist.bits"),
    downsample: idx("dist.downsample")
  };
  var ENV_IDX = [1, 2, 3, 4, 5, 6].map((e) => ({
    delay: idx(`env${e}.delay`),
    attack: idx(`env${e}.attack`),
    hold: idx(`env${e}.hold`),
    decay: idx(`env${e}.decay`),
    sustain: idx(`env${e}.sustain`),
    release: idx(`env${e}.release`),
    atkCurve: idx(`env${e}.atk_curve`),
    decCurve: idx(`env${e}.dec_curve`),
    relCurve: idx(`env${e}.rel_curve`)
  }));
  var LFO_IDX = [1, 2, 3, 4, 5, 6, 7, 8].map((l) => ({
    rate: idx(`lfo${l}.rate`),
    sync: idx(`lfo${l}.sync`),
    division: idx(`lfo${l}.division`),
    mode: idx(`lfo${l}.mode`),
    phase: idx(`lfo${l}.phase`),
    smooth: idx(`lfo${l}.smooth`)
  }));
  var MACRO_IDX = [1, 2, 3, 4].map((m) => idx(`macro${m}.value`));
  var MASTER_IDX = {
    volume: idx("master.volume"),
    bpm: idx("master.bpm"),
    polyphony: idx("master.polyphony"),
    bendRange: idx("master.bend_range")
  };
  var SRC_ENV0 = 0;
  var SRC_LFO0 = 6;
  var SRC_VELOCITY = 14;
  var SRC_KEYTRACK = 15;
  var SRC_RANDOM = 16;
  var SRC_MACRO0 = 17;
  var SRC_MODWHEEL = 21;
  var SRC_PITCHWHEEL = 22;
  var SRC_AFTERTOUCH = 23;
  var envParamScratch = {
    delay: 0,
    attack: 0,
    hold: 0,
    decay: 0,
    sustain: 0,
    release: 0,
    atkCurve: 0,
    decCurve: 0,
    relCurve: 0
  };
  var Voice = class {
    constructor(sr, blockSize) {
      this.sr = sr;
      this.envs = Array.from({ length: 6 }, () => new Envelope(sr, blockSize));
      this.lfos = Array.from({ length: 8 }, () => new Lfo(sr, blockSize));
      this.filters = [new VoiceFilter(sr), new VoiceFilter(sr)];
      this.bufL = new Float32Array(blockSize);
      this.bufR = new Float32Array(blockSize);
      this.tmpL = new Float32Array(blockSize);
      this.tmpR = new Float32Array(blockSize);
    }
    sr;
    note = 60;
    velocity = 1;
    gate = false;
    sustained = false;
    // held only by sustain pedal
    age = 0;
    sources = new Float32Array(NUM_MOD_SOURCES);
    modOffsets = new Float32Array(NUM_PARAMS);
    phases = new Float64Array(3 * MAX_UNISON);
    subPhase = 0;
    samplePos = 0;
    random = 0;
    prevAmp = 0;
    envs;
    lfos;
    filters;
    bufL;
    bufR;
    tmpL;
    tmpR;
    distHoldL = 0;
    distHoldR = 0;
    distCount = 0;
    pink = [0, 0, 0];
    get active() {
      return !this.envs[0].idle;
    }
    get releasing() {
      return this.envs[0].releasing;
    }
    get ampLevel() {
      return this.envs[0].value;
    }
    noteOn(note, velocity, age, ctx) {
      this.note = note;
      this.velocity = velocity;
      this.gate = true;
      this.sustained = false;
      this.age = age;
      this.random = Math.random();
      this.samplePos = 0;
      this.prevAmp = 0;
      this.subPhase = 0;
      this.distHoldL = this.distHoldR = 0;
      this.distCount = 0;
      for (let o = 0; o < 3; o++) {
        const startPhase = ctx.base[OSC_IDX[o].phase];
        const rand = ctx.base[OSC_IDX[o].phaseRand];
        for (let u = 0; u < MAX_UNISON; u++) {
          this.phases[o * MAX_UNISON + u] = (startPhase + rand * Math.random()) % 1;
        }
      }
      for (const env of this.envs) env.trigger();
      for (let l = 0; l < 8; l++) {
        this.lfos[l].trigger(ctx.base[LFO_IDX[l].phase]);
      }
      for (const f of this.filters) f.reset();
      this.modOffsets.fill(0);
      this.sources.fill(0);
      this.sources[SRC_VELOCITY] = velocity;
      this.sources[SRC_KEYTRACK] = Math.max(-1, Math.min(1, (note - 60) / 36));
      this.sources[SRC_RANDOM] = this.random;
    }
    noteOff() {
      this.gate = false;
      this.sustained = false;
      for (const env of this.envs) env.gateOff();
    }
    /** Drop stale offsets after the mod matrix changes (removed routes). */
    clearMods() {
      this.modOffsets.fill(0);
    }
    kill() {
      for (const env of this.envs) env.kill();
    }
    /** normalized param value with modulation applied, mapped to raw units */
    pv(index, ctx) {
      return normToValue(PARAMS[index], ctx.base[index] + this.modOffsets[index]);
    }
    computeMods(ctx) {
      for (let m = 0; m < 4; m++) this.sources[SRC_MACRO0 + m] = ctx.base[MACRO_IDX[m]];
      this.sources[SRC_MODWHEEL] = ctx.modWheel;
      this.sources[SRC_PITCHWHEEL] = ctx.pitchBend;
      this.sources[SRC_AFTERTOUCH] = ctx.aftertouch;
      for (const [dest, routes] of ctx.routesByDest) {
        let sum = 0;
        for (let i = 0; i < routes.length; i++) sum += routes[i].depth * this.sources[routes[i].source];
        this.modOffsets[dest] = sum;
      }
    }
    advanceModulators(ctx) {
      for (let e = 0; e < 6; e++) {
        const ix = ENV_IDX[e];
        envParamScratch.delay = this.pv(ix.delay, ctx);
        envParamScratch.attack = this.pv(ix.attack, ctx);
        envParamScratch.hold = this.pv(ix.hold, ctx);
        envParamScratch.decay = this.pv(ix.decay, ctx);
        envParamScratch.sustain = this.pv(ix.sustain, ctx);
        envParamScratch.release = this.pv(ix.release, ctx);
        envParamScratch.atkCurve = this.pv(ix.atkCurve, ctx);
        envParamScratch.decCurve = this.pv(ix.decCurve, ctx);
        envParamScratch.relCurve = this.pv(ix.relCurve, ctx);
        this.sources[SRC_ENV0 + e] = this.envs[e].process(envParamScratch);
      }
      for (let l = 0; l < 8; l++) {
        const ix = LFO_IDX[l];
        const mode = Math.round(normToValue(PARAMS[ix.mode], ctx.base[ix.mode]));
        const smooth = ctx.base[ix.smooth];
        this.sources[SRC_LFO0 + l] = this.lfos[l].process(
          ctx.lfoShapes[l],
          ctx.lfoFreqs[l],
          mode,
          ctx.lfoGlobalPhases[l],
          ctx.lfoBeatPhases[l],
          smooth
        );
      }
    }
    /** Render one block, mixing into outL/outR. Returns false when the voice has finished. */
    render(ctx, outL, outR, n) {
      this.computeMods(ctx);
      this.advanceModulators(ctx);
      if (!this.active) return false;
      const bufL = this.bufL;
      const bufR = this.bufR;
      bufL.fill(0, 0, n);
      bufR.fill(0, 0, n);
      const baseFreq = noteToFreq(this.note + ctx.pitchBend * ctx.bendRange);
      for (let o = 0; o < 3; o++) {
        const ix = OSC_IDX[o];
        if (ctx.base[ix.enabled] < 0.5) continue;
        const table = ctx.tables[o];
        if (!table) continue;
        const morph = Math.max(0, Math.min(1, ctx.base[ix.morph] + this.modOffsets[ix.morph]));
        const level = this.pv(ix.level, ctx);
        if (level <= 1e-4) continue;
        const pan = this.pv(ix.pan, ctx);
        const unison = Math.max(1, Math.min(MAX_UNISON, Math.round(this.pv(ix.unison, ctx))));
        const detune = this.pv(ix.detune, ctx);
        const blend = this.pv(ix.blend, ctx);
        const spread = this.pv(ix.spread, ctx);
        const transpose = this.pv(ix.transpose, ctx);
        const fine = this.pv(ix.fine, ctx);
        const sync = this.pv(ix.sync, ctx);
        const freq = baseFreq * Math.pow(2, (transpose + fine / 100) / 12);
        let norm = 0;
        for (let u = 0; u < unison; u++) {
          const off = unison === 1 ? 0 : 2 * u / (unison - 1) - 1;
          const w = (1 - blend) * (1 - Math.abs(off)) + blend;
          norm += w * w;
        }
        norm = 1 / Math.sqrt(Math.max(norm, 1e-9));
        for (let u = 0; u < unison; u++) {
          const off = unison === 1 ? 0 : 2 * u / (unison - 1) - 1;
          const ratio = Math.pow(2, detune * off / 1200);
          const inc = freq * ratio / this.sr;
          if (inc >= 0.5) continue;
          const w = ((1 - blend) * (1 - Math.abs(off)) + blend) * norm * level;
          const p2 = Math.max(-1, Math.min(1, pan + spread * off * 0.9));
          const gl = w * Math.cos((p2 + 1) * Math.PI / 4);
          const gr = w * Math.sin((p2 + 1) * Math.PI / 4);
          const mip = table.mipForInc(inc * sync);
          let phase = this.phases[o * MAX_UNISON + u];
          if (sync <= 1.001) {
            for (let i = 0; i < n; i++) {
              phase += inc;
              if (phase >= 1) phase -= 1;
              const s = table.read(morph, phase, mip);
              bufL[i] += s * gl;
              bufR[i] += s * gr;
            }
          } else {
            for (let i = 0; i < n; i++) {
              phase += inc;
              if (phase >= 1) phase -= 1;
              const sp = phase * sync % 1;
              const s = table.read(morph, sp, mip);
              bufL[i] += s * gl;
              bufR[i] += s * gr;
            }
          }
          this.phases[o * MAX_UNISON + u] = phase;
        }
      }
      if (ctx.base[SUB_IDX.enabled] >= 0.5) {
        const level = this.pv(SUB_IDX.level, ctx);
        if (level > 1e-4) {
          const pan = this.pv(SUB_IDX.pan, ctx);
          const shape = Math.round(normToValue(PARAMS[SUB_IDX.shape], ctx.base[SUB_IDX.shape]));
          const oct = this.pv(SUB_IDX.octave, ctx);
          const inc = baseFreq * Math.pow(2, oct) / this.sr;
          const gl = level * Math.cos((pan + 1) * Math.PI / 4);
          const gr = level * Math.sin((pan + 1) * Math.PI / 4);
          let ph = this.subPhase;
          for (let i = 0; i < n; i++) {
            ph += inc;
            if (ph >= 1) ph -= 1;
            let s;
            switch (shape) {
              case 1:
                s = 1 - 4 * Math.abs(ph - 0.5);
                break;
              // triangle
              case 2:
                s = 2 * ph - 1;
                break;
              // saw
              case 3:
                s = ph < 0.5 ? 1 : -1;
                break;
              // square
              default:
                s = Math.sin(ph * 2 * Math.PI);
            }
            bufL[i] += s * gl;
            bufR[i] += s * gr;
          }
          this.subPhase = ph;
        }
      }
      if (ctx.base[NOISE_IDX.enabled] >= 0.5) {
        const level = this.pv(NOISE_IDX.level, ctx);
        if (level > 1e-4) {
          const pan = this.pv(NOISE_IDX.pan, ctx);
          const type = Math.round(normToValue(PARAMS[NOISE_IDX.type], ctx.base[NOISE_IDX.type]));
          const gl = level * Math.cos((pan + 1) * Math.PI / 4);
          const gr = level * Math.sin((pan + 1) * Math.PI / 4);
          if (type === 2 && ctx.sample) {
            const pitch = this.pv(NOISE_IDX.pitch, ctx);
            const rate = Math.pow(2, pitch / 12) * (ctx.sample.sampleRate / this.sr);
            const data = ctx.sample.data;
            let pos = this.samplePos;
            for (let i = 0; i < n; i++) {
              const i0 = pos | 0;
              const s = data[i0 % data.length];
              bufL[i] += s * gl;
              bufR[i] += s * gr;
              pos += rate;
              if (pos >= data.length) pos -= data.length;
            }
            this.samplePos = pos;
          } else if (type === 1) {
            const pk = this.pink;
            for (let i = 0; i < n; i++) {
              const white = Math.random() * 2 - 1;
              pk[0] = 0.99765 * pk[0] + white * 0.099046;
              pk[1] = 0.963 * pk[1] + white * 0.2965164;
              pk[2] = 0.57 * pk[2] + white * 1.0526913;
              const s = (pk[0] + pk[1] + pk[2] + white * 0.1848) * 0.2;
              bufL[i] += s * gl;
              bufR[i] += s * gr;
            }
          } else {
            for (let i = 0; i < n; i++) {
              const s = Math.random() * 2 - 1;
              bufL[i] += s * gl;
              bufR[i] += s * gr;
            }
          }
        }
      }
      const routing = Math.round(normToValue(PARAMS[FILTER_ROUTING_IDX], ctx.base[FILTER_ROUTING_IDX]));
      const f1on = ctx.base[FILT_IDX[0].enabled] >= 0.5;
      const f2on = ctx.base[FILT_IDX[1].enabled] >= 0.5;
      const keyOffset = this.note - 60;
      const runFilter = (f, l, r) => {
        const ix = FILT_IDX[f];
        const type = Math.round(normToValue(PARAMS[ix.type], ctx.base[ix.type]));
        const kt = this.pv(ix.keytrack, ctx);
        const cutoff = this.pv(ix.cutoff, ctx) * Math.pow(2, keyOffset / 12 * kt);
        this.filters[f].process(l, r, n, type, cutoff, this.pv(ix.resonance, ctx), this.pv(ix.drive, ctx), this.pv(ix.mix, ctx));
      };
      if (routing === 0) {
        if (f1on) runFilter(0, bufL, bufR);
        if (f2on) runFilter(1, bufL, bufR);
      } else if (f1on || f2on) {
        if (f1on && f2on) {
          this.tmpL.set(bufL.subarray(0, n));
          this.tmpR.set(bufR.subarray(0, n));
          runFilter(0, bufL, bufR);
          runFilter(1, this.tmpL, this.tmpR);
          for (let i = 0; i < n; i++) {
            bufL[i] = (bufL[i] + this.tmpL[i]) * 0.5;
            bufR[i] = (bufR[i] + this.tmpR[i]) * 0.5;
          }
        } else {
          runFilter(f1on ? 0 : 1, bufL, bufR);
        }
      }
      const distType = Math.round(normToValue(PARAMS[DIST_IDX.type], ctx.base[DIST_IDX.type]));
      if (distType > 0) {
        const drive = this.pv(DIST_IDX.drive, ctx);
        const mix = this.pv(DIST_IDX.mix, ctx);
        const gain = 1 + drive * 15;
        const comp = 1 / Math.pow(gain, 0.5);
        if (distType === 4) {
          const bits = this.pv(DIST_IDX.bits, ctx);
          const levels = Math.pow(2, bits);
          const down = Math.max(1, Math.round(this.pv(DIST_IDX.downsample, ctx)));
          for (let i = 0; i < n; i++) {
            if (this.distCount <= 0) {
              this.distHoldL = Math.round(bufL[i] * levels) / levels;
              this.distHoldR = Math.round(bufR[i] * levels) / levels;
              this.distCount = down;
            }
            this.distCount--;
            bufL[i] = bufL[i] * (1 - mix) + this.distHoldL * mix;
            bufR[i] = bufR[i] * (1 - mix) + this.distHoldR * mix;
          }
        } else {
          for (let i = 0; i < n; i++) {
            let sl;
            let sr2;
            if (distType === 1) {
              sl = Math.tanh(bufL[i] * gain) * comp;
              sr2 = Math.tanh(bufR[i] * gain) * comp;
            } else if (distType === 2) {
              sl = Math.max(-0.8, Math.min(0.8, bufL[i] * gain)) * comp;
              sr2 = Math.max(-0.8, Math.min(0.8, bufR[i] * gain)) * comp;
            } else {
              sl = Math.sin(bufL[i] * gain * 1.5) * comp;
              sr2 = Math.sin(bufR[i] * gain * 1.5) * comp;
            }
            bufL[i] = bufL[i] * (1 - mix) + sl * mix;
            bufR[i] = bufR[i] * (1 - mix) + sr2 * mix;
          }
        }
      }
      const velGain = 0.25 + 0.75 * this.velocity;
      const targetAmp = this.sources[SRC_ENV0] * velGain;
      const ampStep = (targetAmp - this.prevAmp) / n;
      let amp = this.prevAmp;
      for (let i = 0; i < n; i++) {
        amp += ampStep;
        outL[i] += bufL[i] * amp;
        outR[i] += bufR[i] * amp;
      }
      this.prevAmp = targetAmp;
      return this.active;
    }
  };

  // ../soundgineer/src/worklet/effects.ts
  function flush(x) {
    return Math.abs(x) < 1e-20 ? 0 : x;
  }
  var ModDelayLine = class {
    buf;
    pos = 0;
    constructor(size) {
      this.buf = new Float32Array(size);
    }
    write(x) {
      this.buf[this.pos] = x;
      this.pos = (this.pos + 1) % this.buf.length;
    }
    /** Read `delay` samples back with linear interpolation (before this block's write). */
    read(delay) {
      const size = this.buf.length;
      let p2 = this.pos - delay;
      while (p2 < 0) p2 += size;
      const i0 = p2 | 0;
      const frac = p2 - i0;
      const i1 = (i0 + 1) % size;
      return this.buf[i0] + (this.buf[i1] - this.buf[i0]) * frac;
    }
  };
  var Chorus = class {
    constructor(sr) {
      this.sr = sr;
    }
    sr;
    dl = [new ModDelayLine(8192), new ModDelayLine(8192)];
    phase = 0;
    process(l, r, n, rate, depth, mix) {
      const base = 0.02 * this.sr;
      const dep = depth * 8e-3 * this.sr;
      const inc = rate / this.sr;
      for (let i = 0; i < n; i++) {
        this.phase = (this.phase + inc) % 1;
        const lfoL = Math.sin(this.phase * 2 * Math.PI);
        const lfoR = Math.sin((this.phase + 0.25) * 2 * Math.PI);
        this.dl[0].write(l[i]);
        this.dl[1].write(r[i]);
        const wl = this.dl[0].read(base + dep * (1 + lfoL) + 1);
        const wr = this.dl[1].read(base + dep * (1 + lfoR) + 1);
        l[i] = l[i] * (1 - mix) + wl * mix;
        r[i] = r[i] * (1 - mix) + wr * mix;
      }
    }
  };
  var Flanger = class {
    constructor(sr) {
      this.sr = sr;
    }
    sr;
    dl = [new ModDelayLine(4096), new ModDelayLine(4096)];
    fb = [0, 0];
    phase = 0;
    process(l, r, n, rate, depth, feedback, mix) {
      const min = 1e-3 * this.sr;
      const dep = depth * 6e-3 * this.sr;
      const inc = rate / this.sr;
      for (let i = 0; i < n; i++) {
        this.phase = (this.phase + inc) % 1;
        const tri = 1 - Math.abs(this.phase * 2 - 1) * 2 + 1;
        const halfTri = (1 - Math.cos(this.phase * 2 * Math.PI)) * 0.5;
        void tri;
        const d = min + dep * halfTri + 1;
        for (let ch = 0; ch < 2; ch++) {
          const buf = ch === 0 ? l : r;
          this.dl[ch].write(buf[i] + this.fb[ch] * feedback);
          const w = this.dl[ch].read(d);
          this.fb[ch] = flush(w);
          buf[i] = buf[i] * (1 - mix) + w * mix;
        }
      }
    }
  };
  var Phaser = class {
    constructor(sr) {
      this.sr = sr;
    }
    sr;
    ap = [new Array(6).fill(0), new Array(6).fill(0)];
    fb = [0, 0];
    phase = 0;
    process(l, r, n, rate, depth, feedback, mix) {
      const inc = rate / this.sr;
      for (let i = 0; i < n; i++) {
        this.phase = (this.phase + inc) % 1;
        for (let ch = 0; ch < 2; ch++) {
          const sweep = (1 - Math.cos((this.phase + ch * 0.25) * 2 * Math.PI)) * 0.5;
          const f = 300 * Math.pow(2, sweep * depth * 4.5);
          const w = Math.min(Math.PI * f / this.sr, 1.5);
          const a = (1 - Math.tan(w)) / (1 + Math.tan(w));
          const buf = ch === 0 ? l : r;
          let x = buf[i] + this.fb[ch] * feedback;
          const st2 = this.ap[ch];
          for (let s = 0; s < 6; s++) {
            const y = a * x + st2[s];
            st2[s] = x - a * y;
            x = y;
          }
          this.fb[ch] = flush(x);
          buf[i] = buf[i] * (1 - mix) + x * mix;
        }
      }
    }
  };
  var StereoDelay = class {
    constructor(sr) {
      this.sr = sr;
      this.dl = [new ModDelayLine(Math.ceil(sr * 2.5)), new ModDelayLine(Math.ceil(sr * 2.5))];
      this.smoothedDelay = sr * 0.35;
    }
    sr;
    dl;
    smoothedDelay;
    process(l, r, n, timeSec, feedback, pingpong, mix) {
      const target = Math.min(Math.max(timeSec * this.sr, 32), this.sr * 2.4);
      for (let i = 0; i < n; i++) {
        this.smoothedDelay += (target - this.smoothedDelay) * 5e-4;
        const d = this.smoothedDelay;
        const wl = this.dl[0].read(d);
        const wr = this.dl[1].read(d);
        if (pingpong) {
          this.dl[0].write(flush(l[i] * 0.5 + r[i] * 0.5 + wr * feedback));
          this.dl[1].write(flush(wl * feedback));
        } else {
          this.dl[0].write(flush(l[i] + wl * feedback));
          this.dl[1].write(flush(r[i] + wr * feedback));
        }
        l[i] = l[i] * (1 - mix * 0.5) + wl * mix;
        r[i] = r[i] * (1 - mix * 0.5) + wr * mix;
      }
    }
  };
  var Comb = class {
    buf;
    pos = 0;
    filterStore = 0;
    constructor(size) {
      this.buf = new Float32Array(size);
    }
    process(x, feedback, damp) {
      const out = this.buf[this.pos];
      this.filterStore = flush(out * (1 - damp) + this.filterStore * damp);
      this.buf[this.pos] = flush(x + this.filterStore * feedback);
      this.pos = (this.pos + 1) % this.buf.length;
      return out;
    }
  };
  var Allpass = class {
    buf;
    pos = 0;
    constructor(size) {
      this.buf = new Float32Array(size);
    }
    process(x) {
      const bufOut = this.buf[this.pos];
      const out = -x + bufOut;
      this.buf[this.pos] = flush(x + bufOut * 0.5);
      this.pos = (this.pos + 1) % this.buf.length;
      return out;
    }
  };
  var COMB_TUNINGS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  var ALLPASS_TUNINGS = [556, 441, 341, 225];
  var STEREO_SPREAD = 23;
  var Reverb = class {
    combs;
    allpasses;
    constructor(sr) {
      const scale = sr / 44100;
      this.combs = [
        COMB_TUNINGS.map((t) => new Comb(Math.round(t * scale))),
        COMB_TUNINGS.map((t) => new Comb(Math.round((t + STEREO_SPREAD) * scale)))
      ];
      this.allpasses = [
        ALLPASS_TUNINGS.map((t) => new Allpass(Math.round(t * scale))),
        ALLPASS_TUNINGS.map((t) => new Allpass(Math.round((t + STEREO_SPREAD) * scale)))
      ];
    }
    process(l, r, n, size, damp, width, mix) {
      const feedback = 0.7 + size * 0.28;
      const dampC = damp * 0.4;
      const wet1 = mix * (1 + width) / 2;
      const wet2 = mix * (1 - width) / 2;
      for (let i = 0; i < n; i++) {
        const input = (l[i] + r[i]) * 0.015;
        let outL = 0;
        let outR = 0;
        for (let c = 0; c < 8; c++) {
          outL += this.combs[0][c].process(input, feedback, dampC);
          outR += this.combs[1][c].process(input, feedback, dampC);
        }
        for (let a = 0; a < 4; a++) {
          outL = this.allpasses[0][a].process(outL);
          outR = this.allpasses[1][a].process(outR);
        }
        l[i] = l[i] * (1 - mix) + outL * wet1 + outR * wet2;
        r[i] = r[i] * (1 - mix) + outR * wet1 + outL * wet2;
      }
    }
  };
  var Biquad = class {
    b0 = 1;
    b1 = 0;
    b2 = 0;
    a1 = 0;
    a2 = 0;
    x1 = [0, 0];
    x2 = [0, 0];
    y1 = [0, 0];
    y2 = [0, 0];
    lowShelf(sr, f, gainDb) {
      const A = Math.pow(10, gainDb / 40);
      const w = 2 * Math.PI * f / sr;
      const cs = Math.cos(w);
      const sn = Math.sin(w);
      const beta = Math.sqrt(A) / 0.9;
      const b0 = A * (A + 1 - (A - 1) * cs + beta * sn);
      const b1 = 2 * A * (A - 1 - (A + 1) * cs);
      const b2 = A * (A + 1 - (A - 1) * cs - beta * sn);
      const a0 = A + 1 + (A - 1) * cs + beta * sn;
      const a1 = -2 * (A - 1 + (A + 1) * cs);
      const a2 = A + 1 + (A - 1) * cs - beta * sn;
      this.set(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
    }
    highShelf(sr, f, gainDb) {
      const A = Math.pow(10, gainDb / 40);
      const w = 2 * Math.PI * f / sr;
      const cs = Math.cos(w);
      const sn = Math.sin(w);
      const beta = Math.sqrt(A) / 0.9;
      const b0 = A * (A + 1 + (A - 1) * cs + beta * sn);
      const b1 = -2 * A * (A - 1 + (A + 1) * cs);
      const b2 = A * (A + 1 + (A - 1) * cs - beta * sn);
      const a0 = A + 1 - (A - 1) * cs + beta * sn;
      const a1 = 2 * (A - 1 - (A + 1) * cs);
      const a2 = A + 1 - (A - 1) * cs - beta * sn;
      this.set(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
    }
    peak(sr, f, gainDb, q) {
      const A = Math.pow(10, gainDb / 40);
      const w = 2 * Math.PI * f / sr;
      const alpha = Math.sin(w) / (2 * q);
      const cs = Math.cos(w);
      const b0 = 1 + alpha * A;
      const b1 = -2 * cs;
      const b2 = 1 - alpha * A;
      const a0 = 1 + alpha / A;
      const a1 = -2 * cs;
      const a2 = 1 - alpha / A;
      this.set(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
    }
    set(b0, b1, b2, a1, a2) {
      this.b0 = b0;
      this.b1 = b1;
      this.b2 = b2;
      this.a1 = a1;
      this.a2 = a2;
    }
    processCh(x, ch) {
      const y = this.b0 * x + this.b1 * this.x1[ch] + this.b2 * this.x2[ch] - this.a1 * this.y1[ch] - this.a2 * this.y2[ch];
      this.x2[ch] = this.x1[ch];
      this.x1[ch] = x;
      this.y2[ch] = this.y1[ch];
      this.y1[ch] = flush(y);
      return y;
    }
  };
  var Eq3 = class {
    constructor(sr) {
      this.sr = sr;
    }
    sr;
    low = new Biquad();
    mid = new Biquad();
    high = new Biquad();
    process(l, r, n, lowDb, midDb, midFreq, highDb) {
      this.low.lowShelf(this.sr, 250, lowDb);
      this.mid.peak(this.sr, midFreq, midDb, 0.7);
      this.high.highShelf(this.sr, 4e3, highDb);
      for (let i = 0; i < n; i++) {
        l[i] = this.high.processCh(this.mid.processCh(this.low.processCh(l[i], 0), 0), 0);
        r[i] = this.high.processCh(this.mid.processCh(this.low.processCh(r[i], 1), 1), 1);
      }
    }
  };
  var Compressor = class {
    constructor(sr) {
      this.sr = sr;
    }
    sr;
    env = 0;
    process(l, r, n, thresholdDb, ratio, attack, release, makeupDb) {
      const atkC = Math.exp(-1 / (attack * this.sr));
      const relC = Math.exp(-1 / (release * this.sr));
      const makeup = Math.pow(10, makeupDb / 20);
      for (let i = 0; i < n; i++) {
        const peak = Math.max(Math.abs(l[i]), Math.abs(r[i]));
        const coeff = peak > this.env ? atkC : relC;
        this.env = flush(coeff * this.env + (1 - coeff) * peak);
        const envDb = 20 * Math.log10(Math.max(this.env, 1e-6));
        let gainDb = 0;
        if (envDb > thresholdDb) gainDb = (thresholdDb - envDb) * (1 - 1 / ratio);
        const g = Math.pow(10, gainDb / 20) * makeup;
        l[i] *= g;
        r[i] *= g;
      }
    }
  };
  var FxDistortion = class {
    constructor(sr) {
      this.sr = sr;
    }
    sr;
    lp = [0, 0];
    process(l, r, n, drive, tone, mix) {
      const gain = 1 + drive * 30;
      const comp = 1 / Math.pow(gain, 0.6);
      const k = 1 - Math.exp(-2 * Math.PI * tone / this.sr);
      for (let i = 0; i < n; i++) {
        for (let ch = 0; ch < 2; ch++) {
          const buf = ch === 0 ? l : r;
          const shaped = Math.tanh(buf[i] * gain) * comp;
          this.lp[ch] += (shaped - this.lp[ch]) * k;
          buf[i] = buf[i] * (1 - mix) + this.lp[ch] * mix;
        }
      }
    }
  };

  // ../soundgineer/src/worklet/processor.ts
  var BLOCK = 128;
  var SCOPE_SIZE = 1024;
  var FX_IDX = {
    chorus: { on: paramIndex("chorus.enabled"), rate: paramIndex("chorus.rate"), depth: paramIndex("chorus.depth"), mix: paramIndex("chorus.mix") },
    phaser: { on: paramIndex("phaser.enabled"), rate: paramIndex("phaser.rate"), depth: paramIndex("phaser.depth"), fb: paramIndex("phaser.feedback"), mix: paramIndex("phaser.mix") },
    flanger: { on: paramIndex("flanger.enabled"), rate: paramIndex("flanger.rate"), depth: paramIndex("flanger.depth"), fb: paramIndex("flanger.feedback"), mix: paramIndex("flanger.mix") },
    delay: { on: paramIndex("delay.enabled"), sync: paramIndex("delay.sync"), div: paramIndex("delay.division"), time: paramIndex("delay.time"), fb: paramIndex("delay.feedback"), pp: paramIndex("delay.pingpong"), mix: paramIndex("delay.mix") },
    reverb: { on: paramIndex("reverb.enabled"), size: paramIndex("reverb.size"), damp: paramIndex("reverb.damp"), width: paramIndex("reverb.width"), mix: paramIndex("reverb.mix") },
    eq: { on: paramIndex("eq.enabled"), low: paramIndex("eq.low_gain"), mid: paramIndex("eq.mid_gain"), midF: paramIndex("eq.mid_freq"), high: paramIndex("eq.high_gain") },
    comp: { on: paramIndex("comp.enabled"), th: paramIndex("comp.threshold"), ratio: paramIndex("comp.ratio"), atk: paramIndex("comp.attack"), rel: paramIndex("comp.release"), mk: paramIndex("comp.makeup") },
    fxdist: { on: paramIndex("fxdist.enabled"), drive: paramIndex("fxdist.drive"), tone: paramIndex("fxdist.tone"), mix: paramIndex("fxdist.mix") }
  };
  var SynthProcessor = class extends AudioWorkletProcessor {
    base = defaultValues();
    voices = [];
    noteAge = 0;
    sustainDown = false;
    slots = new Array(MAX_MOD_SLOTS).fill(null);
    routesByDest = /* @__PURE__ */ new Map();
    tables = [null, null, null];
    lfoShapes = Array.from({ length: 8 }, () => defaultLfoShape());
    sample = null;
    lfoGlobalPhases = new Float32Array(8);
    lfoBeatPhases = new Float32Array(8);
    lfoFreqs = new Float32Array(8);
    beatCounter = 0;
    pitchBend = 0;
    modWheel = 0;
    aftertouch = 0;
    globalOffsets = new Float32Array(NUM_PARAMS);
    globalSources = new Float32Array(NUM_MOD_SOURCES);
    fxOrder = [0, 1, 2, 3, 4, 5, 6, 7];
    chorus = new Chorus(sampleRate);
    phaser = new Phaser(sampleRate);
    flanger = new Flanger(sampleRate);
    delay = new StereoDelay(sampleRate);
    reverb = new Reverb(sampleRate);
    eq = new Eq3(sampleRate);
    comp = new Compressor(sampleRate);
    fxdist = new FxDistortion(sampleRate);
    scopeL = new Float32Array(SCOPE_SIZE);
    scopeR = new Float32Array(SCOPE_SIZE);
    scopePos = 0;
    peakL = 0;
    peakR = 0;
    ctx;
    constructor() {
      super();
      for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice(sampleRate, BLOCK));
      this.ctx = {
        sr: sampleRate,
        blockSize: BLOCK,
        base: this.base,
        routesByDest: this.routesByDest,
        tables: this.tables,
        lfoShapes: this.lfoShapes,
        sample: null,
        lfoGlobalPhases: this.lfoGlobalPhases,
        lfoBeatPhases: this.lfoBeatPhases,
        lfoFreqs: this.lfoFreqs,
        pitchBend: 0,
        modWheel: 0,
        aftertouch: 0,
        bendRange: 2
      };
      this.port.onmessage = (e) => this.handleMessage(e.data);
      this.port.postMessage({ type: "ready" });
    }
    handleMessage(msg) {
      switch (msg.type) {
        case "param":
          this.base[msg.index] = msg.value;
          break;
        case "noteOn":
          this.noteOn(msg.note, msg.velocity);
          break;
        case "noteOff":
          this.noteOff(msg.note);
          break;
        case "sustain":
          this.sustainDown = msg.down;
          if (!msg.down) {
            for (const v of this.voices) {
              if (v.active && v.sustained) v.noteOff();
            }
          }
          break;
        case "pitchBend":
          this.pitchBend = msg.value;
          break;
        case "modWheel":
          this.modWheel = msg.value;
          break;
        case "aftertouch":
          this.aftertouch = msg.value;
          break;
        case "mod":
          this.slots[msg.slot] = msg.state;
          this.rebuildRoutes();
          break;
        case "lfoShape":
          this.lfoShapes[msg.lfo] = msg.points.length ? msg.points : defaultLfoShape();
          break;
        case "wavetable":
          this.tables[msg.osc] = new WavetableData(msg.mips, msg.frameSize, msg.numFrames);
          break;
        case "sample":
          this.sample = msg.data.length > 0 ? { data: msg.data, sampleRate: msg.sampleRate } : null;
          break;
        case "fxOrder":
          if (msg.order.length === 8) this.fxOrder = msg.order.slice();
          break;
        case "allNotesOff":
          for (const v of this.voices) if (v.active) v.noteOff();
          break;
      }
    }
    rebuildRoutes() {
      this.routesByDest.clear();
      for (const s of this.slots) {
        if (!s || !s.enabled || s.depth === 0) continue;
        if (s.dest < 0 || s.dest >= NUM_PARAMS || !PARAMS[s.dest].moddable) continue;
        let list = this.routesByDest.get(s.dest);
        if (!list) {
          list = [];
          this.routesByDest.set(s.dest, list);
        }
        list.push({ source: s.source, depth: s.depth });
      }
      for (const v of this.voices) v.clearMods();
      this.globalOffsets.fill(0);
    }
    noteOn(note, velocity) {
      const poly = Math.max(1, Math.round(normToValue(PARAMS[MASTER_IDX.polyphony], this.base[MASTER_IDX.polyphony])));
      let voice = null;
      let activeCount = 0;
      for (const v of this.voices) if (v.active) activeCount++;
      if (activeCount < poly) {
        voice = this.voices.find((v) => !v.active) ?? null;
      }
      if (!voice) {
        let best = null;
        for (const v of this.voices) {
          if (!v.active) {
            best = v;
            break;
          }
          if (v.releasing && (!best || !best.releasing || v.ampLevel < best.ampLevel)) best = v;
        }
        if (!best || !best.releasing) {
          for (const v of this.voices) {
            if (v.active && (!best || v.age < best.age)) best = v;
          }
        }
        voice = best;
      }
      if (voice) voice.noteOn(note, Math.max(1e-3, velocity), this.noteAge++, this.ctx);
    }
    noteOff(note) {
      for (const v of this.voices) {
        if (v.active && v.note === note && v.gate) {
          if (this.sustainDown) v.sustained = true;
          else v.noteOff();
        }
      }
    }
    updateGlobalLfos(bpm) {
      const dt = BLOCK / sampleRate;
      this.beatCounter += bpm / 60 * dt;
      for (let l = 0; l < 8; l++) {
        const ix = LFO_IDX[l];
        const synced = this.base[ix.sync] >= 0.5;
        let freq;
        if (synced) {
          const div = Math.round(normToValue(PARAMS[ix.division], this.base[ix.division]));
          freq = bpm / 60 / divisionToBeats(div);
        } else {
          freq = normToValue(PARAMS[ix.rate], this.base[ix.rate] + this.globalOffsets[ix.rate]);
        }
        this.lfoFreqs[l] = freq;
        this.lfoGlobalPhases[l] = (this.lfoGlobalPhases[l] + freq * dt) % 1;
        const beatsPerCycle = synced ? divisionToBeats(Math.round(normToValue(PARAMS[ix.division], this.base[ix.division]))) : Math.max(60 / (freq * bpm), 1e-4);
        const phase0 = this.base[ix.phase];
        this.lfoBeatPhases[l] = (this.beatCounter / beatsPerCycle + phase0) % 1;
      }
    }
    /** Resolve global modulation offsets, using the newest active voice for per-voice sources. */
    updateGlobalMods() {
      let ref = null;
      for (const v of this.voices) {
        if (v.active && (!ref || v.age > ref.age)) ref = v;
      }
      if (ref) this.globalSources.set(ref.sources);
      else {
        this.globalSources.fill(0);
        for (let l = 0; l < 8; l++) {
          this.globalSources[6 + l] = 0;
        }
      }
      for (let m = 0; m < 4; m++) this.globalSources[SRC_MACRO0 + m] = this.base[MACRO_IDX[m]];
      this.globalSources[SRC_MODWHEEL] = this.modWheel;
      this.globalSources[SRC_PITCHWHEEL] = this.pitchBend;
      this.globalSources[SRC_AFTERTOUCH] = this.aftertouch;
      for (const [dest, routes] of this.routesByDest) {
        let sum = 0;
        for (const r of routes) sum += r.depth * this.globalSources[r.source];
        this.globalOffsets[dest] = sum;
      }
    }
    /** Global (post-mix) parameter value with modulation. */
    gv(index) {
      return normToValue(PARAMS[index], this.base[index] + this.globalOffsets[index]);
    }
    runFx(l, r, n, bpm) {
      for (const fx of this.fxOrder) {
        switch (fx) {
          case 0: {
            const p2 = FX_IDX.chorus;
            if (this.base[p2.on] >= 0.5) this.chorus.process(l, r, n, this.gv(p2.rate), this.gv(p2.depth), this.gv(p2.mix));
            break;
          }
          case 1: {
            const p2 = FX_IDX.phaser;
            if (this.base[p2.on] >= 0.5) this.phaser.process(l, r, n, this.gv(p2.rate), this.gv(p2.depth), this.gv(p2.fb), this.gv(p2.mix));
            break;
          }
          case 2: {
            const p2 = FX_IDX.flanger;
            if (this.base[p2.on] >= 0.5) this.flanger.process(l, r, n, this.gv(p2.rate), this.gv(p2.depth), this.gv(p2.fb), this.gv(p2.mix));
            break;
          }
          case 3: {
            const p2 = FX_IDX.delay;
            if (this.base[p2.on] >= 0.5) {
              let time;
              if (this.base[p2.sync] >= 0.5) {
                const div = Math.round(normToValue(PARAMS[p2.div], this.base[p2.div]));
                time = divisionToBeats(div) * (60 / bpm);
              } else time = this.gv(p2.time);
              this.delay.process(l, r, n, time, this.gv(p2.fb), this.base[p2.pp] >= 0.5, this.gv(p2.mix));
            }
            break;
          }
          case 4: {
            const p2 = FX_IDX.reverb;
            if (this.base[p2.on] >= 0.5) this.reverb.process(l, r, n, this.gv(p2.size), this.gv(p2.damp), this.gv(p2.width), this.gv(p2.mix));
            break;
          }
          case 5: {
            const p2 = FX_IDX.eq;
            if (this.base[p2.on] >= 0.5) this.eq.process(l, r, n, this.gv(p2.low), this.gv(p2.mid), this.gv(p2.midF), this.gv(p2.high));
            break;
          }
          case 6: {
            const p2 = FX_IDX.comp;
            if (this.base[p2.on] >= 0.5) this.comp.process(l, r, n, this.gv(p2.th), this.gv(p2.ratio), this.gv(p2.atk), this.gv(p2.rel), this.gv(p2.mk));
            break;
          }
          case 7: {
            const p2 = FX_IDX.fxdist;
            if (this.base[p2.on] >= 0.5) this.fxdist.process(l, r, n, this.gv(p2.drive), this.gv(p2.tone), this.gv(p2.mix));
            break;
          }
        }
      }
    }
    process(_inputs, outputs) {
      const out = outputs[0];
      const l = out[0];
      const r = out.length > 1 ? out[1] : out[0];
      const n = l.length;
      l.fill(0);
      if (r !== l) r.fill(0);
      const bpm = normToValue(PARAMS[MASTER_IDX.bpm], this.base[MASTER_IDX.bpm]);
      this.updateGlobalLfos(bpm);
      const ctx = this.ctx;
      ctx.sample = this.sample;
      ctx.pitchBend = this.pitchBend;
      ctx.modWheel = this.modWheel;
      ctx.aftertouch = this.aftertouch;
      ctx.bendRange = Math.round(normToValue(PARAMS[MASTER_IDX.bendRange], this.base[MASTER_IDX.bendRange]));
      let voiceCount = 0;
      for (const v of this.voices) {
        if (v.active) {
          v.render(ctx, l, r, n);
          voiceCount++;
        }
      }
      this.updateGlobalMods();
      this.runFx(l, r, n, bpm);
      const vol = this.gv(MASTER_IDX.volume);
      for (let i = 0; i < n; i++) {
        let sl = l[i] * vol;
        let sr = r[i] * vol;
        if (sl > 2) sl = 2;
        else if (sl < -2) sl = -2;
        if (sr > 2) sr = 2;
        else if (sr < -2) sr = -2;
        l[i] = sl;
        r[i] = sr;
        const al = Math.abs(sl);
        const ar = Math.abs(sr);
        if (al > this.peakL) this.peakL = al;
        if (ar > this.peakR) this.peakR = ar;
      }
      this.scopeL.set(l.subarray(0, n), this.scopePos);
      this.scopeR.set(r.subarray(0, n), this.scopePos);
      this.scopePos += n;
      if (this.scopePos >= SCOPE_SIZE) {
        this.scopePos = 0;
        const sl = new Float32Array(this.scopeL);
        const sr = new Float32Array(this.scopeR);
        this.port.postMessage({ type: "scope", left: sl, right: sr }, [sl.buffer, sr.buffer]);
        const sources = new Float32Array(this.globalSources);
        this.port.postMessage({
          type: "status",
          voices: voiceCount,
          peakL: this.peakL,
          peakR: this.peakR,
          sources
        }, [sources.buffer]);
        this.peakL = 0;
        this.peakR = 0;
      }
      return true;
    }
  };
  registerProcessor("soundgineer", SynthProcessor);
})();
