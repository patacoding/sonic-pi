// SPDX-License-Identifier: AGPL-3.0-or-later
// The synthesizer's editor: a window with knobs you can turn, so the synth can be played and shaped without
// writing a line of code.
//
// It is built from `vendor/webaudio-controls.js` (Apache-2.0, Web Components: <webaudio-knob>,
// <webaudio-slider>, <webaudio-switch>, <webaudio-keyboard>), loaded LAZILY the first time the window is
// opened -- the app's normal payload does not carry 72 KB of panel parts it may never use.
//
// Everything here lives in the synth's namespace and knows only the synth's public API (synth.set,
// noteOn/noteOff, allNotesOff, loadWaveform); the graphics layer knows only that this exists.
//
// Measured contract with the library (read out of the vendored file, and asserted in
// tools/synth-ui-probe):
//   * a knob/slider/switch fires `change` (and `input` while dragging) with the number at `e.target.value`
//   * <webaudio-keyboard> fires one `change` per note with `e.note = [state, midi]` (state 1 = on, 0 = off)

const VENDOR = new URL("vendor/webaudio-controls.js", import.meta.url);

const WAVES = ["saw", "square", "triangle", "sine"];
const FILTERS = [["lp", "low pass"], ["bp", "band pass"], ["hp", "high pass"]];

/** Load the vendored library once, and resolve when its elements are defined. */
let loading = null;
function loadControls() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    if (customElements.get("webaudio-knob")) return resolve();
    const s = document.createElement("script");
    s.src = VENDOR.href;
    s.addEventListener("load", () => resolve());
    s.addEventListener("error", () => reject(new Error(`could not load ${VENDOR.pathname}`)));
    document.head.appendChild(s);
  });
  return loading;
}

const STYLE_ID = "synth-ui-style";
const CSS = `
.synth-editor{position:fixed;inset:0;z-index:97;display:flex;align-items:flex-start;justify-content:center;
  padding:3vh 2vw;background:rgb(0 0 0 / 45%)}
.synth-editor .synth-window{background:var(--pop-bg,#1e1e22);color:var(--t-label,#e8e8ea);
  border:1px solid var(--pop-border,#3a3a42);border-radius:12px;box-shadow:var(--pop-shadow,0 12px 40px rgb(0 0 0 / 45%));
  max-height:94vh;overflow:auto;width:min(1100px,96vw);font-family:var(--prose-font,system-ui);font-size:var(--t-ui,14px)}
.synth-editor .synth-head{display:flex;align-items:center;gap:.6em;padding:.7em 1em;border-bottom:1px solid var(--pop-border,#3a3a42)}
.synth-editor .synth-head h3{margin:0;font-size:var(--t-ui,15px);flex:1}
.synth-editor .synth-body{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:.8em;padding:1em}
.synth-editor .synth-section{border:1px solid var(--pop-border,#3a3a42);border-radius:10px;padding:.5em .7em}
.synth-editor .synth-section h4{margin:.2em 0 .6em;font-size:var(--t-label,13px);opacity:.75;text-transform:uppercase;letter-spacing:.06em}
.synth-editor .synth-knob{display:flex;flex-direction:column;align-items:center;gap:.15em;width:72px}
.synth-editor .synth-label{font-size:var(--t-tiny,11px);opacity:.75}
.synth-editor .synth-readout{font-size:var(--code-font,11px);opacity:.9}
.synth-editor .synth-section{display:flex;flex-wrap:wrap;gap:.5em;align-items:flex-start}
.synth-editor .synth-row{display:flex;align-items:center;gap:.4em;width:100%}
.synth-editor webaudio-keyboard{display:block;margin:.4em auto 0}
`;
function installStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

const el = (tag, cls = "", text = null) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * @param {{synth: object, onSay?: (text: string) => void, onProblem?: (text: string) => void}} opts
 */
