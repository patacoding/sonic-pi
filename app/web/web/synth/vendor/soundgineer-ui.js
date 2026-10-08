// ../soundgineer/src/shared/params.ts
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
function paramDef(id) {
  return PARAMS[paramIndex(id)];
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
function formatValue(d, n) {
  const v = normToValue(d, n);
  if (d.choices) return d.choices[v] ?? String(v);
  if (d.fmt) return d.fmt(v);
  return Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0);
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
var FX_IDS = ["chorus", "phaser", "flanger", "delay", "reverb", "eq", "comp", "fxdist"];
var DEFAULT_FX_ORDER = FX_IDS.map((_, i) => i);
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

// ../soundgineer/src/ui/common.ts
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== void 0) e.textContent = text;
  return e;
}
function sourceColor(source) {
  const id = MOD_SOURCES[source]?.id ?? "";
  if (id.startsWith("env")) return "#ff9a3c";
  if (id.startsWith("lfo")) return "#4cd97b";
  if (id.startsWith("macro")) return "#c77dff";
  return "#53a8ff";
}
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
var menuEl = null;
function showPopup(content, x, y) {
  closePopup();
  menuEl = content;
  content.classList.add("popup");
  document.body.appendChild(content);
  const rect = content.getBoundingClientRect();
  content.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  content.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  setTimeout(() => {
    const close = (e) => {
      if (menuEl && !menuEl.contains(e.target)) closePopup();
    };
    window.addEventListener("pointerdown", close, { capture: true, once: false });
    menuEl.dataset.closer = "attached";
    menuEl._close = close;
  }, 0);
}
function closePopup() {
  if (menuEl) {
    const close = menuEl._close;
    if (close) window.removeEventListener("pointerdown", close, { capture: true });
    menuEl.remove();
    menuEl = null;
  }
}

// ../soundgineer/src/ui/knob.ts
var knobRegistry = /* @__PURE__ */ new Map();
var Knob = class {
  constructor(engine, paramIndex2, size = 46, label) {
    this.engine = engine;
    this.paramIndex = paramIndex2;
    this.size = size;
    const def = PARAMS[paramIndex2];
    this.root = el("div", "knob");
    this.canvas = el("canvas");
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.cx = this.canvas.getContext("2d");
    this.cx.scale(dpr, dpr);
    this.labelEl = el("div", "knob-label", label ?? def.name);
    this.root.appendChild(this.canvas);
    this.root.appendChild(this.labelEl);
    if (def.moddable) this.root.classList.add("moddable");
    knobRegistry.set(this.root, this);
    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.dragging = true;
      this.dragStartY = e.clientY;
      this.dragStartVal = engine.getParam(paramIndex2);
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      const scale = e.shiftKey ? 5e-4 : 5e-3;
      const v = clamp01(this.dragStartVal + (this.dragStartY - e.clientY) * scale);
      engine.setParam(paramIndex2, v);
      this.showValue();
    });
    const endDrag = () => {
      if (this.dragging) {
        this.dragging = false;
        this.labelEl.textContent = label ?? def.name;
      }
    };
    this.canvas.addEventListener("pointerup", endDrag);
    this.canvas.addEventListener("pointercancel", endDrag);
    this.canvas.addEventListener("dblclick", () => {
      engine.setParam(paramIndex2, defaultNorm(def));
    });
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const step = (e.shiftKey ? 2e-3 : 0.02) * (e.deltaY > 0 ? -1 : 1);
      engine.setParam(paramIndex2, clamp01(engine.getParam(paramIndex2) + step));
      this.showValue();
    }, { passive: false });
    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (def.moddable) this.openModMenu(e.clientX, e.clientY);
    });
    engine.onParam(paramIndex2, () => this.draw());
    engine.onMatrixChange(() => {
      this.hasRoutes = engine.routesForDest(paramIndex2).length > 0;
      this.draw();
    });
    this.hasRoutes = engine.routesForDest(paramIndex2).length > 0;
    this.draw();
  }
  engine;
  paramIndex;
  size;
  root;
  canvas;
  labelEl;
  cx;
  dragging = false;
  dragStartY = 0;
  dragStartVal = 0;
  hasRoutes = false;
  showValue() {
    this.labelEl.textContent = formatValue(PARAMS[this.paramIndex], this.engine.getParam(this.paramIndex));
  }
  /** Redraw each animation frame only when modulated (animated arcs). */
  get animated() {
    return this.hasRoutes;
  }
  draw() {
    const c = this.cx;
    const s = this.size;
    const r = s / 2 - 5;
    const cx = s / 2;
    const cy = s / 2;
    const a0 = 0.75 * Math.PI;
    const sweep = 1.5 * Math.PI;
    const v = this.engine.getParam(this.paramIndex);
    c.clearRect(0, 0, s, s);
    c.beginPath();
    c.arc(cx, cy, r, a0, a0 + sweep);
    c.strokeStyle = "#2a2d36";
    c.lineWidth = 3.5;
    c.lineCap = "round";
    c.stroke();
    const def = PARAMS[this.paramIndex];
    const bipolar = !def.choices && def.min < 0 && def.max > 0;
    const start = bipolar ? a0 + sweep * (0 - def.min) / (def.max - def.min) : a0;
    c.beginPath();
    if (bipolar) {
      const va = a0 + sweep * v;
      c.arc(cx, cy, r, Math.min(start, va), Math.max(start, va));
    } else {
      c.arc(cx, cy, r, a0, a0 + sweep * v);
    }
    c.strokeStyle = "#53a8ff";
    c.stroke();
    const routes = this.engine.routesForDest(this.paramIndex);
    if (routes.length) {
      let ring = r + 3.5;
      for (const { state } of routes) {
        if (!state.enabled) continue;
        const col = sourceColor(state.source);
        const va = a0 + sweep * v;
        const depthA = sweep * state.depth;
        c.beginPath();
        c.arc(cx, cy, ring, Math.min(va, va + depthA), Math.max(va, va + depthA));
        c.strokeStyle = col + "55";
        c.lineWidth = 2;
        c.stroke();
        const src = this.engine.sourceValues[state.source] ?? 0;
        const cur = clamp01(v + state.depth * src);
        const ca = a0 + sweep * cur;
        c.beginPath();
        c.arc(cx + Math.cos(ca) * ring, cy + Math.sin(ca) * ring, 1.8, 0, 2 * Math.PI);
        c.fillStyle = col;
        c.fill();
        ring += 3;
      }
    }
    const pa = a0 + sweep * v;
    c.beginPath();
    c.moveTo(cx + Math.cos(pa) * (r - 6), cy + Math.sin(pa) * (r - 6));
    c.lineTo(cx + Math.cos(pa) * (r - 1), cy + Math.sin(pa) * (r - 1));
    c.strokeStyle = "#e8eaf0";
    c.lineWidth = 2;
    c.stroke();
  }
  openModMenu(x, y) {
    const menu = el("div", "mod-menu");
    menu.appendChild(el("div", "mod-menu-title", `Modulation \u2192 ${PARAMS[this.paramIndex].name}`));
    const routesBox = el("div");
    const renderRoutes = () => {
      routesBox.textContent = "";
      for (const { slot, state } of this.engine.routesForDest(this.paramIndex)) {
        const row = el("div", "mod-menu-row");
        const chip = el("span", "mod-chip", MOD_SOURCES[state.source].name);
        chip.style.background = sourceColor(state.source);
        const slider = el("input");
        slider.type = "range";
        slider.min = "-100";
        slider.max = "100";
        slider.value = String(Math.round(state.depth * 100));
        slider.addEventListener("input", () => {
          this.engine.setModSlot(slot, { ...state, depth: Number(slider.value) / 100 });
        });
        const del = el("button", "mod-del", "\u2715");
        del.addEventListener("click", () => {
          this.engine.setModSlot(slot, null);
          renderRoutes();
        });
        row.append(chip, slider, del);
        routesBox.appendChild(row);
      }
    };
    renderRoutes();
    menu.appendChild(routesBox);
    menu.appendChild(el("div", "mod-menu-sub", "Add source"));
    const grid = el("div", "mod-menu-grid");
    MOD_SOURCES.forEach((s, i) => {
      const b = el("button", "mod-src-btn", s.name);
      b.style.borderColor = sourceColor(i);
      b.addEventListener("click", () => {
        this.engine.addModRoute(i, this.paramIndex);
        renderRoutes();
      });
      grid.appendChild(b);
    });
    menu.appendChild(grid);
    showPopup(menu, x, y);
  }
};
var ModDragController = class {
  ghost = null;
  source = -1;
  engine = null;
  start(engine, source, e) {
    this.engine = engine;
    this.source = source;
    this.ghost = el("div", "mod-ghost", MOD_SOURCES[source].name);
    this.ghost.style.background = sourceColor(source);
    document.body.appendChild(this.ghost);
    document.body.classList.add("mod-dragging");
    this.move(e);
    const onMove = (ev) => this.move(ev);
    const onUp = (ev) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      this.drop(ev);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
  move(e) {
    if (this.ghost) {
      this.ghost.style.left = `${e.clientX + 10}px`;
      this.ghost.style.top = `${e.clientY + 10}px`;
    }
  }
  drop(e) {
    document.body.classList.remove("mod-dragging");
    this.ghost?.remove();
    this.ghost = null;
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(".knob");
    if (target && this.engine) {
      const knob = knobRegistry.get(target);
      if (knob && PARAMS[knob.paramIndex].moddable) {
        this.engine.addModRoute(this.source, knob.paramIndex);
        target.classList.add("mod-flash");
        setTimeout(() => target.classList.remove("mod-flash"), 400);
      }
    }
  }
};
var modDrag = new ModDragController();
function sourceBadge(engine, sourceId) {
  const i = MOD_SOURCES.findIndex((s) => s.id === sourceId);
  const badge = el("div", "source-badge", MOD_SOURCES[i].name);
  badge.style.borderColor = sourceColor(i);
  badge.title = "Drag onto a knob to assign modulation";
  badge.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    closePopup();
    modDrag.start(engine, i, e);
  });
  return badge;
}
function animatedKnobs() {
  return [...knobRegistry.values()].filter((k) => k.animated);
}

// ../soundgineer/src/ui/controls.ts
function paramSelect(engine, id) {
  const index = paramIndex(id);
  const def = PARAMS[index];
  const choices = def.choices ?? [];
  const sel = el("select", "param-select");
  choices.forEach((c, i) => {
    const o = el("option", void 0, c);
    o.value = String(i);
    sel.appendChild(o);
  });
  const sync = () => {
    sel.value = String(Math.round(normToValue(def, engine.getParam(index))));
  };
  sync();
  sel.addEventListener("change", () => {
    engine.setParam(index, valueToNorm(def, Number(sel.value)));
  });
  engine.onParam(index, sync);
  return sel;
}
function paramToggle(engine, id, label = "ON") {
  const index = paramIndex(id);
  const b = el("button", "toggle", label);
  const sync = () => b.classList.toggle("on", engine.getParam(index) >= 0.5);
  sync();
  b.addEventListener("click", () => {
    engine.setParam(index, engine.getParam(index) >= 0.5 ? 0 : 1);
  });
  engine.onParam(index, sync);
  return b;
}
function knobRow(engine, ids, size = 46) {
  const row = el("div", "knob-row");
  for (const id of ids) row.appendChild(new Knob(engine, paramIndex(id), size).root);
  return row;
}

