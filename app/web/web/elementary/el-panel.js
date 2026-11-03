// SPDX-License-Identifier: AGPL-3.0-or-later
// Elementary's own code area, separate from the Sonic Pi buffers: a small panel with a text area, Run and Stop. A 档 -- the code is a
// function body with `el` in scope, and it ends with the node (or array of nodes) you want to hear:
//
//     el.mul(el.blepsaw({ freq: 220 }), el.adsr(0.01, 0.1, 0.6, 0.3, el.train(2)))
//
// The sound leaves through the engine's input, so Sonic Pi's with_fx, scope and Recorder see it.

import { createElementary } from "./el-bridge.js";

const STORAGE = "sp-elementary-code-v2";   // v2: the first key held code without `return`
const DEFAULT_CODE = `// Elementary 4 is positional: lowpass(cutoff, q, node).
// End with return, then the node (or array of nodes) you want to hear.
const cutoff = el.add(600, el.mul(500, el.cycle(0.2)));
return el.mul(0.25, el.lowpass(cutoff, 1, el.blepsaw(220)))`;

const css = `
.elem-btn{position:fixed;right:14px;bottom:14px;z-index:60;width:40px;height:40px;border-radius:20px;border:1px solid #555;
  background:#1b1b1b;color:#eee;font:600 13px/1 ui-monospace,monospace;cursor:pointer}
.elem-btn:hover{background:#2a2a2a}
.elem-panel{position:fixed;right:14px;bottom:64px;z-index:61;width:min(560px,calc(100vw - 28px));height:min(420px,60vh);display:flex;
  flex-direction:column;background:#141414;color:#e8e8e8;border:1px solid #444;border-radius:10px;box-shadow:0 10px 40px #000a;
  font:13px/1.45 ui-sans-serif,system-ui,sans-serif}
.elem-panel[hidden]{display:none}
.elem-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #333}
.elem-head b{font-weight:600;margin-right:auto}
.elem-head button{border:1px solid #555;background:#222;color:#eee;border-radius:6px;padding:4px 10px;cursor:pointer}
.elem-head button.primary{background:#2f6b3b;border-color:#3c8a4c}
.elem-head button:disabled{opacity:.5;cursor:default}
.elem-code{flex:1;margin:0;padding:10px;border:0;outline:none;resize:none;background:#101010;color:#e8e8e8;
  font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:2}
.elem-foot{padding:6px 10px;border-top:1px solid #333;color:#9a9a9a;font-size:12px;white-space:pre-wrap}
.elem-foot.err{color:#ff9a9a}
`;

const mount = () => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const openBtn = document.createElement("button");
  openBtn.className = "elem-btn";
  openBtn.title = "Elementary: write JavaScript that plays through Sonic Pi";
  openBtn.textContent = "él";
  document.body.appendChild(openBtn);

  const panel = document.createElement("div");
  panel.className = "elem-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="elem-head"><b>Elementary</b>
      <button data-act="run" class="primary">Run</button>
      <button data-act="stop">Stop</button>
      <button data-act="close" title="Close">×</button></div>
    <textarea class="elem-code" spellcheck="false"></textarea>
    <div class="elem-foot">Ready. Sound goes straight out; end with return <node> (or just the node on the last line).</div>`;
  document.body.appendChild(panel);

  const code = panel.querySelector(".elem-code");
  const foot = panel.querySelector(".elem-foot");
  code.value = localStorage.getItem(STORAGE) ?? DEFAULT_CODE;
  code.addEventListener("input", () => localStorage.setItem(STORAGE, code.value));

  const setFoot = (text, err = false) => { foot.textContent = text; foot.classList.toggle("err", err); };
  const elementary = createElementary();

  const run = async () => {
    const started = performance.now();
    try {
      setFoot("Running…");
      const { channels } = await elementary.run(code.value);
      setFoot(`Running: ${channels} channel${channels === 1 ? "" : "s"} out to Sonic Pi's input (${Math.round(performance.now() - started)} ms). Edit and Run again: the sound changes without stopping.`);
    } catch (e) {
      setFoot(String(e?.message ?? e), true);
    }
  };
  const stop = async () => {
    try { await elementary.stop(); setFoot("Stopped (silence rendered). Run again to hear it."); }
    catch (e) { setFoot(String(e?.message ?? e), true); }
  };

  panel.addEventListener("click", (ev) => {
    const act = ev.target?.dataset?.act;
    if (act === "run") run();
    else if (act === "stop") stop();
    else if (act === "close") panel.hidden = true;
  });
  openBtn.addEventListener("click", () => { panel.hidden = !panel.hidden; if (!panel.hidden) code.focus(); });
  code.addEventListener("keydown", (ev) => {
    // Ctrl/Cmd+Enter runs, as in the playground; Tab indents instead of leaving the field.
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); run(); }
    else if (ev.key === "Tab") { ev.preventDefault(); const s = code.selectionStart, e2 = code.selectionEnd;
      code.value = code.value.slice(0, s) + "  " + code.value.slice(e2); code.selectionStart = code.selectionEnd = s + 2; }
  });
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
