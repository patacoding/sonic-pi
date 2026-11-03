// SPDX-License-Identifier: AGPL-3.0-or-later
// Elementary's own code area: a draggable window (the drag and its boundary clamp follow web/synth/window.js, so both windows behave the
// same) with a CodeMirror editor that highlights JavaScript, Run and Stop, and the position remembered between sessions.
//
// A 档 contract: the code is a function body with `el` in scope, ending in `return <node>` (or a bare node on the last line).

import { createElementary, API } from "./el-bridge.js";
const { el } = API;
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { autocompletion, snippet } from "@codemirror/autocomplete";

const CODE_KEY = "sp-elementary-code-v6";   // v6: the preset is louder (the bridge no longer scales it down)   // v5: the default defines a MIDI voice
const POS_KEY = "sp-elementary-pos";
const DEFAULT_CODE = `// Your timbre. Sonic Pi plays the notes (midi_note_on / midi_note_off in its buffers);
// this code decides what they sound like. \`channel\` lets one timbre answer channel 1, another channel 2.
export default {
  voice(note, velocity, channel, gate) {
    const freq = el.cycle(440 * Math.pow(2, (note - 69) / 12));
    const tone = channel === 2
      ? el.blepsquare(el.mul(freq, 0.5))
      : el.lowpass(el.add(600, el.mul(1800, velocity)), 1, el.blepsaw(freq));
    return el.mul(el.mul(0.55, velocity), tone, el.adsr(0.005, 0.15, 0.55, 0.35, gate));
  },
};`;

const css = `
/* The side tab and the window follow Soundgineer's (#synth-btn, #synth-window in web/synth/window.js): a vertical tab on the right
   edge, the same theme variables, just below the Synth tab. Two tabs, one shape. */
.elem-btn{position:fixed;right:0;top:calc(50% + 12.6em);z-index:101;writing-mode:vertical-rl;height:5.4em;overflow:hidden;
  padding:10px 6px;cursor:pointer;font:12px/1.1 system-ui,sans-serif;letter-spacing:.04em;text-align:center;
  color:var(--WindowForeground);border:1px solid var(--WindowBorder);border-right:0;border-radius:8px 0 0 8px;
  background:color-mix(in srgb,var(--WindowBackground) 92%,transparent)}
.elem-btn:hover{background:color-mix(in srgb,var(--WindowBackground) 78%,transparent)}
.elem-btn[aria-pressed="true"]{border-color:#5a8;color:#5a8}
.elem-win{position:fixed;z-index:97;width:min(620px,calc(100vw - 28px));display:flex;flex-direction:column;gap:6px;padding:8px;
  background:var(--WindowBackground);color:var(--WindowForeground);border:1px solid var(--WindowBorder);border-radius:8px;
  box-shadow:0 10px 40px #000a;font:13px/1.45 system-ui,sans-serif}
.elem-win[hidden]{display:none}
.elem-bar{display:flex;align-items:center;gap:8px;padding:2px 2px 6px;cursor:grab;user-select:none}
.elem-bar:active{cursor:grabbing}
.elem-bar b{font-weight:600;margin-right:auto}
.elem-bar button{border:1px solid var(--WindowBorder);background:transparent;color:var(--WindowForeground);border-radius:6px;
  padding:3px 10px;cursor:pointer;font:inherit}
.elem-bar button.primary{border-color:#3c8a4c;color:#8f8}
.elem-bar button:disabled{opacity:.5;cursor:default}
.elem-editor{height:min(62vh,520px);min-height:180px;resize:vertical;overflow:auto;border:1px solid var(--WindowBorder);border-radius:6px}
.elem-editor .cm-editor{height:100%;background:color-mix(in srgb,var(--WindowBackground) 88%,#000);color:var(--WindowForeground)}
.elem-editor .cm-scroller{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.elem-editor .cm-gutters{background:transparent;color:color-mix(in srgb,var(--WindowForeground) 45%,transparent);border-right:1px solid var(--WindowBorder)}
.elem-foot{padding:2px;color:color-mix(in srgb,var(--WindowForeground) 62%,transparent);font-size:12px;white-space:pre-wrap;min-height:2.2em}
.elem-foot.err{color:#ff9a9a}
`;