// ../soundgineer/src/ui/enveditor.ts
function shape(t, c) {
  return Math.pow(t, Math.pow(2, c * 3));
}
var EnvDisplay = class {
  constructor(engine, env) {
    this.engine = engine;
    this.env = env;
    this.root = el("div", "env-display");
    this.canvas = el("canvas");
    this.root.appendChild(this.canvas);
    this.cx = this.canvas.getContext("2d");
    this.canvas.style.touchAction = "none";
    this.canvas.style.cursor = "crosshair";
    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("pointerup", this.onUp);
    this.canvas.addEventListener("pointercancel", this.onUp);
    new ResizeObserver(() => this.resize()).observe(this.root);
    for (let e = 1; e <= 6; e++) {
      for (const f of ["delay", "attack", "hold", "decay", "sustain", "release", "atk_curve", "dec_curve", "rel_curve"]) {
        engine.onParam(paramIndex(`env${e}.${f}`), () => this.draw());
      }
    }
  }
  engine;
  env;
  root;
  canvas;
  cx;
  w = 0;
  h = 0;
  // ── SP-EXT: direct editing ─────────────────────────────────────────────────────────────────────────────
  handles = [];
  drag = null;
  setValue(field, value2) {
    const i = paramIndex(`env${this.env}.${field}`);
    const v = Math.min(1, Math.max(0, valueToNorm(PARAMS[i], value2)));
    this.engine.setParam(i, v);
    this.draw();
  }
  onDown = (e) => {
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    let best = null;
    let bestD = 14;
    for (const h of this.handles) {
      const d = Math.hypot(h.x - px, h.y - py);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    if (!best) return;
    this.drag = { field: best.field, kind: best.kind, grabX: px };
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
    }
    e.preventDefault();
  };
  onMove = (e) => {
    if (!this.drag) return;
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (this.drag.kind === "level") {
      this.setValue("sustain", Math.min(1, Math.max(0, 1 - (py - 5) / (this.h - 10 || 1))));
    } else if (this.drag.kind === "curve") {
      const c = Math.min(1, Math.max(-1, 1 - 2 * ((py - 5) / (this.h - 10 || 1))));
      const field = this.drag.field;
      if (field === "attack") this.setValue("atk_curve", c);
      else if (field === "decay") this.setValue("dec_curve", c);
      else this.setValue("rel_curve", c);
    } else {
      const cur = this.v(this.drag.field);
      const perPx = (this.v("delay") + this.v("attack") + this.v("hold") + this.v("decay") + this.v("release")) / (this.w - 8 || 1);
      this.setValue(this.drag.field, Math.max(5e-4, cur + (px - this.drag.grabX) * perPx));
      this.drag.grabX = px;
    }
    e.preventDefault();
  };
  onUp = (e) => {
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
    }
  };
  setEnv(env) {
    this.env = env;
    this.draw();
  }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.root.clientWidth;
    this.h = this.root.clientHeight;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }
  v(field) {
    const i = paramIndex(`env${this.env}.${field}`);
    return normToValue(PARAMS[i], this.engine.getParam(i));
  }
  draw() {
    const c = this.cx;
    const w = this.w;
    const h = this.h;
    if (!w || !h) return;
    c.clearRect(0, 0, w, h);
    const del = this.v("delay");
    const atk = this.v("attack");
    const hold = this.v("hold");
    const dec = this.v("decay");
    const sus = this.v("sustain");
    const rel = this.v("release");
    const ac = this.v("atk_curve");
    const dc = this.v("dec_curve");
    const rc = this.v("rel_curve");
    const susTime = Math.max(0.15 * (del + atk + hold + dec + rel), 0.05);
    const total = del + atk + hold + dec + susTime + rel;
    const X = (t) => t / total * (w - 8) + 4;
    const Y = (v) => (1 - v) * (h - 10) + 5;
    c.beginPath();
    c.moveTo(X(0), Y(0));
    c.lineTo(X(del), Y(0));
    const N = 40;
    for (let i = 1; i <= N; i++) c.lineTo(X(del + i / N * atk), Y(shape(i / N, ac)));
    c.lineTo(X(del + atk + hold), Y(1));
    for (let i = 1; i <= N; i++) c.lineTo(X(del + atk + hold + i / N * dec), Y(sus + (1 - sus) * (1 - shape(i / N, -dc))));
    c.lineTo(X(del + atk + hold + dec + susTime), Y(sus));
    for (let i = 1; i <= N; i++) c.lineTo(X(del + atk + hold + dec + susTime + i / N * rel), Y(sus * (1 - shape(i / N, -rc))));
    c.strokeStyle = "#ff9a3c";
    c.lineWidth = 2;
    c.stroke();
    c.lineTo(X(total), Y(0) + 5);
    c.lineTo(X(0), Y(0) + 5);
    c.closePath();
    c.fillStyle = "#ff9a3c15";
    c.fill();
    const susX = X(del + atk + hold + dec + susTime / 2);
    this.handles = [
      { field: "delay", kind: "time", x: X(del), y: Y(0) },
      { field: "attack", kind: "time", x: X(del + atk), y: Y(1) },
      { field: "hold", kind: "time", x: X(del + atk + hold), y: Y(1) },
      { field: "decay", kind: "time", x: X(del + atk + hold + dec), y: Y(sus) },
      { field: "release", kind: "time", x: X(total), y: Y(0) },
      { field: "sustain", kind: "level", x: susX, y: Y(sus) },
      { field: "attack", kind: "curve", x: X(del + atk / 2), y: Y(shape(0.5, ac)) },
      { field: "decay", kind: "curve", x: X(del + atk + hold + dec / 2), y: Y(sus + (1 - sus) * (1 - shape(0.5, -dc))) },
      { field: "release", kind: "curve", x: X(del + atk + hold + dec + susTime + rel / 2), y: Y(sus * (1 - shape(0.5, -rc))) }
    ];
    window.__sgrEnvHandles = this.handles.map((h2) => ({ field: h2.field, kind: h2.kind, x: h2.x, y: h2.y }));
    c.fillStyle = "#ff9a3c";
    for (const hd of this.handles) {
      c.beginPath();
      c.arc(hd.x, hd.y, 3.5, 0, Math.PI * 2);
      c.fill();
    }
    const live = this.engine.sourceValues[this.env - 1] ?? 0;
    if (live > 1e-3) {
      c.beginPath();
      c.moveTo(0, Y(live));
      c.lineTo(w, Y(live));
      c.strokeStyle = "#ff9a3c50";
      c.lineWidth = 1;
      c.stroke();
    }
  }
};

// ../soundgineer/src/ui/lfoeditor.ts
var HIT = 10;
var LfoEditor = class {
  constructor(engine, lfo) {
    this.engine = engine;
    this.lfo = lfo;
    this.root = el("div", "lfo-editor");
    this.canvas = el("canvas");
    this.root.appendChild(this.canvas);
    this.cx = this.canvas.getContext("2d");
    new ResizeObserver(() => this.resize()).observe(this.root);
    this.canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.onMove(e));
    const up = () => {
      this.dragPoint = -1;
      this.dragSegment = -1;
    };
    this.canvas.addEventListener("pointerup", up);
    this.canvas.addEventListener("pointercancel", up);
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  engine;
  lfo;
  root;
  canvas;
  cx;
  w = 0;
  h = 0;
  dragPoint = -1;
  dragSegment = -1;
  dragStartPower = 0;
  dragStartY = 0;
  setLfo(lfo) {
    this.lfo = lfo;
    this.draw();
  }
  get points() {
    return this.engine.lfoShapes[this.lfo];
  }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.root.clientWidth;
    this.h = this.root.clientHeight;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }
  toX(x) {
    return x * this.w;
  }
  toY(y) {
    return (1 - y) * this.h;
  }
  pointAt(px, py) {
    return this.points.findIndex((p2) => Math.hypot(this.toX(p2.x) - px, this.toY(p2.y) - py) < HIT);
  }
  segmentAt(px, py) {
    const pts = this.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = evalLfoShape(pts, mx);
      if (Math.hypot(this.toX(mx) - px, this.toY(my) - py) < HIT) return i;
    }
    return -1;
  }
  onDown(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const pi = this.pointAt(px, py);
    if (e.button === 2) {
      if (pi > 0 && pi < this.points.length - 1) {
        const pts2 = this.points.slice();
        pts2.splice(pi, 1);
        this.commit(pts2);
      }
      return;
    }
    if (pi >= 0) {
      this.dragPoint = pi;
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    const si = this.segmentAt(px, py);
    if (si >= 0) {
      this.dragSegment = si;
      this.dragStartPower = this.points[si].power;
      this.dragStartY = py;
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    const pts = this.points.slice();
    const x = Math.max(1e-3, Math.min(0.999, px / this.w));
    const y = Math.max(0, Math.min(1, 1 - py / this.h));
    let insert = pts.findIndex((p2) => p2.x > x);
    if (insert < 0) insert = pts.length - 1;
    pts.splice(insert, 0, { x, y, power: 0 });
    this.commit(pts);
    this.dragPoint = insert;
    this.canvas.setPointerCapture(e.pointerId);
  }
  onMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (this.dragPoint >= 0) {
      const pts = this.points.slice().map((p3) => ({ ...p3 }));
      const p2 = pts[this.dragPoint];
      let x = px / this.w;
      let y = 1 - py / this.h;
      if (e.ctrlKey || e.metaKey) {
        x = Math.round(x * 16) / 16;
        y = Math.round(y * 8) / 8;
      }
      if (this.dragPoint === 0) x = 0;
      else if (this.dragPoint === pts.length - 1) x = 1;
      else x = Math.max(pts[this.dragPoint - 1].x + 2e-3, Math.min(pts[this.dragPoint + 1].x - 2e-3, x));
      p2.x = Math.max(0, Math.min(1, x));
      p2.y = Math.max(0, Math.min(1, y));
      this.commit(pts);
      return;
    }
    if (this.dragSegment >= 0) {
      const pts = this.points.slice().map((p2) => ({ ...p2 }));
      const delta = (this.dragStartY - py) / 80;
      const sign = pts[this.dragSegment + 1].y >= pts[this.dragSegment].y ? 1 : -1;
      pts[this.dragSegment].power = Math.max(-1, Math.min(1, this.dragStartPower + delta * sign));
      this.commit(pts);
      return;
    }
    const pi = this.pointAt(px, py);
    const si = pi < 0 ? this.segmentAt(px, py) : -1;
    this.canvas.style.cursor = pi >= 0 ? "grab" : si >= 0 ? "ns-resize" : "crosshair";
  }
  commit(pts) {
    this.engine.setLfoShape(this.lfo, pts);
    this.draw();
  }
  draw() {
    const c = this.cx;
    const w = this.w;
    const h = this.h;
    if (!w || !h) return;
    c.clearRect(0, 0, w, h);
    c.strokeStyle = "#23252d";
    c.lineWidth = 1;
    for (let i = 1; i < 16; i++) {
      c.beginPath();
      c.moveTo(i / 16 * w, 0);
      c.lineTo(i / 16 * w, h);
      c.stroke();
    }
    for (let i = 1; i < 4; i++) {
      c.beginPath();
      c.moveTo(0, i / 4 * h);
      c.lineTo(w, i / 4 * h);
      c.stroke();
    }
    const pts = this.points;
    c.beginPath();
    c.moveTo(0, this.toY(evalLfoShape(pts, 0)));
    const steps = Math.max(64, w);
    for (let i = 1; i <= steps; i++) {
      const x = i / steps;
      c.lineTo(this.toX(x), this.toY(evalLfoShape(pts, x)));
    }
    c.strokeStyle = "#4cd97b";
    c.lineWidth = 2;
    c.stroke();
    c.lineTo(w, h);
    c.lineTo(0, h);
    c.closePath();
    c.fillStyle = "#4cd97b18";
    c.fill();
    for (let i = 0; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      c.beginPath();
      c.arc(this.toX(mx), this.toY(evalLfoShape(pts, mx)), 3, 0, 2 * Math.PI);
      c.fillStyle = "#4cd97b66";
      c.fill();
    }
    for (const p2 of pts) {
      c.beginPath();
      c.arc(this.toX(p2.x), this.toY(p2.y), 4.5, 0, 2 * Math.PI);
      c.fillStyle = "#e8eaf0";
      c.fill();
      c.strokeStyle = "#4cd97b";
      c.stroke();
    }
    const live = this.engine.sourceValues[6 + this.lfo] ?? 0;
    c.beginPath();
    c.moveTo(0, this.toY(live));
    c.lineTo(w, this.toY(live));
    c.strokeStyle = "#4cd97b40";
    c.stroke();
  }
};

