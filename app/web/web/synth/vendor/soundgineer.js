// sg-worker:worker-url
var worker_url_default = new URL("./soundgineer-worklet.js", import.meta.url).href;

// ../../../../soundgineer/src/shared/params.ts
var FILTER_TYPES = ["LP 12", "LP 24", "HP 12", "HP 24", "BP 12", "BP 24", "Notch", "Comb", "Formant"];
var SUB_SHAPES = ["Sine", "Triangle", "Saw", "Square"];
var NOISE_TYPES = ["White", "Pink", "Sample"];
var DIST_TYPES = ["Off", "Soft Clip", "Hard Clip", "Wavefold", "Bitcrush"];
var FILTER_ROUTINGS = ["Series", "Parallel"];
var LFO_MODES = ["Trigger", "Free", "Sync"];
var SYNC_DIVISIONS = ["1/1", "1/2", "1/2T", "1/4.", "1/4", "1/4T", "1/8.", "1/8", "1/8T", "1/16.", "1/16", "1/16T", "1/32"];
var WAVETABLE_NAMES = ["Basic Shapes", "Harmonic Sweep", "PWM", "Vocal", "FM Bell", "Digital", "Custom"];
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

// ../../../../soundgineer/src/shared/messages.ts
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
function modSourceIndex(id) {
  const i = MOD_SOURCES.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`unknown mod source: ${id}`);
  return i;
}
var MAX_MOD_SLOTS = 32;
var FX_IDS = ["chorus", "phaser", "flanger", "delay", "reverb", "eq", "comp", "fxdist"];
var DEFAULT_FX_ORDER = FX_IDS.map((_, i) => i);
function defaultLfoShape() {
  return [
    { x: 0, y: 0, power: 0 },
    { x: 0.5, y: 1, power: 0 },
    { x: 1, y: 0, power: 0 }
  ];
}

// ../../../../soundgineer/src/shared/fft.ts
function fft(re, im) {
  const n = re.length;
  if ((n & n - 1) !== 0) throw new Error("fft size must be a power of two");
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + half] * cwr - im[i + j + half] * cwi;
        const vi = re[i + j + half] * cwi + im[i + j + half] * cwr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + half] = ur - vr;
        im[i + j + half] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}
function ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}
function bandlimitCycle(cycle, maxHarmonic) {
  const n = cycle.length;
  const re = new Float32Array(cycle);
  const im = new Float32Array(n);
  fft(re, im);
  re[0] = 0;
  im[0] = 0;
  const half = n >> 1;
  for (let k = 1; k <= half; k++) {
    if (k > maxHarmonic) {
      re[k] = 0;
      im[k] = 0;
      if (k !== half) {
        re[n - k] = 0;
        im[n - k] = 0;
      }
    }
  }
  ifft(re, im);
  return re;
}
function resampleCycle(input, size) {
  let n = 1;
  while (n < input.length) n <<= 1;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i / n * input.length;
    const i0 = Math.floor(pos) % input.length;
    const i1 = (i0 + 1) % input.length;
    src[i] = input[i0] + (input[i1] - input[i0]) * (pos - i0);
  }
  const re = new Float32Array(src);
  const im = new Float32Array(n);
  fft(re, im);
  const outRe = new Float32Array(size);
  const outIm = new Float32Array(size);
  const bins = Math.min(n >> 1, size >> 1);
  const scale = size / n;
  for (let k = 1; k < bins; k++) {
    outRe[k] = re[k] * scale;
    outIm[k] = im[k] * scale;
    outRe[size - k] = re[n - k] * scale;
    outIm[size - k] = im[n - k] * scale;
  }
  ifft(outRe, outIm);
  return outRe;
}

