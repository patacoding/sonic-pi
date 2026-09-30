// SPDX-License-Identifier: AGPL-3.0-or-later
// The SynthDefs section of the extension panel: a LAUNCHER, not an editor.
//
// SuperCollider is not Sonic Pi code, so it does not belong in the buffer the music lives in -- and a text box
// in a settings panel is not an editor either. The writing happens in its own pane (synthdef-pane.js, a
// sibling of the shader pane in the app's drawer); what stays here is what a panel is for: a way in, the
// service's library, and what the service said.
const el = (tag, cls = "", text = null) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * @param {{pane: object, onSay?: (t: string) => void, onProblem?: (t: string) => void}} opts
 *   `pane` is a createSynthdefPane() -- it owns the documents, the compile and the load.
 */
export function createSynthdefs({ pane, onSay = null, onProblem = null } = {}) {
  if (!pane) throw new Error("createSynthdefs needs the pane that does the work (synthdef-pane.js)");
  const say = (t) => (onSay ? onSay(t) : console.info(`Synth — ${t}`));
  const problem = (t) => (onProblem ? onProblem(t) : console.warn(t));
  let statusLine = null, listBox = null, button = null;

  const paint = () => {
    const s = pane.state;
    if (statusLine) {
      statusLine.textContent = [
        s.note,
        s.library,
        s.docs?.length ? `${s.docs.length} document(s) in the editor, active: ${pane.active.name}` : "",
      ].filter(Boolean).join("\n");
      statusLine.classList.toggle("sd-bad", !!s.bad);
    }
    if (listBox) {
      listBox.textContent = "";
      if (!s.defs.length) listBox.appendChild(el("span", "sd-status", "(nothing compiled on the service yet)"));
      for (const d of s.defs) {
        const row = el("div", "sd-def");
        row.appendChild(el("span", "", `${d.name}${d.controls?.length ? ` — ${d.controls.length} controls` : ""}`));
        const load = el("button", "sp-mini-btn", "load & play");
        load.addEventListener("click", () => pane.loadDef(d.name, { play: true, controls: d.controls }));
        row.appendChild(load);
        listBox.appendChild(row);
      }
    }
    if (button) button.textContent = pane.isOpen() ? "close the SynthDef editor" : "open the SynthDef editor";
  };

  function panelSection() {
    const wrap = el("div", "sd-panel");
    const head = el("div", "sd-row");
    button = el("button", "sp-mini-btn", "open the SynthDef editor");
    button.title = "its own editing area in the drawer (Ctrl/Cmd+Enter compiles and plays) — SuperCollider does not go in the music buffer";
    button.addEventListener("click", () => { pane.toggle(); paint(); });
    const refreshBtn = el("button", "sp-mini-btn", "refresh the library");
    refreshBtn.addEventListener("click", () => pane.refresh().then(paint));
    head.append(button, refreshBtn);
    wrap.appendChild(head);

    statusLine = el("div", "sd-status");
    wrap.appendChild(statusLine);
    listBox = el("div", "sd-list");
    wrap.appendChild(listBox);
    wrap.appendChild(el("div", "sd-status", `service: ${pane.state.url} — the editor is its own pane, beside the shader's`));

    pane.onChange(paint);
    paint();
    queueMicrotask(() => pane.refresh().then(paint));
    return { title: "SynthDefs", items: [{ kind: "custom", make: () => wrap }] };
  }

  return {
    panelSection,
    open: () => pane.open(),
    compile: (...a) => pane.compile(...a),
    loadDef: (...a) => pane.loadDef(...a),
    refresh: () => pane.refresh(),
    knownNames: () => pane.knownNames(),
    autoLoadKnown: () => pane.autoLoadKnown(),
    pane,
    get state() { return pane.state; },
  };
}