// ../soundgineer/src/ui/matrix.ts
var MODDABLE = PARAMS.map((d, i) => ({ d, i })).filter(({ d }) => d.moddable);
function destLabel(i) {
  const d = PARAMS[i];
  return `${d.group} \xB7 ${d.name}`;
}
var ModMatrix = class {
  constructor(engine) {
    this.engine = engine;
    this.root = el("div", "matrix");
    const head = el("div", "matrix-head");
    head.append(
      el("span", void 0, "SOURCE"),
      el("span", void 0, "DEPTH"),
      el("span", void 0, "DESTINATION"),
      el("span", void 0, "")
    );
    this.rows = el("div", "matrix-rows");
    const add = el("button", "matrix-add", "+ Add route");
    add.addEventListener("click", () => {
      const slot = this.engine.modSlots.findIndex((s) => s === null);
      if (slot >= 0) {
        this.engine.setModSlot(slot, { source: 6, dest: MODDABLE[0].i, depth: 0.25, enabled: true });
      }
    });
    this.root.append(head, this.rows, add);
    engine.onMatrixChange(() => this.render());
    this.render();
  }
  engine;
  root;
  rows;
  render() {
    this.rows.textContent = "";
    for (let slot = 0; slot < MAX_MOD_SLOTS; slot++) {
      const state = this.engine.modSlots[slot];
      if (!state) continue;
      const row = el("div", "matrix-row");
      const src = el("select", "param-select");
      MOD_SOURCES.forEach((s, i) => {
        const o = el("option", void 0, s.name);
        o.value = String(i);
        src.appendChild(o);
      });
      src.value = String(state.source);
      src.style.borderLeft = `3px solid ${sourceColor(state.source)}`;
      src.addEventListener("change", () => {
        this.engine.setModSlot(slot, { ...state, source: Number(src.value) });
      });
      const depthWrap = el("div", "matrix-depth");
      const depth = el("input");
      depth.type = "range";
      depth.min = "-100";
      depth.max = "100";
      depth.value = String(Math.round(state.depth * 100));
      const depthLabel = el("span", "matrix-depth-label", `${Math.round(state.depth * 100)}%`);
      depth.addEventListener("input", () => {
        depthLabel.textContent = `${depth.value}%`;
        this.engine.setModSlot(slot, { ...this.engine.modSlots[slot], depth: Number(depth.value) / 100 });
      });
      depthWrap.append(depth, depthLabel);
      const dest = el("select", "param-select");
      for (const { i } of MODDABLE) {
        const o = el("option", void 0, destLabel(i));
        o.value = String(i);
        dest.appendChild(o);
      }
      dest.value = String(state.dest);
      dest.addEventListener("change", () => {
        this.engine.setModSlot(slot, { ...state, dest: Number(dest.value) });
      });
      const controls = el("div", "matrix-controls");
      const enable = el("button", `toggle${state.enabled ? " on" : ""}`, "\u25CF");
      enable.title = "Enable/bypass";
      enable.addEventListener("click", () => {
        this.engine.setModSlot(slot, { ...state, enabled: !state.enabled });
      });
      const del = el("button", "mod-del", "\u2715");
      del.addEventListener("click", () => this.engine.setModSlot(slot, null));
      controls.append(enable, del);
      row.append(src, depthWrap, dest, controls);
      this.rows.appendChild(row);
    }
  }
};

// ../soundgineer/src/ui/fxrack.ts
var FX_LABELS = {
  chorus: "CHORUS",
  phaser: "PHASER",
  flanger: "FLANGER",
  delay: "DELAY",
  reverb: "REVERB",
  eq: "EQ",
  comp: "COMPRESSOR",
  fxdist: "DISTORTION"
};
var FX_KNOBS = {
  chorus: ["chorus.rate", "chorus.depth", "chorus.mix"],
  phaser: ["phaser.rate", "phaser.depth", "phaser.feedback", "phaser.mix"],
  flanger: ["flanger.rate", "flanger.depth", "flanger.feedback", "flanger.mix"],
  delay: ["delay.time", "delay.feedback", "delay.mix"],
  reverb: ["reverb.size", "reverb.damp", "reverb.width", "reverb.mix"],
  eq: ["eq.low_gain", "eq.mid_gain", "eq.mid_freq", "eq.high_gain"],
  comp: ["comp.threshold", "comp.ratio", "comp.attack", "comp.release", "comp.makeup"],
  fxdist: ["fxdist.drive", "fxdist.tone", "fxdist.mix"]
};
var FxRack = class {
  constructor(engine) {
    this.engine = engine;
    this.root = el("div", "fx-rack");
    for (let i = 0; i < FX_IDS.length; i++) this.units.set(i, this.buildUnit(i));
    this.render();
  }
  engine;
  root;
  units = /* @__PURE__ */ new Map();
  buildUnit(fx) {
    const id = FX_IDS[fx];
    const unit = el("div", "fx-unit");
    const head = el("div", "fx-head");
    head.appendChild(paramToggle(this.engine, `${id}.enabled`, "\u25CF"));
    head.appendChild(el("span", "fx-name", FX_LABELS[id]));
    const spacer = el("span", "fx-spacer");
    head.appendChild(spacer);
    const up = el("button", "fx-move", "\u25B2");
    const down = el("button", "fx-move", "\u25BC");
    up.addEventListener("click", () => this.move(fx, -1));
    down.addEventListener("click", () => this.move(fx, 1));
    head.append(up, down);
    unit.appendChild(head);
    const body = el("div", "fx-body");
    if (id === "delay") {
      const opts = el("div", "fx-opts");
      opts.appendChild(paramToggle(this.engine, "delay.sync", "SYNC"));
      opts.appendChild(paramSelect(this.engine, "delay.division"));
      opts.appendChild(paramToggle(this.engine, "delay.pingpong", "PING"));
      body.appendChild(opts);
    }
    body.appendChild(knobRow(this.engine, FX_KNOBS[id], 40));
    unit.appendChild(body);
    return unit;
  }
  move(fx, dir) {
    const order = this.engine.fxOrder.slice();
    const pos = order.indexOf(fx);
    const to = pos + dir;
    if (to < 0 || to >= order.length) return;
    order.splice(pos, 1);
    order.splice(to, 0, fx);
    this.engine.setFxOrder(order);
    this.render();
  }
  render() {
    this.root.textContent = "";
    for (const fx of this.engine.fxOrder) this.root.appendChild(this.units.get(fx));
  }
};

// ../soundgineer/src/shared/fft.ts
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

// ../soundgineer/src/ui/scope.ts
var Scope = class {
  constructor(engine) {
    this.engine = engine;
    this.root = el("div", "scope");
    const tabs = el("div", "scope-tabs");
    const waveBtn = el("button", "scope-tab on", "WAVE");
    const specBtn = el("button", "scope-tab", "SPECTRUM");
    waveBtn.addEventListener("click", () => {
      this.mode = "wave";
      waveBtn.classList.add("on");
      specBtn.classList.remove("on");
    });
    specBtn.addEventListener("click", () => {
      this.mode = "spectrum";
      specBtn.classList.add("on");
      waveBtn.classList.remove("on");
    });
    tabs.append(waveBtn, specBtn);
    this.canvas = el("canvas");
    this.root.append(tabs, this.canvas);
    this.cx = this.canvas.getContext("2d");
    new ResizeObserver(() => this.resize()).observe(this.root);
  }
  engine;
  root;
  canvas;
  cx;
  w = 0;
  h = 0;
  mode = "wave";
  re = new Float32Array(1024);
  im = new Float32Array(1024);
  smooth = new Float32Array(512);
  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.w = this.root.clientWidth;
    this.h = this.root.clientHeight - 22;
    this.canvas.width = this.w * dpr;
    this.canvas.height = Math.max(this.h, 10) * dpr;
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${Math.max(this.h, 10)}px`;
    this.cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  /** called from the app's requestAnimationFrame loop */
  draw() {
    const c = this.cx;
    const w = this.w;
    const h = this.h;
    if (!w || h < 10) return;
    c.clearRect(0, 0, w, h);
    c.fillStyle = "#101218";
    c.fillRect(0, 0, w, h);
    if (this.mode === "wave") {
      const L2 = this.engine.scopeL;
      c.beginPath();
      for (let i = 0; i < L2.length; i++) {
        const x = i / (L2.length - 1) * w;
        const y = h / 2 - L2[i] * h * 0.45;
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.strokeStyle = "#53a8ff";
      c.lineWidth = 1.5;
      c.stroke();
      const R2 = this.engine.scopeR;
      c.beginPath();
      for (let i = 0; i < R2.length; i++) {
        const x = i / (R2.length - 1) * w;
        const y = h / 2 - R2[i] * h * 0.45;
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.strokeStyle = "#53a8ff55";
      c.lineWidth = 1;
      c.stroke();
      return;
    }
    const L = this.engine.scopeL;
    const R = this.engine.scopeR;
    const n = 1024;
    for (let i = 0; i < n; i++) {
      const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
      this.re[i] = ((L[i] ?? 0) + (R[i] ?? 0)) * 0.5 * win;
      this.im[i] = 0;
    }
    fft(this.re, this.im);
    const sr = this.engine.ctx?.sampleRate ?? 48e3;
    const bars = 96;
    const fMin = 25;
    const fMax = sr / 2;
    for (let b = 0; b < bars; b++) {
      const f0 = fMin * Math.pow(fMax / fMin, b / bars);
      const f1 = fMin * Math.pow(fMax / fMin, (b + 1) / bars);
      let k0 = Math.max(1, Math.floor(f0 / sr * n));
      const k1 = Math.min(n / 2, Math.max(k0 + 1, Math.ceil(f1 / sr * n)));
      let peak = 0;
      for (let k = k0; k < k1; k++) {
        const m = Math.hypot(this.re[k], this.im[k]);
        if (m > peak) peak = m;
      }
      const db2 = 20 * Math.log10(peak / (n / 4) + 1e-9);
      const v = Math.max(0, (db2 + 80) / 80);
      const sm = Math.max(v, this.smooth[b] * 0.85);
      this.smooth[b] = sm;
      const bw = w / bars;
      const bh = sm * (h - 4);
      c.fillStyle = `hsl(${210 - sm * 60}, 80%, ${35 + sm * 25}%)`;
      c.fillRect(b * bw + 0.5, h - bh, bw - 1, bh);
    }
  }
};

// ../soundgineer/src/ui/wt3d.ts
var POINTS = 128;
var VERT = `#version 300 es
precision highp float;
in vec3 aPos; // x: 0..1 along cycle, y: sample value, z: 0..1 frame position
uniform float uAspect;
uniform float uZ; // -1 = use aPos.z, otherwise override (morph line)
void main() {
  float z01 = uZ < 0.0 ? aPos.z : uZ;
  vec3 p = vec3(aPos.x * 1.7 - 0.85, aPos.y * 0.35, z01 * 1.5 - 0.75);
  // yaw
  float cy = cos(0.55), sy = sin(0.55);
  p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
  // pitch
  float cx = cos(0.42), sx = sin(0.42);
  p = vec3(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);
  float zc = p.z + 2.6;
  gl_Position = vec4(p.x * 2.0 / zc / uAspect, p.y * 2.0 / zc + 0.05, p.z * 0.1, 1.0);
}`;
var FRAG = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`;
var WavetableView = class {
  constructor(engine) {
    this.engine = engine;
    this.root = el("div", "wt3d");
    const tabs = el("div", "wt3d-tabs");
    for (let o = 0; o < 3; o++) {
      const b = el("button", o === 0 ? "scope-tab on" : "scope-tab", `OSC ${o + 1}`);
      b.addEventListener("click", () => {
        this.osc = o;
        this.oscTabs.forEach((t, i) => t.classList.toggle("on", i === o));
        this.rebuild();
      });
      this.oscTabs.push(b);
      tabs.appendChild(b);
    }
    this.canvas = el("canvas");
    this.root.append(tabs, this.canvas);
    new ResizeObserver(() => this.resize()).observe(this.root);
    engine.onTableChange((osc) => {
      if (osc === this.osc) this.rebuild();
    });
    this.initGl();
    this.rebuild();
  }
  engine;
  root;
  canvas;
  gl = null;
  prog = null;
  framesVbo = null;
  morphVbo = null;
  framesVao = null;
  morphVao = null;
  numFrames = 0;
  osc = 0;
  uColor = null;
  uAspect = null;
  uZ = null;
  morphScratch = new Float32Array(POINTS * 3);
  oscTabs = [];
  initGl() {
    const gl = this.canvas.getContext("webgl2", { antialias: true, alpha: true });
    if (!gl) return;
    this.gl = gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(String(gl.getShaderInfoLog(sh)));
      }
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(String(gl.getProgramInfoLog(prog)));
    }
    this.prog = prog;
    this.uColor = gl.getUniformLocation(prog, "uColor");
    this.uAspect = gl.getUniformLocation(prog, "uAspect");
    this.uZ = gl.getUniformLocation(prog, "uZ");
    this.framesVbo = gl.createBuffer();
    this.morphVbo = gl.createBuffer();
    this.framesVao = gl.createVertexArray();
    this.morphVao = gl.createVertexArray();
    for (const [vao, vbo] of [[this.framesVao, this.framesVbo], [this.morphVao, this.morphVbo]]) {
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);
  }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.root.clientWidth;
    const h = this.root.clientHeight - 22;
    this.canvas.width = Math.max(w, 1) * dpr;
    this.canvas.height = Math.max(h, 1) * dpr;
    this.canvas.style.width = `${Math.max(w, 1)}px`;
    this.canvas.style.height = `${Math.max(h, 1)}px`;
  }
  /** Rebuild the static frame geometry from the current table. */
  rebuild() {
    const gl = this.gl;
    const table = this.engine.currentTables[this.osc];
    if (!gl || !table) {
      this.numFrames = 0;
      return;
    }
    const { frameSize, numFrames, data } = table;
    const verts = new Float32Array(numFrames * POINTS * 3);
    let vi = 0;
    for (let f = 0; f < numFrames; f++) {
      const z = numFrames > 1 ? f / (numFrames - 1) : 0;
      for (let i = 0; i < POINTS; i++) {
        const si = Math.floor(i / (POINTS - 1) * (frameSize - 1));
        verts[vi++] = i / (POINTS - 1);
        verts[vi++] = data[f * frameSize + si];
        verts[vi++] = z;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.framesVbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    this.numFrames = numFrames;
  }
  /** called from the app's requestAnimationFrame loop */
  draw() {
    const gl = this.gl;
    if (!gl || !this.prog) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.055, 0.06, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.numFrames === 0) return;
    gl.useProgram(this.prog);
    gl.uniform1f(this.uAspect, this.canvas.width / Math.max(this.canvas.height, 1));
    gl.lineWidth(1);
    const morphIdx = paramIndex(`osc${this.osc + 1}.morph`);
    let morph = this.engine.getParam(morphIdx);
    for (const { state } of this.engine.routesForDest(morphIdx)) {
      if (state.enabled) morph += state.depth * (this.engine.sourceValues[state.source] ?? 0);
    }
    morph = Math.max(0, Math.min(1, morph));
    gl.bindVertexArray(this.framesVao);
    gl.uniform1f(this.uZ, -1);
    const highlight = Math.round(morph * (this.numFrames - 1));
    for (let f = 0; f < this.numFrames; f++) {
      const d = Math.abs(f - highlight) / Math.max(this.numFrames - 1, 1);
      if (f === highlight) gl.uniform4f(this.uColor, 0.55, 0.83, 1, 0.9);
      else gl.uniform4f(this.uColor, 0.25, 0.42, 0.65, 0.75 - d * 0.45);
      gl.drawArrays(gl.LINE_STRIP, f * POINTS, POINTS);
    }
    const table = this.engine.currentTables[this.osc];
    if (table && this.numFrames > 1) {
      const { frameSize, numFrames, data } = table;
      const fpos = morph * (numFrames - 1);
      const f0 = Math.min(Math.floor(fpos), numFrames - 2);
      const t = fpos - f0;
      let vi = 0;
      for (let i = 0; i < POINTS; i++) {
        const si = Math.floor(i / (POINTS - 1) * (frameSize - 1));
        const a = data[f0 * frameSize + si];
        const b = data[(f0 + 1) * frameSize + si];
        this.morphScratch[vi++] = i / (POINTS - 1);
        this.morphScratch[vi++] = a + (b - a) * t;
        this.morphScratch[vi++] = morph;
      }
      gl.bindVertexArray(this.morphVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.morphVbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.morphScratch, gl.DYNAMIC_DRAW);
      gl.uniform1f(this.uZ, morph);
      gl.uniform4f(this.uColor, 1, 0.72, 0.3, 1);
      gl.drawArrays(gl.LINE_STRIP, 0, POINTS);
    }
    gl.bindVertexArray(null);
  }
};