// ../../../../soundgineer/src/shared/wavetable-gen.ts
var FRAME_SIZE = 2048;
var NUM_MIPS = 11;
function buildMips(data, frameSize, numFrames) {
  const out = new Float32Array(numFrames * NUM_MIPS * frameSize);
  for (let f = 0; f < numFrames; f++) {
    const cycle = data.subarray(f * frameSize, (f + 1) * frameSize);
    for (let m = 0; m < NUM_MIPS; m++) {
      const dst = (f * NUM_MIPS + m) * frameSize;
      if (m === 0) out.set(cycle, dst);
      else out.set(bandlimitCycle(cycle, Math.max(1, frameSize >> 1 >> m)), dst);
    }
  }
  return out;
}
function normalizeTable(data) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 1e-9) {
    const g = 1 / peak;
    for (let i = 0; i < data.length; i++) data[i] *= g;
  }
}
function spectralMorph(keyFrames, numFrames) {
  const n = FRAME_SIZE;
  const half = n >> 1;
  const specs = keyFrames.map((f) => {
    const re2 = new Float32Array(f);
    const im2 = new Float32Array(n);
    fft(re2, im2);
    const mag = new Float32Array(half);
    const phase = new Float32Array(half);
    for (let k = 0; k < half; k++) {
      mag[k] = Math.hypot(re2[k], im2[k]);
      phase[k] = Math.atan2(im2[k], re2[k]);
    }
    return { mag, phase };
  });
  const out = new Float32Array(numFrames * n);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let f = 0; f < numFrames; f++) {
    const pos = numFrames === 1 ? 0 : f / (numFrames - 1) * (specs.length - 1);
    const i0 = Math.min(Math.floor(pos), specs.length - 1);
    const i1 = Math.min(i0 + 1, specs.length - 1);
    const t = pos - i0;
    re.fill(0);
    im.fill(0);
    for (let k = 1; k < half; k++) {
      const m = specs[i0].mag[k] + (specs[i1].mag[k] - specs[i0].mag[k]) * t;
      let p0 = specs[i0].phase[k];
      let p1 = specs[i1].phase[k];
      let dp = p1 - p0;
      if (dp > Math.PI) dp -= 2 * Math.PI;
      if (dp < -Math.PI) dp += 2 * Math.PI;
      const ph = p0 + dp * t;
      re[k] = m * Math.cos(ph);
      im[k] = m * Math.sin(ph);
      re[n - k] = re[k];
      im[n - k] = -im[k];
    }
    ifft(re, im);
    out.set(re, f * n);
  }
  normalizeTable(out);
  return out;
}
function additive(harmonics, count = 512) {
  const n = FRAME_SIZE;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const half = n >> 1;
  for (let k = 1; k <= Math.min(count, half - 1); k++) {
    const a = harmonics(k);
    if (a === 0) continue;
    im[k] = -a * n / 2;
    im[n - k] = a * n / 2;
  }
  ifft(re, im);
  return re;
}
var sineFrame = () => additive((k) => k === 1 ? 1 : 0);
var triFrame = () => additive((k) => k % 2 === 1 ? (k % 4 === 1 ? 1 : -1) * 8 / (Math.PI * Math.PI * k * k) : 0);
var sawFrame = () => additive((k) => 2 / Math.PI * (1 / k), 800);
var squareFrame = () => additive((k) => k % 2 === 1 ? 4 / (Math.PI * k) : 0, 800);
function pwmFrame(width) {
  return additive((k) => 2 / (Math.PI * k) * Math.sin(Math.PI * k * width) * 2, 600);
}
function fmFrame(index, ratio) {
  const n = FRAME_SIZE;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ph = i / n * 2 * Math.PI;
    out[i] = Math.sin(ph + index * Math.sin(ratio * ph));
  }
  return out;
}
function vocalFrame(f1, f2, f3) {
  return additive((k) => {
    const peak = (c, w) => Math.exp(-((k - c) * (k - c)) / (2 * w * w));
    return 1 / Math.sqrt(k) * (peak(f1, 2) + 0.7 * peak(f2, 3) + 0.4 * peak(f3, 4));
  }, 128);
}
function digitalFrame(seed) {
  const n = FRAME_SIZE;
  const out = new Float32Array(n);
  let s = seed >>> 0;
  const rand = () => (s = s * 1664525 + 1013904223 >>> 0) / 4294967295 * 2 - 1;
  const steps = 8 + seed % 24;
  const levels = [];
  for (let i = 0; i < steps; i++) levels.push(rand());
  for (let i = 0; i < n; i++) out[i] = levels[Math.floor(i / n * steps)];
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= n;
  for (let i = 0; i < n; i++) out[i] -= mean;
  return out;
}
function generateWavetable(name) {
  let data;
  let numFrames = 32;
  switch (name) {
    case "Basic Shapes":
      data = spectralMorph([sineFrame(), triFrame(), sawFrame(), squareFrame()], numFrames);
      break;
    case "Harmonic Sweep":
      data = spectralMorph(
        [1, 2, 4, 8, 16, 32].map((h) => additive((k) => k <= h ? 1 / Math.sqrt(k) : 0, 64)),
        numFrames
      );
      break;
    case "PWM": {
      numFrames = 32;
      data = new Float32Array(numFrames * FRAME_SIZE);
      for (let f = 0; f < numFrames; f++) {
        const width = 0.5 - f / (numFrames - 1) * 0.45;
        data.set(pwmFrame(width), f * FRAME_SIZE);
      }
      normalizeTable(data);
      break;
    }
    case "Vocal":
      data = spectralMorph(
        [vocalFrame(6, 9, 22), vocalFrame(4, 16, 24), vocalFrame(2, 20, 28), vocalFrame(3, 7, 21), vocalFrame(2, 6, 18)],
        numFrames
      );
      break;
    case "FM Bell":
      data = spectralMorph(
        [fmFrame(0.5, 2), fmFrame(2, 2), fmFrame(4, 3.01), fmFrame(7, 5)],
        numFrames
      );
      break;
    case "Digital":
      data = spectralMorph([digitalFrame(7), digitalFrame(1234), digitalFrame(9876), digitalFrame(31415)], numFrames);
      break;
    default:
      data = spectralMorph([sineFrame(), sawFrame()], numFrames);
  }
  return { name, frameSize: FRAME_SIZE, numFrames, data };
}
function decodeWav(buf) {
  const dv = new DataView(buf);
  const tag = (off2) => String.fromCharCode(dv.getUint8(off2), dv.getUint8(off2 + 1), dv.getUint8(off2 + 2), dv.getUint8(off2 + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= dv.byteLength) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    if (id === "fmt ") {
      fmt = {
        format: dv.getUint16(off + 8, true),
        channels: dv.getUint16(off + 10, true),
        sampleRate: dv.getUint32(off + 12, true),
        bits: dv.getUint16(off + 22, true)
      };
    } else if (id === "data") {
      dataOff = off + 8;
      dataLen = size;
    }
    off += 8 + size + (size & 1);
  }
  if (!fmt || dataOff < 0) throw new Error("malformed WAV (missing fmt/data chunk)");
  const { format, channels, bits } = fmt;
  const bytesPer = bits / 8;
  const frames = Math.floor(dataLen / (bytesPer * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const o = dataOff + (i * channels + c) * bytesPer;
      let v;
      if (format === 3 && bits === 32) v = dv.getFloat32(o, true);
      else if (bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (bits === 24) {
        const b0 = dv.getUint8(o);
        const b1 = dv.getUint8(o + 1);
        const b2 = dv.getUint8(o + 2);
        let x = b2 << 16 | b1 << 8 | b0;
        if (x & 8388608) x -= 16777216;
        v = x / 8388608;
      } else if (bits === 32) v = dv.getInt32(o, true) / 2147483648;
      else if (bits === 8) v = (dv.getUint8(o) - 128) / 128;
      else throw new Error(`unsupported WAV bit depth: ${bits}`);
      sum += v;
    }
    out[i] = sum / channels;
  }
  return { sampleRate: fmt.sampleRate, channelData: out };
}
function wavToWavetable(name, wav) {
  const d = wav.channelData;
  if (d.length >= FRAME_SIZE && d.length % FRAME_SIZE === 0) {
    const numFrames = Math.min(d.length / FRAME_SIZE, 256);
    const data2 = new Float32Array(d.subarray(0, numFrames * FRAME_SIZE));
    normalizeTable(data2);
    return { name, frameSize: FRAME_SIZE, numFrames, data: data2 };
  }
  const cycle = resampleCycle(d, FRAME_SIZE);
  const data = spectralMorph([sineFrame(), cycle], 16);
  return { name, frameSize: FRAME_SIZE, numFrames: 16, data };
}

// ../../../../soundgineer/src/audio/engine.ts
var OSC_WT_IDX = [1, 2, 3].map((o) => paramIndex(`osc${o}.wavetable`));
var CUSTOM_WT = WAVETABLE_NAMES.indexOf("Custom");
var SynthEngine = class {
  values = defaultValues();
  modSlots = new Array(MAX_MOD_SLOTS).fill(null);
  lfoShapes = Array.from({ length: 8 }, () => defaultLfoShape());
  fxOrder = DEFAULT_FX_ORDER.slice();
  /** live feedback from the worklet */
  scopeL = new Float32Array(1024);
  scopeR = new Float32Array(1024);
  sourceValues = new Float32Array(MOD_SOURCES.length);
  voiceCount = 0;
  peakL = 0;
  peakR = 0;
  ctx = null;
  node = null;
  paramListeners = new Array(NUM_PARAMS);
  matrixListeners = /* @__PURE__ */ new Set();
  tableListeners = /* @__PURE__ */ new Set();
  tableCache = /* @__PURE__ */ new Map();
  customTables = [null, null, null];
  /** main-thread copy of each osc's current table, for the 3D view */
  currentTables = [null, null, null];
  heldNotes = /* @__PURE__ */ new Set();
  noteListeners = /* @__PURE__ */ new Set();
  get running() {
    return this.ctx !== null;
  }
  // SP-EXT(begin): the worklet node itself, so a host can route it (and read its port) without reaching into
  // private state.
  get audioNode() {
    return this.node;
  }
  // SP-EXT(end)
  async start(opts = {}) {
    if (this.ctx) return;
    const ctx = opts.ctx ?? new AudioContext({ latencyHint: "interactive" });
    await ctx.audioWorklet.addModule(worker_url_default);
    const node = new AudioWorkletNode(ctx, "soundgineer", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    node.port.onmessage = (e) => this.onWorkletMessage(e.data);
    if (opts.connectToDestination ?? !opts.ctx) node.connect(ctx.destination);
    this.ctx = ctx;
    this.node = node;
    await ctx.resume();
    this.syncAll();
  }
  post(msg, transfer) {
    this.node?.port.postMessage(msg, transfer ?? []);
  }
  /** Push the complete current state to the worklet (startup / preset load). */
  syncAll() {
    for (let i = 0; i < NUM_PARAMS; i++) this.post({ type: "param", index: i, value: this.values[i] });
    for (let s = 0; s < MAX_MOD_SLOTS; s++) this.post({ type: "mod", slot: s, state: this.modSlots[s] });
    for (let l = 0; l < 8; l++) this.post({ type: "lfoShape", lfo: l, points: this.lfoShapes[l] });
    this.post({ type: "fxOrder", order: this.fxOrder });
    for (let o = 0; o < 3; o++) this.sendWavetable(o);
  }
  onWorkletMessage(msg) {
    switch (msg.type) {
      case "scope":
        this.scopeL = msg.left;
        this.scopeR = msg.right;
        break;
      case "status":
        this.voiceCount = msg.voices;
        this.peakL = msg.peakL;
        this.peakR = msg.peakR;
        this.sourceValues = msg.sources;
        break;
    }
  }
  // ------------------------------------------------------------ parameters
  setParam(index, value) {
    value = Math.max(0, Math.min(1, value));
    if (this.values[index] === value) return;
    this.values[index] = value;
    this.post({ type: "param", index, value });
    this.paramListeners[index]?.forEach((fn) => fn(value));
    const osc = OSC_WT_IDX.indexOf(index);
    if (osc >= 0) this.sendWavetable(osc);
  }
  setParamById(id, value) {
    this.setParam(paramIndex(id), value);
  }
  getParam(index) {
    return this.values[index];
  }
  onParam(index, fn) {
    let set = this.paramListeners[index];
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.paramListeners[index] = set;
    }
    set.add(fn);
    return () => set.delete(fn);
  }
  // ------------------------------------------------------------ wavetables
  tableForOsc(osc) {
    const sel = Math.round(this.values[OSC_WT_IDX[osc]] * (WAVETABLE_NAMES.length - 1));
    if (sel === CUSTOM_WT && this.customTables[osc]) return this.customTables[osc];
    const name = WAVETABLE_NAMES[Math.min(sel, CUSTOM_WT - 1)] ?? WAVETABLE_NAMES[0];
    let t = this.tableCache.get(name);
    if (!t) {
      t = generateWavetable(name);
      this.tableCache.set(name, t);
    }
    return t;
  }
  sendWavetable(osc) {
    const t = this.tableForOsc(osc);
    this.currentTables[osc] = t;
    if (this.node) {
      const mips = buildMips(t.data, t.frameSize, t.numFrames);
      this.post({ type: "wavetable", osc, frameSize: t.frameSize, numFrames: t.numFrames, mips }, [mips.buffer]);
    }
    this.tableListeners.forEach((fn) => fn(osc));
  }
  /** Generate current tables for the UI before audio has started. */
  primeTables() {
    for (let o = 0; o < 3; o++) this.sendWavetable(o);
  }
  onTableChange(fn) {
    this.tableListeners.add(fn);
    return () => this.tableListeners.delete(fn);
  }
  async importWavetableFile(osc, file) {
    const buf = await file.arrayBuffer();
    const wav = decodeWav(buf);
    this.customTables[osc] = wavToWavetable(file.name.replace(/\.wav$/i, ""), wav);
    this.setParam(OSC_WT_IDX[osc], CUSTOM_WT / (WAVETABLE_NAMES.length - 1));
    this.sendWavetable(osc);
  }
  async importSampleFile(file) {
    const buf = await file.arrayBuffer();
    const wav = decodeWav(buf);
    this.post({ type: "sample", data: wav.channelData, sampleRate: wav.sampleRate }, [wav.channelData.buffer]);
  }
  // ------------------------------------------------------------ mod matrix
  onMatrixChange(fn) {
    this.matrixListeners.add(fn);
    return () => this.matrixListeners.delete(fn);
  }
  notifyMatrix() {
    this.matrixListeners.forEach((fn) => fn());
  }
  setModSlot(slot, state) {
    this.modSlots[slot] = state;
    this.post({ type: "mod", slot, state });
    this.notifyMatrix();
  }
  /** Create (or reuse) a route source -> dest. Returns the slot, or -1 if full. */
  addModRoute(source, dest, depth = 0.25) {
    const existing = this.modSlots.findIndex((s) => s && s.source === source && s.dest === dest);
    if (existing >= 0) return existing;
    const slot = this.modSlots.findIndex((s) => s === null);
    if (slot < 0) return -1;
    this.setModSlot(slot, { source, dest, depth, enabled: true });
    return slot;
  }
  routesForDest(dest) {
    const out = [];
    this.modSlots.forEach((s, slot) => {
      if (s && s.dest === dest) out.push({ slot, state: s });
    });
    return out;
  }
  // ------------------------------------------------------------ LFO shapes
  setLfoShape(lfo, points) {
    this.lfoShapes[lfo] = points;
    this.post({ type: "lfoShape", lfo, points });
  }
  // ------------------------------------------------------------ FX order
  setFxOrder(order) {
    this.fxOrder = order.slice();
    this.post({ type: "fxOrder", order: this.fxOrder });
  }
  // ------------------------------------------------------------ performance
  noteOn(note, velocity = 1) {
    this.heldNotes.add(note);
    this.post({ type: "noteOn", note, velocity });
    this.noteListeners.forEach((fn) => fn(note, true));
  }
  noteOff(note) {
    this.heldNotes.delete(note);
    this.post({ type: "noteOff", note });
    this.noteListeners.forEach((fn) => fn(note, false));
  }
  onNote(fn) {
    this.noteListeners.add(fn);
    return () => this.noteListeners.delete(fn);
  }
  sustain(down) {
    this.post({ type: "sustain", down });
  }
  pitchBend(v) {
    this.post({ type: "pitchBend", value: v });
  }
  modWheel(v) {
    this.post({ type: "modWheel", value: v });
  }
  aftertouch(v) {
    this.post({ type: "aftertouch", value: v });
  }
  allNotesOff() {
    this.heldNotes.clear();
    this.post({ type: "allNotesOff" });
  }
  // ------------------------------------------------------------ presets
  toPreset(name) {
    const params = {};
    for (let i = 0; i < NUM_PARAMS; i++) params[PARAMS[i].id] = this.values[i];
    const mods = this.modSlots.filter((s) => s !== null).map((s) => ({
      source: MOD_SOURCES[s.source].id,
      dest: PARAMS[s.dest].id,
      depth: s.depth,
      enabled: s.enabled
    }));
    return {
      name,
      version: 1,
      params,
      mods,
      lfoShapes: this.lfoShapes.map((pts) => pts.map((p2) => ({ ...p2 }))),
      fxOrder: this.fxOrder.map((i) => FX_IDS[i])
    };
  }
  loadPreset(preset) {
    const defs2 = defaultValues();
    this.values.set(defs2);
    if (preset.params) {
      for (const [id, v] of Object.entries(preset.params)) {
        try {
          this.values[paramIndex(id)] = Math.max(0, Math.min(1, v));
        } catch {
        }
      }
    }
    this.modSlots.fill(null);
    if (preset.mods) {
      preset.mods.slice(0, MAX_MOD_SLOTS).forEach((m, i) => {
        try {
          this.modSlots[i] = {
            source: modSourceIndex(m.source),
            dest: paramIndex(m.dest),
            depth: m.depth,
            enabled: m.enabled
          };
        } catch {
        }
      });
    }
    for (let l = 0; l < 8; l++) {
      this.lfoShapes[l] = preset.lfoShapes?.[l]?.length ? preset.lfoShapes[l].map((p2) => ({ ...p2 })) : defaultLfoShape();
    }
    this.fxOrder = preset.fxOrder ? preset.fxOrder.map((id) => FX_IDS.indexOf(id)).filter((i) => i >= 0) : DEFAULT_FX_ORDER.slice();
    if (this.fxOrder.length !== FX_IDS.length) this.fxOrder = DEFAULT_FX_ORDER.slice();
    this.allNotesOff();
    if (this.node) this.syncAll();
    else for (let o = 0; o < 3; o++) this.sendWavetable(o);
    for (let i = 0; i < NUM_PARAMS; i++) this.paramListeners[i]?.forEach((fn) => fn(this.values[i]));
    this.notifyMatrix();
  }
};
export {
  SynthEngine
};
