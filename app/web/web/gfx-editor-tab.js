// The Shadertoy editor tab, written from scratch.
//
// The previous attempt moved the old pane into a tab: an editor that was built for the app's drawer, bundling
// CodeMirror, wired to a renderer that is switched off. It did not work, and it was not worth repairing -- so
// this is a new, self-contained editor with no dependencies at all: documents, a plain text area, compile, save.
// Nothing is imported from the old layer, so nothing about the old layout can break it.
//
// One button, right edge, halfway down, above everything: the editor full-window. The same button, Escape or
// Ctrl/Cmd+Alt+S closes it. A reload is always the audio page (nothing is restored), and on the audio page the
// button is the only thing of ours that exists.
const KEY = "sp-shadertoy-docs";
const STARTER = `// Shadertoy-style shader.
// The render canvas is not wired up yet: compiling checks the code and says so, nothing is drawn.
void mainImage(out vec4 c, in vec2 p) {
    c = vec4(p.x, p.y, 0.5, 1.0);
}
`;

const STYLE = `
  #gfx-editor-btn { position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-index: 99;
    writing-mode: vertical-rl; padding: 12px 6px; cursor: pointer; font: 12px/1 system-ui, sans-serif;
    letter-spacing: .04em; color: var(--WindowForeground); border: 1px solid var(--WindowBorder); border-right: 0;
    border-radius: 8px 0 0 8px; background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); }
  #gfx-editor-btn:hover { background: color-mix(in srgb, var(--WindowBackground) 78%, transparent); }

  #gfx-ed { position: fixed; inset: 0; z-index: 98; display: flex; flex-direction: column;
    background: var(--WindowBackground); color: var(--WindowForeground); font: 13px/1.45 system-ui, sans-serif; }
  body:not([data-gfx-ed="open"]) #gfx-ed { display: none !important; }

  #gfx-ed-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 6px 10px;
    border-bottom: 1px solid var(--WindowBorder); }
  #gfx-ed-head .title { font-weight: 600; }
  #gfx-ed-head .note { opacity: .6; font-size: 12px; }
  #gfx-ed-head .spacer { flex: 1 1 auto; }
  #gfx-ed button { font: 12px/1 system-ui, sans-serif; color: var(--WindowForeground); cursor: pointer;
    background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); border: 1px solid var(--WindowBorder);
    border-radius: 6px; padding: 4px 9px; }
  #gfx-ed button:hover { background: color-mix(in srgb, var(--WindowBackground) 78%, transparent); }
  #gfx-ed button.on { background: #d53; color: #fff; border-color: #d53; }

  #gfx-ed-tabs { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 6px 10px 0; flex-wrap: wrap; }
  #gfx-ed-tabs input { font: inherit; padding: 3px 6px; width: 9em; color: var(--WindowForeground);
    background: transparent; border: 1px solid var(--WindowBorder); border-radius: 6px; }

  #gfx-ed-main { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 8px 10px 10px; gap: 6px; }
  #gfx-ed-code { flex: 1 1 auto; min-height: 0; width: 100%; resize: none; tab-size: 4; white-space: pre;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--WindowForeground);
    background: color-mix(in srgb, var(--WindowBackground) 70%, transparent);
    border: 1px solid var(--WindowBorder); border-radius: 8px; padding: 10px; outline: none; }
  #gfx-ed-code:focus { border-color: #d53; }
  #gfx-ed-say { flex: 0 0 auto; min-height: 1.4em; font: 12px/1.4 ui-monospace, monospace; opacity: .85; white-space: pre-wrap; }
  #gfx-ed-say.bad { color: #f66; opacity: 1; }
`;