// ../soundgineer/src/ui/keyboard.ts
var KEYMAP = {
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 12,
  KeyO: 13,
  KeyL: 14,
  KeyP: 15,
  Semicolon: 16
};
var WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];
var BLACK_OFFSETS = { 0: 1, 1: 3, 3: 6, 4: 8, 5: 10 };
var Keyboard = class {
  constructor(engine) {
    this.engine = engine;
    this.root = el("div", "keyboard-wrap");
    const octDown = el("button", "oct-btn", "\u2212");
    const octLabel = el("span", "oct-label", "C3\u2013C6");
    const octUp = el("button", "oct-btn", "+");
    const setOct = (o) => {
      this.octave = Math.max(0, Math.min(7, o));
      octLabel.textContent = `C${this.octave - 1}\u2013C${this.octave + 2}`;
    };
    octDown.addEventListener("click", () => setOct(this.octave - 1));
    octUp.addEventListener("click", () => setOct(this.octave + 1));
    const bar = el("div", "kb-bar");
    bar.append(octDown, octLabel, octUp, el("span", "kb-hint", "Play: A W S E D F T G Y H U J K \xB7 octave Z / X"));
    const keys = el("div", "keyboard");
    const startNote = 36;
    const numWhite = 3 * 7 + 1;
    for (let w = 0; w < numWhite; w++) {
      const oct = Math.floor(w / 7);
      const inOct = w % 7;
      const note = startNote + oct * 12 + WHITE_OFFSETS[inOct];
      const key = el("div", "key white");
      key.dataset.note = String(note);
      keys.appendChild(key);
      this.keyEls.set(note, key);
      if (w < numWhite - 1 && inOct in BLACK_OFFSETS) {
        const bn = startNote + oct * 12 + BLACK_OFFSETS[inOct];
        const bk = el("div", "key black");
        bk.dataset.note = String(bn);
        bk.style.left = `${(w + 1) / numWhite * 100}%`;
        keys.appendChild(bk);
        this.keyEls.set(bn, bk);
      }
    }
    keys.addEventListener("pointerdown", (e) => {
      const note = this.noteFromEvent(e);
      if (note < 0) return;
      keys.setPointerCapture(e.pointerId);
      this.pointerNotes.set(e.pointerId, note);
      engine.noteOn(note, e.pressure > 0 && e.pressure !== 0.5 ? e.pressure : 0.8);
    });
    keys.addEventListener("pointermove", (e) => {
      if (!this.pointerNotes.has(e.pointerId)) return;
      const note = this.noteFromEvent(e);
      const prev = this.pointerNotes.get(e.pointerId);
      if (note >= 0 && note !== prev) {
        engine.noteOff(prev);
        engine.noteOn(note, 0.8);
        this.pointerNotes.set(e.pointerId, note);
      }
    });
    const release = (e) => {
      const note = this.pointerNotes.get(e.pointerId);
      if (note !== void 0) {
        engine.noteOff(note);
        this.pointerNotes.delete(e.pointerId);
      }
    };
    keys.addEventListener("pointerup", release);
    keys.addEventListener("pointercancel", release);
    window.addEventListener("keydown", (e) => {
      if (e.repeat || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === "KeyZ") {
        setOct(this.octave - 1);
        return;
      }
      if (e.code === "KeyX") {
        setOct(this.octave + 1);
        return;
      }
      const off = KEYMAP[e.code];
      if (off === void 0) return;
      const note = (this.octave + 1) * 12 + off;
      if (this.keyboardNotes.has(e.code)) return;
      this.keyboardNotes.set(e.code, note);
      engine.noteOn(note, 0.8);
    });
    window.addEventListener("keyup", (e) => {
      const note = this.keyboardNotes.get(e.code);
      if (note !== void 0) {
        engine.noteOff(note);
        this.keyboardNotes.delete(e.code);
      }
    });
    engine.onNote((note, on) => {
      this.keyEls.get(note)?.classList.toggle("held", on);
    });
    this.root.append(bar, keys);
  }
  engine;
  root;
  octave = 4;
  // C4-based
  keyEls = /* @__PURE__ */ new Map();
  pointerNotes = /* @__PURE__ */ new Map();
  keyboardNotes = /* @__PURE__ */ new Map();
  noteFromEvent(e) {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const noteStr = target?.closest(".key")?.getAttribute("data-note");
    return noteStr ? Number(noteStr) : -1;
  }
};