export function createSynthEditor({ synth, onSay = null, onProblem = null }) {
  const say = (t) => (onSay ? onSay(t) : console.info(`Synth — ${t}`));
  const problem = (t) => (onProblem ? onProblem(t) : console.warn(t));
  let root = null, window_ = null, status = null, keyboard = null;
  const held = new Set();
  const values = {};                      // the editor's own copy of what the controls show

  const set = (part) => {
    try { synth.set(part); } catch { /* the synth is not up yet; the next note starts it */ }
  };

  /** One labelled knob. `format` only affects the readout under it. */
  function knob(label, key, { min, max, value, step = 1, log = false, format = (v) => String(v), apply }) {
    const wrap = el("label", "synth-knob");
    const k = document.createElement("webaudio-knob");
    k.setAttribute("min", String(min));
    k.setAttribute("max", String(max));
    k.setAttribute("step", String(step));
    k.setAttribute("value", String(value));
    k.setAttribute("diameter", "56");
    k.setAttribute("valuetip", "0");
    k.dataset.key = key;
    if (log) k.setAttribute("log", "1");
    const readout = el("span", "synth-readout", format(value));
    values[key] = value;
    const update = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      values[key] = n;
      readout.textContent = format(n);
      apply(n);
    };
    k.addEventListener("input", (e) => update(e.target.value));
    k.addEventListener("change", (e) => update(e.target.value));
    wrap.append(k, el("span", "synth-label", label), readout);
    return wrap;
  }

  /** A row of buttons acting as a radio: one of them is on. */
  function chooser(label, options, current, choose) {
    const row = el("div", "synth-row");
    row.appendChild(el("span", "synth-label", label));
    const group = el("div", "seg");
    const buttons = [];
    const sync = (v) => buttons.forEach((b, i) => b.classList.toggle("on", options[i][0] === v));
    options.forEach(([id, name]) => {
      const b = el("button", "sp-mini-btn", name);
      b.addEventListener("click", () => { choose(id); sync(id); });
      buttons.push(b);
      group.appendChild(b);
    });
    sync(current());
    row.appendChild(group);
    return row;
  }

  function section(title, ...children) {
    const s = el("section", "synth-section");
    s.appendChild(el("h4", "", title));
    s.append(...children);
    return s;
  }

  /** A/D/S/R for one envelope. */
  function envelope(title, prefix, patch) {
    return section(title,
      knob("attack", `${prefix}.a`, { min: 0.001, max: 2, value: patch.a, step: 0.001, log: true, format: (v) => `${(v * 1000).toFixed(0)} ms`, apply: (v) => set({ [prefix]: { a: v } }) }),
      knob("decay", `${prefix}.d`, { min: 0.001, max: 4, value: patch.d, step: 0.001, log: true, format: (v) => `${(v * 1000).toFixed(0)} ms`, apply: (v) => set({ [prefix]: { d: v } }) }),
      knob("sustain", `${prefix}.s`, { min: 0, max: 1, value: patch.s, step: 0.01, format: (v) => v.toFixed(2), apply: (v) => set({ [prefix]: { s: v } }) }),
      knob("release", `${prefix}.r`, { min: 0.001, max: 4, value: patch.r, step: 0.001, log: true, format: (v) => `${(v * 1000).toFixed(0)} ms`, apply: (v) => set({ [prefix]: { r: v } }) }));
  }

  async function build() {
    await loadControls();
    installStyle();
    const patch = synth.patch ?? {};
    const f = patch.filter ?? {}, amp = patch.amp ?? {}, mod = patch.mod ?? {}, lfo = patch.lfo ?? {};

    root = el("div", "synth-editor");
    window_ = el("div", "synth-window");

    const head = el("header", "synth-head");
    head.appendChild(el("h3", "", "Synth"));
    const close = el("button", "sp-mini-btn", "close");
    close.addEventListener("click", () => hide());
    const panic = el("button", "sp-mini-btn", "all notes off");
    panic.addEventListener("click", () => { held.clear(); synth.allNotesOff(); });
    head.append(panic, close);
    window_.appendChild(head);

    const body = el("div", "synth-body");
    body.append(
      section("Oscillator",
        chooser("waveform", WAVES.map((w) => [w, w]), () => values.wave ?? patch.wave ?? "saw",
          (w) => { values.wave = w; set({ wave: w }); }),
        knob("gain", "gain", { min: 0, max: 0.8, value: patch.gain ?? 0.25, step: 0.01, format: (v) => v.toFixed(2), apply: (v) => set({ gain: v }) }),
        knob("detune", "detune", { min: -50, max: 50, value: patch.detune ?? 0, step: 0.1, format: (v) => `${v.toFixed(1)} ¢`, apply: (v) => set({ detune: v }) })),
      section("Filter",
        chooser("type", FILTERS, () => values.filterType ?? f.type ?? "lp",
          (t) => { values.filterType = t; set({ filter: { type: t } }); }),
        knob("cutoff", "cutoff", { min: 30, max: 16000, value: f.cutoff ?? 1200, step: 1, log: true, format: (v) => `${Math.round(v)} Hz`, apply: (v) => set({ filter: { cutoff: v } }) }),
        knob("resonance", "q", { min: 0.1, max: 20, value: f.q ?? 0.9, step: 0.1, format: (v) => v.toFixed(1), apply: (v) => set({ filter: { q: v } }) }),
        knob("env", "env", { min: 0, max: 8, value: f.env ?? 0, step: 0.05, format: (v) => v.toFixed(2), apply: (v) => set({ filter: { env: v } }) }),
        knob("key", "keyTrack", { min: 0, max: 2, value: f.keyTrack ?? 0, step: 0.05, format: (v) => v.toFixed(2), apply: (v) => set({ filter: { keyTrack: v } }) })),
      envelope("Amp envelope", "amp", amp),
      envelope("Mod envelope", "mod", mod),
      section("LFO",
        knob("rate", "lfo.rate", { min: 0.05, max: 24, value: lfo.rate ?? 5, step: 0.05, log: true, format: (v) => `${v.toFixed(2)} Hz`, apply: (v) => set({ lfo: { rate: v } }) }),
        knob("pitch", "lfo.pitch", { min: -1, max: 1, value: lfo.pitch ?? 0, step: 0.01, format: (v) => v.toFixed(2), apply: (v) => set({ lfo: { pitch: v } }) }),
        knob("cutoff", "lfo.cutoff", { min: -1, max: 1, value: lfo.cutoff ?? 0, step: 0.01, format: (v) => v.toFixed(2), apply: (v) => set({ lfo: { cutoff: v } }) }),
        knob("amp", "lfo.amp", { min: -1, max: 1, value: lfo.amp ?? 0, step: 0.01, format: (v) => v.toFixed(2), apply: (v) => set({ lfo: { amp: v } }) })),
      section("Wavetable",
        (() => {
          const row = el("div", "synth-row");
          const b = el("button", "sp-mini-btn", "load a wavetable (.wav)…");
          b.addEventListener("click", () => pickWaveform());
          row.appendChild(b);
          status = el("span", "synth-readout", "the built-in tables are in use");
          row.appendChild(status);
          return row;
        })()));

    // the keyboard is the point of a testable editor: click it and the synth sounds
    keyboard = document.createElement("webaudio-keyboard");
    for (const [k, v] of Object.entries({ min: "36", max: "84", width: "620", height: "80", keys: "25" })) keyboard.setAttribute(k, v);
    keyboard.addEventListener("change", (e) => {
      const note = e.note?.[1], on = e.note?.[0];
      if (typeof note !== "number") return;
      if (on) { held.add(note); synth.ensure().then(() => synth.noteOn(note, { velocity: 1 })).catch((err) => problem(String(err.message ?? err))); }
      else { held.delete(note); synth.noteOff(note); }
    });

    body.appendChild(keyboard);
    window_.appendChild(body);
    root.appendChild(window_);
    root.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); hide(); } });
    document.body.appendChild(root);
    say("editor opened (knobs turn the synth live; the keyboard plays it)");
  }

  /** A real file picker, from a real click, so the browser allows it -- then the file becomes the table. */
  function pickWaveform() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*,.wav,.wave";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      synth.ensure()
        .then(() => synth.loadWaveform(file))
        .then((r) => { if (status) status.textContent = `${file.name}: one cycle of ${r.cycle}, ${r.harmonics.length} harmonics`; say(`wavetable "${file.name}" loaded`); })
        .catch((e) => problem(`the wavetable could not be loaded: ${e.message}`));
    });
    input.click();
  }

  function hide() {
    if (root) root.style.display = "none";
    if (held.size) { held.clear(); synth.allNotesOff(); }
  }

  async function show() {
    if (!root) await build();
    else root.style.display = "";
    synth.ensure().catch((e) => problem(`the synth is not ready: ${e.message}`));
  }

  return {
    async toggle() { if (root && root.style.display !== "none") hide(); else await show(); },
    async open() { await show(); },
    close: hide,
    get isOpen() { return !!root && root.style.display !== "none"; },
    get values() { return { ...values }; },
    /** For probes (and for the panel, if it ever wants to show a value): press a control programmatically. */
    setValue(key, value) {
      const k = root?.querySelector(`webaudio-knob[data-key="${key}"]`);
      if (!k) return false;
      k.setAttribute("value", String(value));
      k.value = value;
      k.dispatchEvent(new Event("input"));          // what a drag sends while it moves
      k.dispatchEvent(new Event("change"));         // and what it sends when it is let go
      return true;
    },
    WAVES,
    FILTERS,
  };
}