// Autocomplete over `el`: every function the library exposes, with the signature for the ones that have a surprising shape -- in
// Elementary 4 some nodes take positional arguments (lowpass(cutoff, q, node)) and some take an object with a required key
// (metro({key, period})) -- which is exactly what a bare list of names cannot tell you.
const EL_SIGNATURES = {
  cycle: "cycle(hz)                        a sine at hz",
  saw: "saw(freq)                         (v4: positional)",
  blepsaw: "blepsaw(freq)                   band-limited, positional",
  blepsquare: "blepsquare(freq)",
  bleptriangle: "bleptriangle(freq)",
  square: "square(freq)", triangle: "triangle(freq)",
  lowpass: "lowpass(cutoff, q, x)            positional: three arguments",
  highpass: "highpass(cutoff, q, x)", bandpass: "bandpass(cutoff, q, x)", notch: "notch(cutoff, q, x)",
  svf: "svf({key, mode, cutoff, q}, x)    object with a required key",
  biquad: "biquad({key, type, freq, q}, x)",
  delay: "delay({key, size, decay}, x)      object with a required key",
  adsr: "adsr(a, d, s, r, gateNode)        positional, gate last",
  env: "env(a, d, s, r, gateNode)",
  train: "train(freq)                       a pulse train (a gate)",
  metro: "metro({key, period})              object with a required key",
  seq: "seq({key, seq, hold}, clock)       object; seq is the array",
  seq2: "seq2({key, seq, hold}, clock)",
  sample: "sample({key, path}, trigger)      path is a name in the virtual file system",
  sampleseq: "sampleseq({key, seq}, clock)",
  table: "table({key, path}, x)", mul: "mul(a, b, ...)", add: "add(a, b, ...)",
  sub: "sub(a, b)", div: "div(a, b)", pow: "pow(a, b)", mod: "mod(a, b)",
  const: "const({key, value})               a constant node; key is required",
  counter: "counter(x)", accum: "accum(x)            integrate a signal",
  latch: "latch(x, gate)", smooth: "smooth(tau, x)", z: "z(x)                  one-sample delay",
  time: "time()                         seconds since the engine started",
  sm: "sm(x, gate)", snapshot: "snapshot(x, gate)",
};

// A signature like "lowpass(cutoff, q, x)   positional" becomes the snippet el.lowpass(${cutoff}, ${q}, ${x}) -- the name, the
// parentheses and one placeholder per argument, so Tab walks them. Object shapes get a literal skeleton with a single placeholder,
// because their keys are what matters and a placeholder per key would fight the user.
const snippetFor = (name) => {
  const sig = EL_SIGNATURES[name];
  const m = sig && /^[a-zA-Z0-9_]+\s*\(([^)]*)\)/.exec(sig);
  if (!m) return `el.${name}(`;
  const args = m[1].trim();
  if (!args) return `el.${name}()`;
  if (args.includes("{")) return `el.${name}(${args.replace(/[a-zA-Z_]+/g, "")})`;
  const names = args.split(",").map((a) => a.trim()).filter(Boolean);
  return `el.${name}(${names.map((a) => "${" + a + "}").join(", ")})`;
};

const elCompletions = (ctx) => {
  const word = ctx.matchBefore(/[\w.$]*$/) || { from: ctx.pos, text: "" };
  if (!ctx.explicit && word.text.length < 2 && ctx.pos > 0 && ctx.matchBefore(/\w/) == null) return null;
  const options = Object.keys(el).filter((k) => typeof el[k] === "function").map((k) => ({
    label: "el." + k,
    type: "function",
    detail: EL_SIGNATURES[k] ?? el[k].length + " arg(s)",
    info: EL_SIGNATURES[k] ?? undefined,
    apply: snippet(snippetFor(k)),
  }));
  return { from: word.from, options };
};