// ../soundgineer/src/ui/presets.ts
var STORAGE_KEY = "soundgineer.presets.v1";
function P(raw) {
  const out = {};
  for (const [id, v] of Object.entries(raw)) out[id] = valueToNorm(paramDef(id), v);
  return out;
}
var FACTORY = [
  { name: "Init", params: {} },
  {
    name: "Deep Saw Bass",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 0,
      "osc1.morph": 0.7,
      "osc1.unison": 5,
      "osc1.detune": 9,
      "osc1.transpose": -12,
      "osc1.level": 0.8,
      "sub.enabled": 1,
      "sub.level": 0.7,
      "sub.octave": -1,
      "filter1.enabled": 1,
      "filter1.type": 1,
      "filter1.cutoff": 300,
      "filter1.resonance": 0.35,
      "filter1.drive": 0.3,
      "env1.attack": 3e-3,
      "env1.decay": 0.4,
      "env1.sustain": 0.9,
      "env1.release": 0.12,
      "env2.attack": 3e-3,
      "env2.decay": 0.35,
      "env2.sustain": 0.15,
      "env2.release": 0.1,
      "dist.type": 1,
      "dist.drive": 0.25
    }),
    mods: [{ source: "env2", dest: "filter1.cutoff", depth: 0.45, enabled: true }]
  },
  {
    name: "Morphing Pad",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 3,
      "osc1.unison": 7,
      "osc1.detune": 16,
      "osc1.spread": 0.9,
      "osc1.level": 0.55,
      "osc2.enabled": 1,
      "osc2.wavetable": 1,
      "osc2.unison": 5,
      "osc2.detune": 12,
      "osc2.transpose": 12,
      "osc2.level": 0.3,
      "filter1.enabled": 1,
      "filter1.type": 0,
      "filter1.cutoff": 2200,
      "filter1.resonance": 0.15,
      "env1.attack": 0.9,
      "env1.decay": 1.5,
      "env1.sustain": 0.8,
      "env1.release": 1.8,
      "lfo1.rate": 0.12,
      "lfo1.sync": 0,
      "chorus.enabled": 1,
      "chorus.mix": 0.4,
      "reverb.enabled": 1,
      "reverb.size": 0.85,
      "reverb.mix": 0.35
    }),
    mods: [
      { source: "lfo1", dest: "osc1.morph", depth: 0.6, enabled: true },
      { source: "lfo2", dest: "osc2.morph", depth: 0.3, enabled: true }
    ]
  },
  {
    name: "Sync Pluck",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 0,
      "osc1.morph": 0.55,
      "osc1.sync": 1,
      "filter1.enabled": 1,
      "filter1.type": 1,
      "filter1.cutoff": 900,
      "filter1.resonance": 0.3,
      "filter1.keytrack": 1,
      "env1.attack": 2e-3,
      "env1.decay": 0.5,
      "env1.sustain": 0,
      "env1.release": 0.4,
      "env2.attack": 1e-3,
      "env2.decay": 0.25,
      "env2.sustain": 0,
      "env2.release": 0.2,
      "delay.enabled": 1,
      "delay.mix": 0.25,
      "delay.feedback": 0.35,
      "reverb.enabled": 1,
      "reverb.mix": 0.2
    }),
    mods: [
      { source: "env2", dest: "filter1.cutoff", depth: 0.5, enabled: true },
      { source: "env2", dest: "osc1.sync", depth: 0.5, enabled: true },
      { source: "velocity", dest: "filter1.cutoff", depth: 0.25, enabled: true }
    ]
  },
  {
    name: "PWM Keys",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 2,
      "osc1.morph": 0.3,
      "osc1.unison": 3,
      "osc1.detune": 6,
      "filter1.enabled": 1,
      "filter1.type": 0,
      "filter1.cutoff": 5e3,
      "env1.attack": 0.01,
      "env1.decay": 0.8,
      "env1.sustain": 0.6,
      "env1.release": 0.5,
      "lfo1.rate": 0.6,
      "lfo1.sync": 0,
      "chorus.enabled": 1,
      "chorus.mix": 0.35,
      "eq.enabled": 1,
      "eq.high_gain": 2
    }),
    mods: [
      { source: "lfo1", dest: "osc1.morph", depth: 0.35, enabled: true },
      { source: "modwheel", dest: "osc1.morph", depth: 0.5, enabled: true }
    ]
  },
  // ------------------------------------------------------------------ bass
  {
    name: "Reese Bass",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 0,
      "osc1.morph": 0.7,
      "osc1.unison": 2,
      "osc1.detune": 35,
      "osc1.blend": 1,
      "osc1.spread": 0,
      "osc1.transpose": -12,
      "osc1.level": 0.6,
      "osc2.enabled": 1,
      "osc2.wavetable": 0,
      "osc2.morph": 0.7,
      "osc2.transpose": -12,
      "osc2.fine": 12,
      "osc2.level": 0.5,
      "filter1.enabled": 1,
      "filter1.type": 1,
      "filter1.cutoff": 700,
      "filter1.resonance": 0.1,
      "filter1.drive": 0.4,
      "env1.attack": 3e-3,
      "env1.decay": 0.5,
      "env1.sustain": 1,
      "env1.release": 0.15,
      "dist.type": 1,
      "dist.drive": 0.3,
      "eq.enabled": 1,
      "eq.low_gain": 2
    }),
    mods: [{ source: "modwheel", dest: "filter1.cutoff", depth: 0.3, enabled: true }]
  },
  {
    name: "Acid Squelch",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 0,
      "osc1.morph": 0.7,
      "osc1.transpose": -12,
      "osc1.level": 0.75,
      "filter1.enabled": 1,
      "filter1.type": 1,
      "filter1.cutoff": 350,
      "filter1.resonance": 0.75,
      "filter1.drive": 0.5,
      "filter1.keytrack": 0.5,
      "env1.attack": 2e-3,
      "env1.decay": 0.3,
      "env1.sustain": 0.6,
      "env1.release": 0.08,
      "env2.attack": 1e-3,
      "env2.decay": 0.18,
      "env2.sustain": 0,
      "env2.release": 0.1,
      "dist.type": 1,
      "dist.drive": 0.35,
      "delay.enabled": 1,
      "delay.division": 7,
      "delay.mix": 0.18,
      "delay.feedback": 0.3
    }),
    mods: [
      { source: "env2", dest: "filter1.cutoff", depth: 0.4, enabled: true },
      { source: "velocity", dest: "filter1.cutoff", depth: 0.2, enabled: true },
      { source: "modwheel", dest: "filter1.resonance", depth: 0.3, enabled: true }
    ]
  },
  {
    name: "Wobble Bass",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 5,
      "osc1.morph": 0.4,
      "osc1.transpose": -12,
      "osc1.level": 0.8,
      "sub.enabled": 1,
      "sub.shape": 0,
      "sub.octave": -1,
      "sub.level": 0.6,
      "filter1.enabled": 1,
      "filter1.type": 1,
      "filter1.cutoff": 400,
      "filter1.resonance": 0.4,
      "filter1.drive": 0.3,
      "env1.attack": 2e-3,
      "env1.decay": 0.4,
      "env1.sustain": 1,
      "env1.release": 0.1,
      "lfo1.sync": 1,
      "lfo1.division": 4,
      "dist.type": 1,
      "dist.drive": 0.3
    }),
    mods: [
      { source: "lfo1", dest: "filter1.cutoff", depth: 0.5, enabled: true },
      { source: "lfo1", dest: "osc1.morph", depth: 0.3, enabled: true }
    ]
  },
  {
    name: "FM Knock",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 4,
      "osc1.morph": 0.25,
      "osc1.transpose": -12,
      "osc1.level": 0.8,
      "sub.enabled": 1,
      "sub.shape": 0,
      "sub.octave": -1,
      "sub.level": 0.7,
      "filter1.enabled": 1,
      "filter1.type": 0,
      "filter1.cutoff": 1200,
      "env1.attack": 1e-3,
      "env1.decay": 0.35,
      "env1.sustain": 0,
      "env1.release": 0.2,
      "env2.attack": 1e-3,
      "env2.decay": 0.08,
      "env2.sustain": 0,
      "env2.release": 0.05
    }),
    mods: [
      { source: "env2", dest: "osc1.morph", depth: 0.5, enabled: true },
      { source: "env2", dest: "osc1.transpose", depth: 0.15, enabled: true },
      { source: "velocity", dest: "osc1.morph", depth: 0.3, enabled: true }
    ]
  },
  {
    name: "Solid Square",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 2,
      "osc1.morph": 0.15,
      "osc1.transpose": -12,
      "osc1.level": 0.55,
      "sub.enabled": 1,
      "sub.shape": 0,
      "sub.octave": -1,
      "sub.level": 0.65,
      "filter1.enabled": 1,
      "filter1.type": 0,
      "filter1.cutoff": 2500,
      "env1.attack": 3e-3,
      "env1.decay": 0.4,
      "env1.sustain": 0.9,
      "env1.release": 0.12,
      "eq.enabled": 1,
      "eq.low_gain": 3
    }),
    mods: [{ source: "modwheel", dest: "osc1.morph", depth: 0.4, enabled: true }]
  },
  {
    name: "Neuro Growl",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 3,
      "osc1.morph": 0.3,
      "osc1.transpose": -12,
      "osc1.level": 0.8,
      "osc2.enabled": 1,
      "osc2.wavetable": 5,
      "osc2.morph": 0.5,
      "osc2.transpose": -12,
      "osc2.level": 0.5,
      "filter1.enabled": 1,
      "filter1.type": 8,
      "filter1.cutoff": 800,
      "filter1.resonance": 0.5,
      "filter1.mix": 0.8,
      "filter2.enabled": 1,
      "filter2.type": 1,
      "filter2.cutoff": 900,
      "filter2.resonance": 0.2,
      "env1.attack": 2e-3,
      "env1.decay": 0.4,
      "env1.sustain": 1,
      "env1.release": 0.1,
      "lfo1.sync": 1,
      "lfo1.division": 1,
      "lfo2.sync": 1,
      "lfo2.division": 7,
      "dist.type": 3,
      "dist.drive": 0.35,
      "dist.mix": 0.7
    }),
    mods: [
      { source: "lfo1", dest: "filter1.cutoff", depth: 0.45, enabled: true },
      { source: "lfo1", dest: "osc1.morph", depth: 0.5, enabled: true },
      { source: "lfo2", dest: "osc2.morph", depth: 0.25, enabled: true }
    ]
  },
  {
    name: "808 Drop",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 0,
      "osc1.morph": 0,
      "osc1.transpose": -12,
      "osc1.level": 0.9,
      "env1.attack": 1e-3,
      "env1.decay": 1.2,
      "env1.sustain": 0.4,
      "env1.release": 0.3,
      "env2.attack": 1e-3,
      "env2.decay": 0.09,
      "env2.sustain": 0,
      "env2.release": 0.05,
      "dist.type": 1,
      "dist.drive": 0.2
    }),
    mods: [
      { source: "env2", dest: "osc1.transpose", depth: 0.25, enabled: true },
      { source: "velocity", dest: "dist.drive", depth: 0.2, enabled: true }
    ]
  },
  // ------------------------------------------------------------------ leads
  {
    name: "Super Saw Lead",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 0,
      "osc1.morph": 0.7,
      "osc1.unison": 7,
      "osc1.detune": 20,
      "osc1.spread": 1,
      "osc1.blend": 0.8,
      "osc1.level": 0.6,
      "osc2.enabled": 1,
      "osc2.wavetable": 0,
      "osc2.morph": 0.7,
      "osc2.unison": 7,
      "osc2.detune": 25,
      "osc2.transpose": 12,
      "osc2.spread": 1,
      "osc2.level": 0.35,
      "filter1.enabled": 1,
      "filter1.type": 0,
      "filter1.cutoff": 9e3,
      "env1.attack": 5e-3,
      "env1.decay": 0.5,
      "env1.sustain": 0.85,
      "env1.release": 0.3,
      "lfo1.sync": 0,
      "lfo1.rate": 5.5,
      "delay.enabled": 1,
      "delay.division": 7,
      "delay.mix": 0.2,
      "reverb.enabled": 1,
      "reverb.size": 0.6,
      "reverb.mix": 0.2,
      "eq.enabled": 1,
      "eq.high_gain": 2
    }),
    mods: [
      { source: "lfo1", dest: "osc1.fine", depth: 0.03, enabled: true },
      { source: "lfo1", dest: "osc2.fine", depth: 0.03, enabled: true }
    ]
  },
  {
    name: "Sync Screamer",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 1,
      "osc1.morph": 0.4,
      "osc1.level": 0.75,
      "filter1.enabled": 1,
      "filter1.type": 1,
      "filter1.cutoff": 3500,
      "filter1.resonance": 0.25,
      "filter1.drive": 0.5,
      "env1.attack": 2e-3,
      "env1.decay": 0.4,
      "env1.sustain": 1,
      "env1.release": 0.25,
      "env2.attack": 1e-3,
      "env2.decay": 0.6,
      "env2.sustain": 0.3,
      "env2.release": 0.3,
      "lfo1.sync": 0,
      "lfo1.rate": 6,
      "dist.type": 2,
      "dist.drive": 0.25,
      "delay.enabled": 1,
      "delay.division": 7,
      "delay.mix": 0.22
    }),
    mods: [
      { source: "env2", dest: "osc1.sync", depth: 0.6, enabled: true },
      { source: "modwheel", dest: "osc1.sync", depth: 0.4, enabled: true },
      { source: "lfo1", dest: "osc1.fine", depth: 0.04, enabled: true }
    ]
  },
  {
    name: "Breath Flute",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 0,
      "osc1.morph": 0.05,
      "osc1.level": 0.6,
      "noise.enabled": 1,
      "noise.type": 1,
      "noise.level": 0.15,
      "filter1.enabled": 1,
      "filter1.type": 0,
      "filter1.cutoff": 4e3,
      "filter1.keytrack": 0.6,
      "env1.attack": 0.06,
      "env1.decay": 0.4,
      "env1.sustain": 0.85,
      "env1.release": 0.25,
      "lfo1.sync": 0,
      "lfo1.rate": 5,
      "reverb.enabled": 1,
      "reverb.mix": 0.25
    }),
    mods: [
      { source: "lfo1", dest: "osc1.fine", depth: 0.035, enabled: true },
      { source: "lfo1", dest: "osc1.level", depth: 0.08, enabled: true },
      { source: "aftertouch", dest: "osc1.level", depth: 0.1, enabled: true }
    ]
  },
  {
    name: "Chip Lead",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 2,
      "osc1.morph": 0,
      "osc1.phase_rand": 0,
      "osc1.level": 0.65,
      "filter1.enabled": 1,
      "filter1.type": 0,
      "filter1.cutoff": 12e3,
      "env1.attack": 1e-3,
      "env1.decay": 0.3,
      "env1.sustain": 1,
      "env1.release": 0.05,
      "lfo1.sync": 0,
      "lfo1.rate": 6.5,
      "dist.type": 4,
      "dist.bits": 6,
      "dist.downsample": 6,
      "dist.mix": 0.8,
      "delay.enabled": 1,
      "delay.division": 7,
      "delay.mix": 0.25,
      "delay.feedback": 0.25
    }),
    mods: [{ source: "lfo1", dest: "osc1.fine", depth: 0.04, enabled: true }]
  },
  {
    name: "Vox Lead",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 3,
      "osc1.morph": 0.4,
      "osc1.unison": 3,
      "osc1.detune": 8,
      "osc1.level": 0.7,
      "filter1.enabled": 1,
      "filter1.type": 8,
      "filter1.cutoff": 1200,
      "filter1.resonance": 0.4,
      "filter1.mix": 0.9,
      "env1.attack": 0.02,
      "env1.decay": 0.5,
      "env1.sustain": 0.9,
      "env1.release": 0.3,
      "lfo1.sync": 0,
      "lfo1.rate": 0.4,
      "lfo2.sync": 0,
      "lfo2.rate": 5.2,
      "chorus.enabled": 1,
      "chorus.mix": 0.3,
      "reverb.enabled": 1,
      "reverb.mix": 0.25
    }),
    mods: [
      { source: "modwheel", dest: "osc1.morph", depth: 0.5, enabled: true },
      { source: "lfo1", dest: "filter1.cutoff", depth: 0.15, enabled: true },
      { source: "lfo2", dest: "osc1.fine", depth: 0.03, enabled: true }
    ]
  },
  {
    name: "Crystal Bell",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 4,
      "osc1.morph": 0.25,
      "osc1.level": 0.65,
      "osc2.enabled": 1,
      "osc2.wavetable": 4,
      "osc2.morph": 0.7,
      "osc2.transpose": 12,
      "osc2.level": 0.3,
      "filter1.enabled": 1,
      "filter1.type": 0,
      "filter1.cutoff": 9e3,
      "env1.attack": 2e-3,
      "env1.decay": 1.8,
      "env1.sustain": 0,
      "env1.release": 1.2,
      "env2.attack": 1e-3,
      "env2.decay": 1.2,
      "env2.sustain": 0,
      "env2.release": 0.8,
      "delay.enabled": 1,
      "delay.division": 6,
      "delay.pingpong": 1,
      "delay.mix": 0.3,
      "reverb.enabled": 1,
      "reverb.size": 0.8,
      "reverb.mix": 0.35
    }),
    mods: [
      { source: "env2", dest: "osc1.morph", depth: 0.35, enabled: true },
      { source: "velocity", dest: "osc1.morph", depth: 0.2, enabled: true }
    ]
  },
  // ------------------------------------------------------------------ pads
  {
    name: "Warm Analog Pad",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 0,
      "osc1.morph": 0.65,
      "osc1.unison": 5,
      "osc1.detune": 10,
      "osc1.blend": 0.8,
      "osc1.level": 0.55,
      "osc2.enabled": 1,
      "osc2.wavetable": 0,
      "osc2.morph": 0.65,
      "osc2.unison": 3,
      "osc2.detune": 7,
      "osc2.transpose": -12,
      "osc2.level": 0.4,
      "filter1.enabled": 1,
      "filter1.type": 0,
      "filter1.cutoff": 1800,
      "filter1.resonance": 0.1,
      "env1.attack": 1.2,
      "env1.decay": 2,
      "env1.sustain": 0.8,
      "env1.release": 2.2,
      "lfo1.sync": 0,
      "lfo1.rate": 0.07,
      "lfo1.mode": 1,
      "chorus.enabled": 1,
      "chorus.mix": 0.4,
      "reverb.enabled": 1,
      "reverb.size": 0.7,
      "reverb.mix": 0.3
    }),
    mods: [{ source: "lfo1", dest: "filter1.cutoff", depth: 0.12, enabled: true }]
  },
  {
    name: "Choir Pad",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 3,
      "osc1.morph": 0.55,
      "osc1.unison": 5,
      "osc1.detune": 9,
      "osc1.spread": 0.8,
      "osc1.level": 0.6,
      "filter1.enabled": 1,
      "filter1.type": 8,
      "filter1.cutoff": 900,
      "filter1.resonance": 0.35,
      "filter1.mix": 0.85,
      "env1.attack": 0.8,
      "env1.decay": 1.5,
      "env1.sustain": 0.85,
      "env1.release": 1.6,
      "lfo1.sync": 0,
      "lfo1.rate": 0.09,
      "lfo1.mode": 1,
      "lfo2.sync": 0,
      "lfo2.rate": 0.13,
      "lfo2.mode": 1,
      "chorus.enabled": 1,
      "chorus.mix": 0.3,
      "reverb.enabled": 1,
      "reverb.size": 0.85,
      "reverb.mix": 0.4
    }),
    mods: [
      { source: "lfo1", dest: "osc1.morph", depth: 0.3, enabled: true },
      { source: "lfo2", dest: "filter1.cutoff", depth: 0.15, enabled: true }
    ]
  },
  {
    name: "Shimmer Pad",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 1,
      "osc1.morph": 0.3,
      "osc1.unison": 5,
      "osc1.detune": 12,
      "osc1.level": 0.5,
      "osc2.enabled": 1,
      "osc2.wavetable": 1,
      "osc2.morph": 0.5,
      "osc2.unison": 3,
      "osc2.detune": 10,
      "osc2.transpose": 19,
      "osc2.level": 0.25,
      "filter1.enabled": 1,
      "filter1.type": 0,
      "filter1.cutoff": 6e3,
      "env1.attack": 1.5,
      "env1.decay": 2,
      "env1.sustain": 0.8,
      "env1.release": 3,
      "lfo1.sync": 0,
      "lfo1.rate": 0.06,
      "lfo1.mode": 1,
      "lfo2.sync": 0,
      "lfo2.rate": 0.08,
      "lfo2.mode": 1,
      "delay.enabled": 1,
      "delay.division": 3,
      "delay.mix": 0.25,
      "reverb.enabled": 1,
      "reverb.size": 0.95,
      "reverb.damp": 0.2,
      "reverb.mix": 0.5
    }),
    mods: [
      { source: "lfo1", dest: "osc1.morph", depth: 0.4, enabled: true },
      { source: "lfo2", dest: "osc2.morph", depth: 0.35, enabled: true }
    ]
  },
  {
    name: "Dark Matter",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 5,
      "osc1.morph": 0.2,
      "osc1.unison": 3,
      "osc1.detune": 8,
      "osc1.transpose": -12,
      "osc1.level": 0.55,
      "sub.enabled": 1,
      "sub.shape": 1,
      "sub.octave": -1,
      "sub.level": 0.4,
      "filter1.enabled": 1,
      "filter1.type": 1,
      "filter1.cutoff": 700,
      "filter1.resonance": 0.3,
      "filter1.drive": 0.2,
      "env1.attack": 2,
      "env1.decay": 2,
      "env1.sustain": 0.85,
      "env1.release": 3,
      "lfo1.sync": 0,
      "lfo1.rate": 0.05,
      "lfo1.mode": 1,
      "phaser.enabled": 1,
      "phaser.rate": 0.08,
      "phaser.mix": 0.3,
      "reverb.enabled": 1,
      "reverb.size": 0.9,
      "reverb.damp": 0.7,
      "reverb.mix": 0.4
    }),
    mods: [
      { source: "lfo1", dest: "filter1.cutoff", depth: 0.18, enabled: true },
      { source: "lfo1", dest: "osc1.morph", depth: 0.15, enabled: true }
    ]
  },
  {
    name: "Glass Pad",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 4,
      "osc1.morph": 0.35,
      "osc1.unison": 4,
      "osc1.detune": 6,
      "osc1.level": 0.5,
      "osc2.enabled": 1,
      "osc2.wavetable": 0,
      "osc2.morph": 0,
      "osc2.transpose": 12,
      "osc2.level": 0.3,
      "filter1.enabled": 1,
      "filter1.type": 4,
      "filter1.cutoff": 2500,
      "filter1.resonance": 0.2,
      "filter1.mix": 0.7,
      "env1.attack": 0.9,
      "env1.decay": 1.5,
      "env1.sustain": 0.8,
      "env1.release": 2,
      "lfo1.sync": 0,
      "lfo1.rate": 0.1,
      "lfo1.mode": 1,
      "chorus.enabled": 1,
      "chorus.mix": 0.45,
      "reverb.enabled": 1,
      "reverb.mix": 0.35
    }),
    mods: [
      { source: "lfo1", dest: "osc1.morph", depth: 0.3, enabled: true },
      { source: "keytrack", dest: "filter1.cutoff", depth: 0.2, enabled: true }
    ]
  },
  {
    name: "Aurora Texture",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 1,
      "osc1.morph": 0.2,
      "osc1.unison": 3,
      "osc1.spread": 1,
      "osc1.level": 0.45,
      "osc2.enabled": 1,
      "osc2.wavetable": 3,
      "osc2.morph": 0.6,
      "osc2.fine": 8,
      "osc2.level": 0.4,
      "osc3.enabled": 1,
      "osc3.wavetable": 5,
      "osc3.morph": 0.5,
      "osc3.transpose": 12,
      "osc3.level": 0.2,
      "filter.routing": 1,
      "filter1.enabled": 1,
      "filter1.type": 0,
      "filter1.cutoff": 3e3,
      "filter2.enabled": 1,
      "filter2.type": 4,
      "filter2.cutoff": 1200,
      "filter2.resonance": 0.4,
      "env1.attack": 2.5,
      "env1.decay": 2,
      "env1.sustain": 0.9,
      "env1.release": 4,
      "lfo1.sync": 0,
      "lfo1.rate": 0.04,
      "lfo1.mode": 1,
      "lfo2.sync": 0,
      "lfo2.rate": 0.07,
      "lfo2.mode": 1,
      "lfo3.sync": 0,
      "lfo3.rate": 0.05,
      "lfo3.mode": 1,
      "lfo4.sync": 0,
      "lfo4.rate": 0.03,
      "lfo4.mode": 1,
      "phaser.enabled": 1,
      "phaser.rate": 0.3,
      "phaser.mix": 0.4,
      "reverb.enabled": 1,
      "reverb.size": 0.9,
      "reverb.mix": 0.5
    }),
    mods: [
      { source: "lfo1", dest: "osc1.morph", depth: 0.5, enabled: true },
      { source: "lfo2", dest: "osc2.morph", depth: 0.4, enabled: true },
      { source: "lfo3", dest: "osc3.morph", depth: 0.5, enabled: true },
      { source: "lfo4", dest: "filter2.cutoff", depth: 0.25, enabled: true }
    ]
  },
  // ------------------------------------------------------------------ keys
  {
    name: "Lo-Fi EP",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 4,
      "osc1.morph": 0.25,
      "osc1.level": 0.7,
      "filter1.enabled": 1,
      "filter1.type": 0,
      "filter1.cutoff": 5e3,
      "filter1.keytrack": 0.4,
      "env1.attack": 2e-3,
      "env1.decay": 1.5,
      "env1.sustain": 0.35,
      "env1.release": 0.4,
      "lfo1.sync": 0,
      "lfo1.rate": 4.5,
      "lfo1.mode": 1,
      "dist.type": 4,
      "dist.bits": 10,
      "dist.downsample": 2,
      "dist.mix": 0.5,
      "chorus.enabled": 1,
      "chorus.mix": 0.35,
      "reverb.enabled": 1,
      "reverb.mix": 0.18
    }),
    mods: [
      { source: "velocity", dest: "filter1.cutoff", depth: 0.25, enabled: true },
      { source: "velocity", dest: "osc1.morph", depth: 0.15, enabled: true },
      { source: "lfo1", dest: "osc1.pan", depth: 0.25, enabled: true }
    ]
  },
  {
    name: "Drawbar Organ",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 0,
      "osc1.morph": 0,
      "osc1.level": 0.5,
      "osc2.enabled": 1,
      "osc2.wavetable": 0,
      "osc2.morph": 0,
      "osc2.transpose": 12,
      "osc2.level": 0.35,
      "osc3.enabled": 1,
      "osc3.wavetable": 0,
      "osc3.morph": 0,
      "osc3.transpose": 19,
      "osc3.level": 0.25,
      "sub.enabled": 1,
      "sub.shape": 0,
      "sub.octave": -1,
      "sub.level": 0.4,
      "filter1.enabled": 1,
      "filter1.type": 0,
      "filter1.cutoff": 1e4,
      "env1.attack": 3e-3,
      "env1.decay": 0.1,
      "env1.sustain": 1,
      "env1.release": 0.05,
      "chorus.enabled": 1,
      "chorus.rate": 0.8,
      "chorus.depth": 0.7,
      "chorus.mix": 0.5
    }),
    mods: [{ source: "modwheel", dest: "chorus.rate", depth: 0.3, enabled: true }]
  },
  {
    name: "Funk Clav",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 0,
      "osc1.morph": 0.75,
      "osc1.level": 0.7,
      "filter1.enabled": 1,
      "filter1.type": 7,
      "filter1.cutoff": 2e3,
      "filter1.resonance": 0.6,
      "filter2.enabled": 1,
      "filter2.type": 0,
      "filter2.cutoff": 4e3,
      "filter2.keytrack": 0.5,
      "env1.attack": 1e-3,
      "env1.decay": 0.8,
      "env1.sustain": 0.2,
      "env1.release": 0.08,
      "env2.attack": 1e-3,
      "env2.decay": 0.12,
      "env2.sustain": 0,
      "env2.release": 0.05
    }),
    mods: [
      { source: "env2", dest: "filter2.cutoff", depth: 0.3, enabled: true },
      { source: "velocity", dest: "filter2.cutoff", depth: 0.25, enabled: true }
    ]
  },
  {
    name: "Rave Stab",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 0,
      "osc1.morph": 0.7,
      "osc1.unison": 5,
      "osc1.detune": 15,
      "osc1.level": 0.6,
      "osc2.enabled": 1,
      "osc2.wavetable": 0,
      "osc2.morph": 0.7,
      "osc2.unison": 3,
      "osc2.detune": 12,
      "osc2.transpose": 12,
      "osc2.level": 0.4,
      "filter1.enabled": 1,
      "filter1.type": 0,
      "filter1.cutoff": 4500,
      "filter1.resonance": 0.15,
      "env1.attack": 2e-3,
      "env1.decay": 0.4,
      "env1.sustain": 0,
      "env1.release": 0.25,
      "env2.attack": 1e-3,
      "env2.decay": 0.2,
      "env2.sustain": 0,
      "env2.release": 0.1,
      "dist.type": 1,
      "dist.drive": 0.2,
      "reverb.enabled": 1,
      "reverb.mix": 0.2
    }),
    mods: [
      { source: "velocity", dest: "filter1.cutoff", depth: 0.3, enabled: true },
      { source: "env2", dest: "filter1.cutoff", depth: 0.25, enabled: true }
    ]
  },
  // ------------------------------------------------------------------ plucks
  {
    name: "Ice Pluck",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 5,
      "osc1.morph": 0.7,
      "osc1.level": 0.65,
      "filter1.enabled": 1,
      "filter1.type": 1,
      "filter1.cutoff": 1500,
      "filter1.resonance": 0.2,
      "filter1.keytrack": 0.8,
      "env1.attack": 1e-3,
      "env1.decay": 0.35,
      "env1.sustain": 0,
      "env1.release": 0.5,
      "env2.attack": 1e-3,
      "env2.decay": 0.15,
      "env2.sustain": 0,
      "env2.release": 0.1,
      "delay.enabled": 1,
      "delay.division": 6,
      "delay.pingpong": 1,
      "delay.mix": 0.3,
      "delay.feedback": 0.4,
      "reverb.enabled": 1,
      "reverb.size": 0.8,
      "reverb.mix": 0.3
    }),
    mods: [
      { source: "env2", dest: "filter1.cutoff", depth: 0.45, enabled: true },
      { source: "velocity", dest: "filter1.cutoff", depth: 0.2, enabled: true },
      { source: "random", dest: "osc1.morph", depth: 0.15, enabled: true }
    ]
  },
  {
    name: "Kalimba",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 0,
      "osc1.morph": 0.02,
      "osc1.level": 0.7,
      "noise.enabled": 1,
      "noise.type": 0,
      "noise.level": 0.08,
      "filter1.enabled": 1,
      "filter1.type": 0,
      "filter1.cutoff": 3e3,
      "filter1.keytrack": 0.7,
      "env1.attack": 1e-3,
      "env1.decay": 0.5,
      "env1.sustain": 0,
      "env1.release": 0.4,
      "env2.attack": 1e-3,
      "env2.decay": 0.05,
      "env2.sustain": 0,
      "env2.release": 0.03,
      "reverb.enabled": 1,
      "reverb.size": 0.5,
      "reverb.mix": 0.25
    }),
    mods: [
      { source: "env2", dest: "filter1.cutoff", depth: 0.3, enabled: true },
      { source: "velocity", dest: "filter1.cutoff", depth: 0.2, enabled: true }
    ]
  },
  {
    name: "Rubber Pluck",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 0,
      "osc1.morph": 0.5,
      "osc1.level": 0.7,
      "filter1.enabled": 1,
      "filter1.type": 1,
      "filter1.cutoff": 900,
      "filter1.resonance": 0.35,
      "env1.attack": 1e-3,
      "env1.decay": 0.4,
      "env1.sustain": 0,
      "env1.release": 0.3,
      "env2.attack": 1e-3,
      "env2.decay": 0.1,
      "env2.sustain": 0,
      "env2.release": 0.05,
      "dist.type": 3,
      "dist.drive": 0.45,
      "dist.mix": 0.8
    }),
    mods: [
      { source: "env2", dest: "filter1.cutoff", depth: 0.35, enabled: true },
      { source: "env2", dest: "dist.drive", depth: 0.25, enabled: true },
      { source: "velocity", dest: "filter1.cutoff", depth: 0.25, enabled: true }
    ]
  },
  {
    name: "Arp Nights",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 2,
      "osc1.morph": 0.4,
      "osc1.unison": 2,
      "osc1.detune": 12,
      "osc1.level": 0.6,
      "filter1.enabled": 1,
      "filter1.type": 1,
      "filter1.cutoff": 2200,
      "filter1.resonance": 0.3,
      "filter1.keytrack": 0.4,
      "env1.attack": 1e-3,
      "env1.decay": 0.28,
      "env1.sustain": 0,
      "env1.release": 0.2,
      "env2.attack": 1e-3,
      "env2.decay": 0.12,
      "env2.sustain": 0,
      "env2.release": 0.08,
      "lfo1.sync": 1,
      "lfo1.division": 7,
      "delay.enabled": 1,
      "delay.division": 10,
      "delay.pingpong": 1,
      "delay.mix": 0.35,
      "delay.feedback": 0.45,
      "reverb.enabled": 1,
      "reverb.mix": 0.25
    }),
    mods: [
      { source: "env2", dest: "filter1.cutoff", depth: 0.4, enabled: true },
      { source: "lfo1", dest: "osc1.morph", depth: 0.2, enabled: true },
      { source: "modwheel", dest: "filter1.cutoff", depth: 0.3, enabled: true }
    ]
  },
  // ------------------------------------------------------------------ fx / other
  {
    name: "Tension Riser",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 1,
      "osc1.morph": 0.1,
      "osc1.unison": 7,
      "osc1.detune": 30,
      "osc1.spread": 1,
      "osc1.level": 0.5,
      "noise.enabled": 1,
      "noise.type": 0,
      "noise.level": 0.35,
      "filter1.enabled": 1,
      "filter1.type": 2,
      "filter1.cutoff": 200,
      "env1.attack": 4,
      "env1.decay": 1,
      "env1.sustain": 1,
      "env1.release": 1.5,
      "env2.attack": 5,
      "env2.decay": 1,
      "env2.sustain": 1,
      "env2.release": 1,
      "lfo1.sync": 0,
      "lfo1.rate": 8,
      "reverb.enabled": 1,
      "reverb.size": 0.9,
      "reverb.mix": 0.4
    }),
    mods: [
      { source: "env2", dest: "osc1.transpose", depth: 0.12, enabled: true },
      { source: "env2", dest: "filter1.cutoff", depth: 0.3, enabled: true },
      { source: "env2", dest: "osc1.morph", depth: 0.6, enabled: true },
      { source: "lfo1", dest: "osc1.fine", depth: 0.05, enabled: true }
    ]
  },
  {
    name: "Ocean Drift",
    params: P({
      "osc1.enabled": 0,
      "noise.enabled": 1,
      "noise.type": 1,
      "noise.level": 0.6,
      "filter1.enabled": 1,
      "filter1.type": 4,
      "filter1.cutoff": 800,
      "filter1.resonance": 0.5,
      "env1.attack": 1.5,
      "env1.decay": 1,
      "env1.sustain": 1,
      "env1.release": 2.5,
      "lfo1.sync": 0,
      "lfo1.rate": 0.06,
      "lfo1.mode": 1,
      "lfo2.sync": 0,
      "lfo2.rate": 0.11,
      "lfo2.mode": 1,
      "reverb.enabled": 1,
      "reverb.size": 0.9,
      "reverb.mix": 0.45
    }),
    mods: [
      { source: "lfo1", dest: "filter1.cutoff", depth: 0.3, enabled: true },
      { source: "lfo2", dest: "noise.level", depth: 0.2, enabled: true },
      { source: "lfo2", dest: "filter1.resonance", depth: 0.15, enabled: true }
    ]
  },
  {
    name: "Laser Zap",
    params: P({
      "osc1.enabled": 1,
      "osc1.wavetable": 0,
      "osc1.morph": 0,
      "osc1.transpose": 24,
      "osc1.level": 0.7,
      "env1.attack": 1e-3,
      "env1.decay": 0.25,
      "env1.sustain": 0,
      "env1.release": 0.1,
      "env2.attack": 1e-3,
      "env2.decay": 0.18,
      "env2.sustain": 0,
      "env2.release": 0.05,
      "delay.enabled": 1,
      "delay.division": 7,
      "delay.mix": 0.2,
      "delay.feedback": 0.3
    }),
    mods: [{ source: "env2", dest: "osc1.transpose", depth: 0.35, enabled: true }]
  }
];
function readAll() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function scopeOf(engine) {
  const s = engine?.__sgrScope;
  return typeof s === "string" && s ? s : "default";
}
function loadUserPresets(scope) {
  const all = readAll();
  return scope == null ? all : all.filter((p2) => (p2.scope ?? "default") === scope);
}
function saveUserPresets(list, scope) {
  const keep = readAll().filter((p2) => !((p2.scope ?? "default") === scope && list.some((n) => n.name === p2.name)));
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...keep, ...list]));
}
var PresetBrowser = class {
  constructor(engine) {
    this.engine = engine;
    this.root = el("div", "presets");
    this.select = el("select", "param-select preset-select");
    this.select.addEventListener("change", () => this.load(this.select.value));
    const save = el("button", "hdr-btn", "SAVE");
    save.title = "Save current patch to the browser";
    save.addEventListener("click", () => {
      const name = prompt("Preset name?", "My Patch");
      if (!name) return;
      const scope = scopeOf(this.engine);
      const list = loadUserPresets(scope).filter((p2) => p2.name !== name);
      list.push({ ...this.engine.toPreset(name), scope });
      saveUserPresets(list, scope);
      this.refresh(`user:${name}`);
    });
    const exportBtn = el("button", "hdr-btn", "EXPORT");
    exportBtn.title = "Download patch as JSON";
    exportBtn.addEventListener("click", () => {
      const preset = this.engine.toPreset("Exported Patch");
      const blob = new Blob([JSON.stringify(preset, null, 2)], { type: "application/json" });
      const a = el("a");
      a.href = URL.createObjectURL(blob);
      a.download = "patch.soundgineer.json";
      a.click();
      URL.revokeObjectURL(a.href);
    });
    const importBtn = el("button", "hdr-btn", "IMPORT");
    const file = el("input");
    file.type = "file";
    file.accept = ".json";
    file.style.display = "none";
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        const preset = JSON.parse(await f.text());
        this.engine.loadPreset(preset);
        const scope = scopeOf(this.engine);
        const list = loadUserPresets(scope).filter((p2) => p2.name !== preset.name);
        list.push({ ...preset, scope });
        saveUserPresets(list, scope);
        this.refresh(`user:${preset.name}`);
      } catch (err) {
        alert(`Could not load preset: ${err}`);
      }
      file.value = "";
    });
    importBtn.addEventListener("click", () => file.click());
    this.root.append(this.select, save, exportBtn, importBtn, file);
    this.refresh("factory:Init");
  }
  engine;
  root;
  select;
  refresh(selected) {
    this.select.textContent = "";
    const fGroup = el("optgroup");
    fGroup.label = "Factory";
    for (const p2 of FACTORY) {
      const o = el("option", void 0, p2.name);
      o.value = `factory:${p2.name}`;
      fGroup.appendChild(o);
    }
    this.select.appendChild(fGroup);
    const mine = scopeOf(this.engine);
    const users = loadUserPresets();
    if (users.length) {
      const uGroup = el("optgroup");
      uGroup.label = "User";
      for (const p2 of users) {
        const o = el("option", void 0, p2.name);
        o.value = `user:${p2.scope ?? "default"}:${p2.name}`;
        o.textContent = (p2.scope ?? "default") === mine ? p2.name : `${p2.name}  (${p2.scope ?? "default"})`;
        uGroup.appendChild(o);
      }
      this.select.appendChild(uGroup);
    }
    this.select.value = selected;
  }
  load(key) {
    const [kind, ...rest] = key.split(":");
    const name = rest.join(":");
    const preset = kind === "factory" ? FACTORY.find((p2) => p2.name === name) : (() => {
      const parts = value.split(":");
      const scope = parts.length > 2 ? parts[1] : void 0;
      const nm = parts.length > 2 ? parts.slice(2).join(":") : name;
      return readAll().find((p2) => p2.name === nm && (scope == null || (p2.scope ?? "default") === scope));
    })();
    if (preset) this.engine.loadPreset(preset);
  }
};

