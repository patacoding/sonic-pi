// SPDX-License-Identifier: AGPL-3.0-or-later
// Elementary's own code area: a draggable window (the drag and its boundary clamp follow web/synth/window.js, so both windows behave the
// same) with a CodeMirror editor that highlights JavaScript, Run and Stop, and the position remembered between sessions.
//
// A 档 contract: the code is a function body with `el` in scope, ending in `return <node>` (or a bare node on the last line).

import { createElementary } from "./el-bridge.js";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";

const CODE_KEY = "sp-elementary-code-v3";
const POS_KEY = "sp-elementary-pos";
const DEFAULT_CODE = `// Elementary 4 is positional: lowpass(cutoff, q, node).
// End with return, then the node (or array of nodes) you want to hear.
const cutoff = el.add(600, el.mul(500, el.cycle(0.2)));
return el.mul(0.25, el.lowpass(cutoff, 1, el.blepsaw(220)))`;

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
.elem-editor{height:min(34vh,260px);overflow:auto;border:1px solid var(--WindowBorder);border-radius:6px}
.elem-editor .cm-editor{height:100%;background:color-mix(in srgb,var(--WindowBackground) 88%,#000);color:var(--WindowForeground)}
.elem-editor .cm-scroller{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.elem-editor .cm-gutters{background:transparent;color:color-mix(in srgb,var(--WindowForeground) 45%,transparent);border-right:1px solid var(--WindowBorder)}
.elem-foot{padding:2px;color:color-mix(in srgb,var(--WindowForeground) 62%,transparent);font-size:12px;white-space:pre-wrap;min-height:2.2em}
.elem-foot.err{color:#ff9a9a}
`;

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

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