const mount = () => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const openBtn = document.createElement("button");
  openBtn.className = "elem-btn";
  openBtn.title = "Elementary: JavaScript synthesis, through Sonic Pi";
  openBtn.textContent = "él";
  document.body.appendChild(openBtn);

  const win = document.createElement("div");
  win.className = "elem-win";
  win.hidden = true;
  win.innerHTML = `<div class="elem-bar"><b>Elementary</b>
      <button data-act="run" class="primary" title="Run (Ctrl/Cmd+Enter)">Run</button>
      <button data-act="stop">Stop</button>
      <button data-act="close" title="Close">×</button></div>
    <div class="elem-editor"></div>
    <div class="elem-foot">Ready. End with return, then the node you want to hear.</div>`;
  document.body.appendChild(win);

  const foot = win.querySelector(".elem-foot");
  const setFoot = (text, err = false) => { foot.textContent = text; foot.classList.toggle("err", err); };
  const elementary = createElementary();
  globalThis.sonicPiElementary = elementary;   // the app's midi hook (main.js) calls handleMidi here

  const run = async () => {
    const started = performance.now();
    setFoot("Running…");
    try {
      const { channels } = await elementary.run(view.state.doc.toString());
      setFoot(`Running: ${channels} channel${channels === 1 ? "" : "s"} out to Sonic Pi's input (${Math.round(performance.now() - started)} ms). Edit and Run again: the sound changes without stopping.`);
    } catch (e) { setFoot(String(e?.message ?? e), true); }
  };
  const stop = async () => {
    try { await elementary.stop(); setFoot("Stopped (silence rendered). Run again to hear it."); }
    catch (e) { setFoot(String(e?.message ?? e), true); }
  };

  const view = new EditorView({
    parent: win.querySelector(".elem-editor"),
    state: EditorState.create({
      doc: localStorage.getItem(CODE_KEY) ?? DEFAULT_CODE,
      extensions: [
        basicSetup,
        javascript(),
        EditorView.updateListener.of((u) => { if (u.docChanged) localStorage.setItem(CODE_KEY, u.state.doc.toString()); }),
        keymap.of([{ key: "Mod-Enter", preventDefault: true, run: () => { run(); return true; } }]),
        autocompletion({ override: [elCompletions] }),
      ],
    }),
  });

  // position: restored, and kept inside reach -- the same clamp web/synth/window.js uses for its own window
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(POS_KEY) ?? "null"); } catch { pos = null; }
  const clampPos = (p) => {
    const w = win.offsetWidth || 600, keepX = Math.min(140, w), keepY = 32;
    return { left: Math.round(Math.max(keepX - w, Math.min(p.left, innerWidth - keepX))),
             top: Math.round(Math.max(0, Math.min(p.top, innerHeight - keepY))) };
  };
  const place = (p) => { pos = clampPos(p); win.style.left = pos.left + "px"; win.style.top = pos.top + "px";
    localStorage.setItem(POS_KEY, JSON.stringify(pos)); };
  place(pos ?? { left: Math.max(12, innerWidth - 660), top: Math.max(12, innerHeight - 460) });

  win.querySelector(".elem-bar").addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const bar = e.currentTarget, r = win.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => place({ left: ev.clientX - dx, top: ev.clientY - dy });
    const up = (ev) => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", up);
      try { bar.releasePointerCapture(ev.pointerId); } catch { /* nothing captured */ }
    };
    try { bar.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer may refuse; the drag still works */ }
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
    e.preventDefault();
  });

  win.addEventListener("click", (ev) => {
    const act = ev.target?.dataset?.act;
    if (act === "run") run();
    else if (act === "stop") stop();
    else if (act === "close") win.hidden = true;
  });
  const setOpen = (open) => { win.hidden = !open; openBtn.setAttribute("aria-pressed", String(open)); if (open) view.focus(); };
  openBtn.addEventListener("click", () => setOpen(win.hidden));
};

// Mount, and if it throws, say so where a probe (and the player) can see it instead of failing silently.
const safeMount = () => {
  try { mount(); } catch (e) {
    (globalThis.__errs ??= []).push("elementary mount: " + (e?.stack ?? e));
    console.error("elementary panel: mount failed", e);
  }
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", safeMount); else safeMount();