// ../soundgineer/src/ui/midi.ts
var MACRO_CCS = [20, 21, 22, 23];
async function initMidi(engine, onStatus) {
  if (!("requestMIDIAccess" in navigator)) {
    onStatus("MIDI: unavailable");
    return;
  }
  try {
    const access = await navigator.requestMIDIAccess();
    const attach = () => {
      let count = 0;
      access.inputs.forEach((input) => {
        count++;
        input.onmidimessage = (e) => handle(engine, e.data);
      });
      onStatus(count > 0 ? `MIDI: ${count} input${count > 1 ? "s" : ""}` : "MIDI: no inputs");
    };
    attach();
    access.onstatechange = attach;
  } catch {
    onStatus("MIDI: denied");
  }
}
function handle(engine, data) {
  if (!data || data.length < 2) return;
  const status = data[0] & 240;
  switch (status) {
    case 144:
      if (data[2] > 0) engine.noteOn(data[1], data[2] / 127);
      else engine.noteOff(data[1]);
      break;
    case 128:
      engine.noteOff(data[1]);
      break;
    case 176: {
      const cc = data[1];
      const v = data[2] / 127;
      if (cc === 1) engine.modWheel(v);
      else if (cc === 64) engine.sustain(data[2] >= 64);
      else if (cc === 120 || cc === 123) engine.allNotesOff();
      else {
        const macro = MACRO_CCS.indexOf(cc);
        if (macro >= 0) engine.setParam(paramIndex(`macro${macro + 1}.value`), v);
      }
      break;
    }
    case 208:
      engine.aftertouch(data[1] / 127);
      break;
    case 224: {
      const bend = (data[2] << 7 | data[1]) / 8192 - 1;
      engine.pitchBend(bend);
      break;
    }
  }
}