export function createEditorTab() {
  if (!document.getElementById("gfx-ed-style")) {
    const style = document.createElement("style");
    style.id = "gfx-ed-style";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  // ── the documents ────────────────────────────────────────────────────────────────────────────────────────
  const load = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
      if (saved?.docs?.length) return saved;
    } catch {}
    return { docs: [{ name: "Image", source: STARTER }], active: 0 };
  };
  const state = load();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
  const active = () => state.docs[state.active] ?? state.docs[0];

  // ── the surface ─────────────────────────────────────────────────────────────────────────────────────────
  const el = document.createElement("div");
  el.id = "gfx-ed";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Shadertoy editor");
  el.innerHTML = `<div id="gfx-ed-head"><span class="title">Shadertoy</span>
      <span class="note">editor only — the render canvas is not wired up yet</span>
      <span class="spacer"></span>
      <button id="gfx-ed-compile" type="button">Compile</button>
      <button id="gfx-ed-close" type="button">Back to audio</button></div>
    <div id="gfx-ed-tabs"></div>
    <div id="gfx-ed-main"><textarea id="gfx-ed-code" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
      <div id="gfx-ed-say"></div></div>`;
  document.body.appendChild(el);

  const tabsEl = el.querySelector("#gfx-ed-tabs");
  const codeEl = el.querySelector("#gfx-ed-code");
  const sayEl = el.querySelector("#gfx-ed-say");
  const say = (text, bad = false) => { sayEl.textContent = text ?? ""; sayEl.classList.toggle("bad", !!bad); };

  function paintTabs() {
    tabsEl.textContent = "";
    state.docs.forEach((d, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = d.name;
      b.className = i === state.active ? "on" : "";
      b.title = "switch to this document";
      b.addEventListener("click", () => { state.active = i; save(); paintTabs(); codeEl.value = active().source; say(""); });
      tabsEl.appendChild(b);
    });
    const name = document.createElement("input");
    name.value = active().name;
    name.title = "this document's name";
    name.addEventListener("change", () => { active().name = name.value.trim() || active().name; save(); paintTabs(); });
    const add = document.createElement("button");
    add.type = "button"; add.textContent = "+"; add.title = "another document";
    add.addEventListener("click", () => {
      state.docs.push({ name: `Shader ${state.docs.length + 1}`, source: STARTER });
      state.active = state.docs.length - 1; save(); paintTabs(); codeEl.value = active().source; codeEl.focus();
    });
    const del = document.createElement("button");
    del.type = "button"; del.textContent = "−"; del.title = "remove this document";
    del.addEventListener("click", () => {
      if (state.docs.length < 2) return say("the last document stays: there has to be something to edit", true);
      state.docs.splice(state.active, 1); state.active = Math.max(0, state.active - 1);
      save(); paintTabs(); codeEl.value = active().source;
    });
    tabsEl.append(name, add, del);
  }

  codeEl.value = active().source;
  codeEl.addEventListener("input", () => { active().source = codeEl.value; save(); });
  codeEl.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {                                   // Tab indents: an editor that cannot indent is a textarea
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = codeEl;
      codeEl.value = `${value.slice(0, a)}    ${value.slice(b)}`;
      codeEl.selectionStart = codeEl.selectionEnd = a + 4;
      active().source = codeEl.value; save();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); compile(); }
  });

  /** Compiling, honestly: the editor checks what it can and says the renderer is not wired up. */
  function compile() {
    const src = active().source;
    const opens = (src.match(/\{/g) ?? []).length, closes = (src.match(/\}/g) ?? []).length;
    if (!/void\s+mainImage\s*\(/.test(src)) return say("no `void mainImage(out vec4 c, in vec2 p)` in this document", true);
    if (opens !== closes) return say(`braces do not balance: ${opens} { against ${closes} }`, true);
    say(`the code looks like a shader (${src.split("\n").length} lines, ${opens} blocks). ` +
        "The render canvas is not wired up yet, so nothing was drawn — the text is saved either way.");
  }
  el.querySelector("#gfx-ed-compile").addEventListener("click", compile);
  el.querySelector("#gfx-ed-close").addEventListener("click", () => set(false));
  paintTabs();

  // ── the button, and the two states ───────────────────────────────────────────────────────────────────────
  const btn = document.createElement("button");
  btn.id = "gfx-editor-btn";
  btn.type = "button";
  btn.textContent = "Shadertoy";
  btn.title = "the shader editor (Ctrl/Cmd+Alt+S) — the render canvas is not wired up yet";
  btn.addEventListener("click", () => set(!open));
  document.body.appendChild(btn);

  let open = false;
  function set(next) {
    if (next === open) return false;
    open = next;
    document.body.dataset.gfxEd = open ? "open" : "closed";
    if (open) { codeEl.value = active().source; paintTabs(); setTimeout(() => codeEl.focus(), 0); }
    return true;
  }
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "s" || e.key === "S")) { e.preventDefault(); e.stopPropagation(); set(!open); }
    else if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); set(false); }
  }, true);

  document.body.dataset.gfxEd = "closed";
  return { el, button: btn, open: () => open, set, toggle: () => set(!open), compile, state };
}