// ../soundgineer/src/ui/app.ts
function buildApp(engine, container) {
  engine.primeTables();
  const header = el("header");
  header.appendChild(el("div", "logo", "SOUNDGINEER"));
  header.appendChild(new PresetBrowser(engine).root);
  const hdrRight = el("div", "hdr-right");
  hdrRight.appendChild(new Knob(engine, paramIndex("master.volume"), 40).root);
  hdrRight.appendChild(new Knob(engine, paramIndex("master.bpm"), 40).root);
  const voiceLabel = el("span", "hdr-stat", "voices 0");
  const midiLabel = el("span", "hdr-stat", "MIDI: \u2026");
  const meter = el("div", "meter");
  const meterL = el("div", "meter-bar");
  const meterR = el("div", "meter-bar");
  meter.append(meterL, meterR);
  hdrRight.append(voiceLabel, midiLabel, meter);
  header.appendChild(hdrRight);
  const oscCol = el("div", "col osc-col");
  for (let o = 1; o <= 3; o++) {
    const panel = el("section", "panel");
    const head = el("div", "panel-head");
    head.appendChild(paramToggle(engine, `osc${o}.enabled`, "\u25CF"));
    head.appendChild(el("span", "panel-title", `OSC ${o}`));
    head.appendChild(paramSelect(engine, `osc${o}.wavetable`));
    const importBtn = el("button", "hdr-btn", "WAV");
    importBtn.title = "Import single-cycle or Serum-format wavetable WAV";
    const file = el("input");
    file.type = "file";
    file.accept = ".wav";
    file.style.display = "none";
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      if (f) engine.importWavetableFile(o - 1, f).catch((err) => alert(`Import failed: ${err}`));
      file.value = "";
    });
    importBtn.addEventListener("click", () => file.click());
    head.append(importBtn, file);
    panel.appendChild(head);
    panel.appendChild(knobRow(engine, [
      `osc${o}.morph`,
      `osc${o}.level`,
      `osc${o}.pan`,
      `osc${o}.transpose`,
      `osc${o}.fine`,
      `osc${o}.sync`
    ], 42));
    panel.appendChild(knobRow(engine, [
      `osc${o}.unison`,
      `osc${o}.detune`,
      `osc${o}.blend`,
      `osc${o}.spread`,
      `osc${o}.phase`,
      `osc${o}.phase_rand`
    ], 42));
    oscCol.appendChild(panel);
  }
  const subPanel = el("section", "panel");
  const subHead = el("div", "panel-head");
  subHead.appendChild(paramToggle(engine, "sub.enabled", "\u25CF"));
  subHead.appendChild(el("span", "panel-title", "SUB"));
  subHead.appendChild(paramSelect(engine, "sub.shape"));
  subPanel.appendChild(subHead);
  subPanel.appendChild(knobRow(engine, ["sub.level", "sub.pan", "sub.octave"], 42));
  const noiseHead = el("div", "panel-head");
  noiseHead.appendChild(paramToggle(engine, "noise.enabled", "\u25CF"));
  noiseHead.appendChild(el("span", "panel-title", "NOISE"));
  noiseHead.appendChild(paramSelect(engine, "noise.type"));
  const sampleBtn = el("button", "hdr-btn", "SMP");
  sampleBtn.title = "Load a WAV into the sample slot (Noise type: Sample)";
  const sampleFile = el("input");
  sampleFile.type = "file";
  sampleFile.accept = ".wav";
  sampleFile.style.display = "none";
  sampleFile.addEventListener("change", () => {
    const f = sampleFile.files?.[0];
    if (f) engine.importSampleFile(f).catch((err) => alert(`Sample load failed: ${err}`));
    sampleFile.value = "";
  });
  sampleBtn.addEventListener("click", () => sampleFile.click());
  noiseHead.append(sampleBtn, sampleFile);
  subPanel.appendChild(noiseHead);
  subPanel.appendChild(knobRow(engine, ["noise.level", "noise.pan", "noise.pitch"], 42));
  oscCol.appendChild(subPanel);
  const centerCol = el("div", "col center-col");
  const vizRow = el("div", "viz-row");
  const wt3d = new WavetableView(engine);
  const scope = new Scope(engine);
  vizRow.append(wt3d.root, scope.root);
  centerCol.appendChild(vizRow);
  const filterRow = el("div", "filter-row");
  for (let f = 1; f <= 2; f++) {
    const panel = el("section", "panel filter-panel");
    const head = el("div", "panel-head");
    head.appendChild(paramToggle(engine, `filter${f}.enabled`, "\u25CF"));
    head.appendChild(el("span", "panel-title", `FILTER ${f}`));
    head.appendChild(paramSelect(engine, `filter${f}.type`));
    panel.appendChild(head);
    panel.appendChild(knobRow(engine, [
      `filter${f}.cutoff`,
      `filter${f}.resonance`,
      `filter${f}.drive`,
      `filter${f}.keytrack`,
      `filter${f}.mix`
    ], 42));
    filterRow.appendChild(panel);
  }
  const distPanel = el("section", "panel filter-panel");
  const distHead = el("div", "panel-head");
  distHead.appendChild(el("span", "panel-title", "SHAPE"));
  distHead.appendChild(paramSelect(engine, "dist.type"));
  distPanel.appendChild(distHead);
  distPanel.appendChild(knobRow(engine, ["dist.drive", "dist.mix", "dist.bits", "dist.downsample"], 42));
  const routingWrap = el("div", "routing-wrap");
  routingWrap.appendChild(el("span", "routing-label", "ROUTING"));
  routingWrap.appendChild(paramSelect(engine, "filter.routing"));
  distPanel.appendChild(routingWrap);
  filterRow.appendChild(distPanel);
  centerCol.appendChild(filterRow);
  const tabsPanel = el("section", "panel tabs-panel");
  const tabBar = el("div", "tab-bar");
  const tabBodies = /* @__PURE__ */ new Map();
  const tabButtons = /* @__PURE__ */ new Map();
  const addTab = (name, body) => {
    const btn = el("button", "tab-btn", name);
    btn.addEventListener("click", () => selectTab(name));
    tabBar.appendChild(btn);
    tabButtons.set(name, btn);
    tabBodies.set(name, body);
  };
  const tabContent = el("div", "tab-content");
  const selectTab = (name) => {
    tabContent.textContent = "";
    tabContent.appendChild(tabBodies.get(name));
    tabButtons.forEach((b, n) => b.classList.toggle("on", n === name));
  };
  const envBody = el("div", "mod-tab");
  const envSelector = el("div", "sub-tabs");
  const envDisplay = new EnvDisplay(engine, 1);
  const envKnobArea = el("div");
  let currentEnv = 1;
  const renderEnvKnobs = () => {
    envKnobArea.textContent = "";
    envKnobArea.appendChild(knobRow(engine, [
      `env${currentEnv}.delay`,
      `env${currentEnv}.attack`,
      `env${currentEnv}.hold`,
      `env${currentEnv}.decay`,
      `env${currentEnv}.sustain`,
      `env${currentEnv}.release`,
      `env${currentEnv}.atk_curve`,
      `env${currentEnv}.dec_curve`,
      `env${currentEnv}.rel_curve`
    ], 42));
  };
  const envBtns = [];
  for (let e = 1; e <= 6; e++) {
    const wrap = el("div", "sub-tab-wrap");
    const b = el("button", e === 1 ? "sub-tab on" : "sub-tab", `ENV ${e}${e === 1 ? " \xB7 AMP" : ""}`);
    b.addEventListener("click", () => {
      currentEnv = e;
      envBtns.forEach((x, i) => x.classList.toggle("on", i === e - 1));
      envDisplay.setEnv(e);
      renderEnvKnobs();
    });
    envBtns.push(b);
    wrap.append(b, sourceBadge(engine, `env${e}`));
    envSelector.appendChild(wrap);
  }
  renderEnvKnobs();
  envBody.append(envSelector, envDisplay.root, envKnobArea);
  addTab("ENV", envBody);
  const lfoBody = el("div", "mod-tab");
  const lfoSelector = el("div", "sub-tabs");
  const lfoEditor = new LfoEditor(engine, 0);
  const lfoKnobArea = el("div");
  let currentLfo = 1;
  const renderLfoKnobs = () => {
    lfoKnobArea.textContent = "";
    const row = el("div", "knob-row lfo-controls");
    row.appendChild(new Knob(engine, paramIndex(`lfo${currentLfo}.rate`), 42).root);
    row.appendChild(paramToggle(engine, `lfo${currentLfo}.sync`, "SYNC"));
    row.appendChild(paramSelect(engine, `lfo${currentLfo}.division`));
    row.appendChild(paramSelect(engine, `lfo${currentLfo}.mode`));
    row.appendChild(new Knob(engine, paramIndex(`lfo${currentLfo}.phase`), 42).root);
    row.appendChild(new Knob(engine, paramIndex(`lfo${currentLfo}.smooth`), 42).root);
    lfoKnobArea.appendChild(row);
  };
  const lfoBtns = [];
  for (let l = 1; l <= 8; l++) {
    const wrap = el("div", "sub-tab-wrap");
    const b = el("button", l === 1 ? "sub-tab on" : "sub-tab", `LFO ${l}`);
    b.addEventListener("click", () => {
      currentLfo = l;
      lfoBtns.forEach((x, i) => x.classList.toggle("on", i === l - 1));
      lfoEditor.setLfo(l - 1);
      renderLfoKnobs();
    });
    lfoBtns.push(b);
    wrap.append(b, sourceBadge(engine, `lfo${l}`));
    lfoSelector.appendChild(wrap);
  }
  renderLfoKnobs();
  lfoBody.append(lfoSelector, lfoEditor.root, lfoKnobArea);
  addTab("LFO", lfoBody);
  const matrixBody = el("div", "mod-tab");
  const srcRow = el("div", "source-row");
  const macroKnobs = el("div", "knob-row");
  for (let m = 1; m <= 4; m++) {
    const wrap = el("div", "macro-wrap");
    wrap.appendChild(new Knob(engine, paramIndex(`macro${m}.value`), 42).root);
    wrap.appendChild(sourceBadge(engine, `macro${m}`));
    macroKnobs.appendChild(wrap);
  }
  srcRow.appendChild(macroKnobs);
  const perfBadges = el("div", "badge-row");
  for (const id of ["velocity", "keytrack", "random", "modwheel", "pitchwheel", "aftertouch"]) {
    perfBadges.appendChild(sourceBadge(engine, id));
  }
  srcRow.appendChild(perfBadges);
  matrixBody.append(srcRow, new ModMatrix(engine).root);
  addTab("MATRIX", matrixBody);
  const fxBody = el("div", "mod-tab");
  fxBody.appendChild(new FxRack(engine).root);
  addTab("FX", fxBody);
  tabsPanel.append(tabBar, tabContent);
  selectTab("ENV");
  centerCol.appendChild(tabsPanel);
  const main = el("main");
  main.append(oscCol, centerCol);
  const keyboard = new Keyboard(engine);
  container.append(header, main, keyboard.root);
  initMidi(engine, (text) => {
    midiLabel.textContent = text;
  });
  const tick = () => {
    scope.draw();
    wt3d.draw();
    for (const k of animatedKnobs()) k.draw();
    lfoEditor.draw();
    envDisplay.draw();
    voiceLabel.textContent = `voices ${engine.voiceCount}`;
    meterL.style.width = `${Math.min(engine.peakL * 100, 100)}%`;
    meterR.style.width = `${Math.min(engine.peakR * 100, 100)}%`;
    meterL.classList.toggle("hot", engine.peakL > 1);
    meterR.classList.toggle("hot", engine.peakR > 1);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
export {
  buildApp
};
