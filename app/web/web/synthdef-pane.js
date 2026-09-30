// SPDX-License-Identifier: AGPL-3.0-or-later
// The SynthDef editor: its own pane in the app's bottom drawer, beside the shader pane -- the same shape
// Shadertoy gives code (an editing area of its own, not a text box in a settings panel, and never the Sonic
// Pi buffer the music lives in).
//
// The drawer already has the machinery for this (`body[data-drawer="<pane>"]`, a rail button, a pane in
// `#drawer-panes`), and the shader pane's own classes (`.gfx-ed-*`) are the app's idiom for it, so this pane
// looks like its sibling and behaves like it: rail button, Escape closes, Ctrl/Cmd+Enter acts.
//
// What it edits: a LIST of documents (tabs), each a SuperCollider SynthDef, kept in localStorage. What it
// does with them: sends the active one to the compile service (tools/synthdef-server) over plain HTTP, polls
// the job, and on success loads it with `load_synthdef "<url>"` through the app's session -- and plays a note,
// so that "write it, hear it" is one keystroke.
//
// Verified by tools/synthdefs-ui-probe (jsdom: this pane's wiring) and tools/synthdef-server/probe-browser
// (real Chrome: the pane's compile loaded and SOUNDED, peak 0.2337 at C4).
const SERVICE_DEFAULT = "http://127.0.0.1:8461";
const DOCS_KEY = "sp-synthdef-docs";
const ACTIVE_KEY = "sp-synthdef-active";
const URL_KEY = "sp-synthdef-url";
const STYLE_ID = "gfx-synthdef-style";

export const SYNTHDEF_PANE = "gfx-synthdef";

export const EXAMPLE = `// A SynthDef, in its own editor. Ctrl/Cmd+Enter compiles it and plays a note.
// Conventions worth keeping: a control named \`cutoff\` is a MIDI NOTE (0-130), not Hz (hence .midicps), and
// a def with \`gate\` is what lets Sonic Pi's \`sustain:\`/\`release:\` work.
SynthDef(\\spfm, { |out = 0, note = 60, amp = 0.3, ratio = 2, index = 3, cutoff = 110, release = 0.6, gate = 1|
    var freq = note.midicps;
    var mod  = SinOsc.ar(freq * ratio, 0, freq * ratio * index);
    var env  = EnvGen.kr(Env.asr(0.01, 1, release), gate, doneAction: 2);
    var sig  = RLPF.ar(SinOsc.ar(freq + mod) * 0.5, cutoff.midicps, 0.4);
    Out.ar(out, Pan2.ar(sig * env * amp, 0));
}).add;
`;

const el = (tag, cls = "", text = null) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/**
 * A small SuperCollider highlighter, for the underlay behind the textarea. It is not a parser: comments,
 * strings, symbols, numbers, `|arguments|` and capitalised class names (UGens) -- enough that a def reads
 * like code instead of like a wall of text, with no build step and no editor bundle in the way.
 */
export function highlightSC(code) {
  // ONE pass, with the alternatives in priority order. Chained `.replace()` calls re-scan the markup an
  // earlier call inserted (a comment's own `class="c"` came out as a "string"), which is how this was written
  // first and why it is written this way now.
  const RE = /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|(\\(?!\s)[A-Za-z_][\w]*)|(\|[^|\n]*\|)|(\b\d+\.?\d*\b)|(\b[A-Z][A-Za-z0-9_]*\b)|(\b(?:var|arg|this|super|nil|true|false)\b)/g;
  return esc(code).replace(RE, (m, comment, str, sym, args, number, ugen, keyword) => {
    if (comment) return `<i class="c">${comment}</i>`;
    if (str) return `<i class="s">${str}</i>`;
    if (sym) return `<i class="y">${sym}</i>`;
    if (args) return `<i class="a">${args}</i>`;
    if (number) return `<i class="n">${number}</i>`;
    if (ugen) return `<i class="u">${ugen}</i>`;
    if (keyword) return `<i class="k">${keyword}</i>`;
    return m;
  });
}

/**
 * @param {{service?: string, session?: object, onSay?: (t: string) => void, onProblem?: (t: string) => void,
 *          store?: Storage, fetchImpl?: typeof fetch}} opts
 */
export function createSynthdefPane({
  service = SERVICE_DEFAULT, session = null, onSay = null, onProblem = null,
  store = globalThis.localStorage ?? null, fetchImpl = globalThis.fetch?.bind(globalThis) ?? null,
} = {}) {
  const say = (t) => (onSay ? onSay(t) : console.info(`Synth — ${t}`));
  const problem = (t) => (onProblem ? onProblem(t) : console.warn(t));
  const read = (k, d) => { try { return store?.getItem(k) ?? d; } catch { return d; } };
  const write = (k, v) => { try { store?.setItem(k, v); } catch { /* private mode */ } };

  const state = {
    url: (read(URL_KEY, service) || service).replace(/\/+$/, ""),
    note: "", library: "the service is not running",
    bad: false, busy: false, defs: [],
    docs: null, activeId: read(ACTIVE_KEY, null),
  };
  const listeners = new Set();
  const changed = () => { for (const f of listeners) { try { f(state); } catch { /* a listener must not break the pane */ } } };

  // ── documents (the tabs) ────────────────────────────────────────────────────────────────────────────────
  function loadDocs() {
    let docs = null;
    try { docs = JSON.parse(read(DOCS_KEY, "null")); } catch { docs = null; }
    if (!Array.isArray(docs) || !docs.length) docs = [{ id: "d1", name: "fm", source: EXAMPLE }];
    if (!docs.some((d) => d.id === state.activeId)) state.activeId = docs[0].id;
    state.docs = docs;
    return docs;
  }
  const active = () => state.docs.find((d) => d.id === state.activeId) ?? state.docs[0];
  const saveDocs = () => { write(DOCS_KEY, JSON.stringify(state.docs)); write(ACTIVE_KEY, state.activeId); };
  loadDocs();

  const sessionOf = () => session ?? globalThis.sonicPi?.session ?? null;
  const api = (p) => `${state.url}${p}`;
  const setNote = (t, bad = false) => { state.note = t; state.bad = bad; paint(); changed(); };
  const setLibrary = (t, bad = false) => { state.library = t; state.bad = bad; paint(); changed(); };

  /** A short note to play after a compile, built ONLY from controls the def has (Sonic Pi validates them). */
  function auditionLine(name, controls = []) {
    const has = (c) => controls.includes(c);
    const opts = [];
    if (has("note")) opts.push("note: 60");
    if (has("amp")) opts.push("amp: 0.6");
    if (has("gate")) opts.push("sustain: 1.5");
    if (has("release")) opts.push("release: 0.4");
    return `synth :${name}${opts.length ? `, ${opts.join(", ")}` : ""}\nsleep 3\n`;
  }

  async function refresh() {
    if (!fetchImpl) return false;
    try {
      const r = await fetchImpl(api("/defs"));
      if (!r.ok) throw new Error(`the service answered ${r.status}`);
      state.defs = (await r.json()).defs ?? [];
      setLibrary(`${state.defs.length} def(s) on ${state.url}${state.defs.length ? "" : " — compile one below"}`);
      return true;
    } catch (e) {
      setLibrary(`no answer from ${state.url} (${e.message ?? e}). Start it with tools/synthdef-server/service.sh start`, true);
      return false;
    }
  }

  /** Compile the active document (or `code`), then load it, then -- by default -- play a note. */
  async function compile(code = null, { play = true } = {}) {
    const src = code ?? codeEl?.value ?? active().source;
    if (!src.trim()) { setNote("nothing to compile: write a SynthDef first", true); return null; }
    active().source = src;
    saveDocs();
    if (!fetchImpl) { setNote("this browser cannot fetch", true); return null; }
    state.busy = true;
    try {
      setNote("compiling…");
      const posted = await fetchImpl(api("/compile"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: src }),
      });
      if (posted.status === 400) {
        const e = await posted.json().catch(() => ({}));
        setNote(`the service refused it: ${e.error ?? posted.status}`, true);
        return null;
      }
      if (!posted.ok && posted.status !== 202) { setNote(`the service answered ${posted.status}`, true); return null; }
      let job = await posted.json();
      if (posted.status === 202) {
        for (let i = 0; i < 80 && job.state !== "done" && job.state !== "error"; i++) {
          await new Promise((r) => setTimeout(r, 250));
          const r = await fetchImpl(api(`/jobs/${job.job}`));
          if (!r.ok) { setNote(`the job disappeared (${r.status})`, true); return null; }
          job = await r.json();
          if (job.state === "compiling") setNote("compiling… (sclang is working)");
        }
      }
      if (job.state === "error") {
        const e = job.error ?? { message: "unknown error" };
        const extra = (e.sclang ?? []).join("\n");
        setNote(`${e.message ?? "compile failed"}${extra ? `\n${extra}` : ""}`, true);
        problem(`the SynthDef did not compile: ${e.message ?? "unknown error"}`);
        return null;
      }
      if (job.state !== "done") { setNote(`the job did not finish (${job.state})`, true); return null; }
      const names = (job.defs ?? []).map((d) => d.name);
      setNote(`compiled ${names.join(", ")}${job.cached ? " (from the cache)" : ""}${job.defs?.[0]?.bytes ? ` — ${job.defs[0].bytes} B` : ""}`);
      say(`compiled ${names.join(", ")}${job.cached ? " (from the cache)" : ""}`);
      await refresh();
      for (const d of job.defs ?? []) if (d.url) await loadDef(d.name, { play, controls: d.controls });
      return job;
    } catch (e) {
      setNote(`the service is not reachable at ${state.url} (${e.message ?? e})`, true);
      return null;
    } finally {
      state.busy = false;
      changed();
    }
  }

  /** `load_synthdef "<url>"`, through the app's own session (the path probe-browser measures). */
  async function loadDef(name, { play = false, controls = null } = {}) {
    const s = sessionOf();
    if (!s?.run) {
      setNote(`cannot load ${name}: the session is not available yet -- press Run once, then load again`, true);
      problem(`cannot load ${name}: the session is not available (press Run once)`);
      return false;
    }
    try {
      const known = controls ?? state.defs.find((d) => d.name === name)?.controls ?? [];
      const line = `load_synthdef "${api(`/defs/${name}.scsyndef`)}"\nsleep 0.25\n` + (play ? auditionLine(name, known) : "");
      await s.run(line);
      setNote(`loaded ${name}${play ? " and played a note" : ""}: it is registered, so \`synth :${name}\` works now`);
      say(`loaded ${name}${play ? " and auditioned it" : ""} (its .json beside it gives the Docs page and the knobs)`);
      return true;
    } catch (e) {
      setNote(`could not load ${name}: ${e.message ?? e}`, true);
      return false;
    }
  }

  // ── the pane ────────────────────────────────────────────────────────────────────────────────────────────
  let pane = null, railButton = null, codeEl = null, hlEl = null, docsEl = null, noteEl = null, libEl = null, listEl = null;

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    // the drawer's own rules, for a pane it does not know about -- exactly as the shader pane does it
    style.textContent = `
body[data-drawer="${SYNTHDEF_PANE}"] #main { grid-template-rows: minmax(80px, 1fr) 6px var(--drawer-size); }
body[data-drawer="${SYNTHDEF_PANE}"] #drawer { display: flex; }
#gfx-synthdef-pane { display: none; flex: 1; min-width: 0; min-height: 0; flex-direction: column;
  background: var(--PaneBackground); color: var(--WindowForeground); }
body[data-drawer="${SYNTHDEF_PANE}"] #gfx-synthdef-pane { display: flex; }
.sd-code-wrap { position: relative; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
.sd-hl, .sd-code { position: absolute; inset: 0; margin: 0; padding: 8px 10px; border: 0; overflow: auto;
  font: var(--t-small, 12px)/1.45 var(--code-font, monospace); white-space: pre; tab-size: 4; }
.sd-hl { pointer-events: none; color: var(--WindowForeground); }
.sd-code { background: transparent; color: transparent; caret-color: var(--WindowForeground); resize: none; }
.sd-hl i { font-style: normal; }
.sd-hl i.c { color: var(--faintText, #7a7); }
.sd-hl i.s { color: var(--accentContrastText, #d9a); }
.sd-hl i.y { color: var(--HighlightedBackground, #8cf); }
.sd-hl i.a { color: var(--mutedForeground, #aa8); }
.sd-hl i.n { color: var(--DefaultForeground, #ccf); }
.sd-hl i.u { color: var(--HighlightedBackground, #8cf); font-weight: 600; }
.sd-hl i.k { color: var(--ErrorBackground, #e88); }
.sd-side { flex-shrink: 0; width: 240px; min-height: 0; overflow: auto; border-left: 1px solid var(--WindowBorder); padding: 6px 8px 10px; }
.sd-def { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
.sd-def span { flex: 1; min-width: 0; font: var(--t-tiny, 11px) var(--code-font); overflow: hidden; text-overflow: ellipsis; }
.sd-defstatus { font: var(--t-tiny, 11px)/1.5 var(--code-font); white-space: pre-wrap; margin-bottom: 8px; }
.sd-defstatus.bad { color: var(--ErrorBackground); }`;
    document.head.appendChild(style);
  }

  function paint() {
    if (noteEl) { noteEl.textContent = state.note; noteEl.classList.toggle("bad", state.bad); }
    if (libEl) { libEl.textContent = state.library; libEl.classList.toggle("bad", state.bad && !state.note); }
    if (listEl) {
      listEl.textContent = "";
      if (!state.defs.length) listEl.appendChild(el("div", "gfx-ed-note", "(nothing compiled yet)"));
      for (const d of state.defs) {
        const row = el("div", "sd-def");
        row.appendChild(el("span", "", d.name));
        const load = el("button", "gfx-ed-btn", "load");
        load.addEventListener("click", () => loadDef(d.name, { play: true, controls: d.controls }));
        row.appendChild(load);
        listEl.appendChild(row);
      }
    }
    if (docsEl) {
      docsEl.textContent = "";
      for (const d of state.docs) {
        const b = el("button", `gfx-ed-doc${d.id === state.activeId ? " on" : ""}`);
        b.appendChild(el("span", "", d.name));
        b.addEventListener("click", () => { state.activeId = d.id; saveDocs(); paint(); if (codeEl) { codeEl.value = d.source; syncHighlight(); } });
        const x = el("span", "x", "×");
        x.title = "remove this document";
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          if (state.docs.length === 1) return;
          state.docs = state.docs.filter((o) => o.id !== d.id);
          if (state.activeId === d.id) state.activeId = state.docs[0].id;
          saveDocs(); paint();
          if (codeEl) { codeEl.value = active().source; syncHighlight(); }
        });
        b.appendChild(x);
        docsEl.appendChild(b);
      }
      const add = el("button", "gfx-ed-doc gfx-ed-add", "+");
      add.title = "a new SynthDef document";
      add.addEventListener("click", () => {
        const id = `d${Date.now().toString(36)}`;
        state.docs.push({ id, name: `synth${state.docs.length + 1}`, source: "SynthDef(\\new, { |out = 0, note = 60, amp = 0.3, gate = 1|\n    var env = EnvGen.kr(Env.asr(0.01, 1, 0.5), gate, doneAction: 2);\n    Out.ar(out, SinOsc.ar(note.midicps) * env * amp);\n}).add;\n" });
        state.activeId = id;
        saveDocs(); paint();
        if (codeEl) { codeEl.value = active().source; syncHighlight(); codeEl.focus(); }
      });
      docsEl.appendChild(add);
    }
  }

  function syncHighlight() {
    if (hlEl && codeEl) { hlEl.innerHTML = highlightSC(codeEl.value) + "\n"; hlEl.scrollTop = codeEl.scrollTop; hlEl.scrollLeft = codeEl.scrollLeft; }
  }

  function build() {
    installStyle();
    pane = el("div");
    pane.id = "gfx-synthdef-pane";

    const head = el("div", "gfx-ed-head");
    head.appendChild(el("strong", "", "SynthDefs"));
    const compilePlay = el("button", "gfx-ed-btn primary", "compile & play");
    compilePlay.title = "compile the active document, load it, and play a note (Ctrl/Cmd+Enter)";
    compilePlay.addEventListener("click", () => compile(null, { play: true }));
    const compileOnly = el("button", "gfx-ed-btn", "compile");
    compileOnly.addEventListener("click", () => compile(null, { play: false }));
    const reload = el("button", "gfx-ed-btn", "reload");
    reload.title = "load the active document without compiling (it must have been compiled before)";
    reload.addEventListener("click", () => {
      // the def's name is the one the service last reported for this source; the library list is the truth
      const name = state.defs[0]?.name ?? active().name;
      loadDef(name, { play: true, controls: state.defs.find((d) => d.name === name)?.controls });
    });
    head.append(compilePlay, compileOnly, reload, el("span", "gfx-ed-spacer"));
    noteEl = el("div", "gfx-ed-say");
    head.appendChild(noteEl);
    pane.appendChild(head);

    docsEl = el("div", "gfx-ed-docs");
    pane.appendChild(docsEl);

    const body = el("div", "gfx-ed-body");
    const wrap = el("div", "sd-code-wrap gfx-ed-code");
    hlEl = el("pre", "sd-hl");
    hlEl.setAttribute("aria-hidden", "true");
    codeEl = el("textarea", "sd-code");
    codeEl.spellcheck = false;
    codeEl.value = active().source;
    codeEl.addEventListener("input", () => { active().source = codeEl.value; saveDocs(); syncHighlight(); });
    codeEl.addEventListener("scroll", syncHighlight);
    codeEl.addEventListener("keydown", (e) => {
      e.stopPropagation();                                   // the app's shortcuts are not for this area
      if (e.key === "Escape") { close(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); compile(null, { play: true }); return; }
      if (e.key === "Tab") {                                   // a Tab must indent, not move focus
        e.preventDefault();
        const at = codeEl.selectionStart;
        codeEl.setRangeText("    ", at, codeEl.selectionEnd, "end");
        active().source = codeEl.value; saveDocs(); syncHighlight();
      }
    });
    wrap.append(hlEl, codeEl);
    body.appendChild(wrap);

    const side = el("div", "gfx-ed-side");
    const st = el("div", "sd-defstatus"); noteEl = noteEl;           // the pane's own status lives in the head
    st.textContent = "";
    side.appendChild(el("div", "gfx-ed-note", "The service compiles SuperCollider into a def the engine loads. `synth :name` then works in your music."));
    libEl = st;
    side.appendChild(st);
    side.appendChild(el("div", "gfx-ed-note", "Compiled defs"));
    listEl = el("div");
    side.appendChild(listEl);
    body.appendChild(side);
    pane.appendChild(body);

    const panes = document.getElementById("drawer-panes");
    if (panes) panes.appendChild(pane); else document.body.appendChild(pane);

    const rail = document.getElementById("drawer-rail");
    if (rail) {
      railButton = el("button", "drawer-button");
      railButton.dataset.drawer = SYNTHDEF_PANE;
      railButton.title = "SynthDefs — write SuperCollider and hear it";
      railButton.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">` +
        `<path fill="none" stroke="currentColor" stroke-width="2" d="M2 14c2.5 0 2.5-8 5-8s2.5 12 5 12 2.5-8 5-8 2.5 4 5 4"/></svg>`;
      railButton.addEventListener("click", () => toggle());
      rail.appendChild(railButton);
    }
    paint();
    syncHighlight();
    queueMicrotask(() => refresh());
  }

  const isOpen = () => document.body?.dataset.drawer === SYNTHDEF_PANE;
  function open() {
    if (!pane) build();
    document.body.dataset.drawer = SYNTHDEF_PANE;
    for (const b of document.querySelectorAll("#drawer-rail [data-drawer]")) b.classList.toggle("on", b.dataset.drawer === SYNTHDEF_PANE);
    codeEl?.focus();
    return true;
  }
  function close() {
    if (!isOpen()) return false;
    document.body.dataset.drawer = "";
    document.body.classList.remove("panel-open");
    for (const b of document.querySelectorAll("#drawer-rail [data-drawer]")) b.classList.toggle("on", false);
    return true;
  }
  const toggle = () => (isOpen() ? close() : open());

  return {
    open, close, toggle, isOpen,
    compile, loadDef, refresh,
    get state() { return { ...state, status: [state.note, state.library].filter(Boolean).join("\n") }; },
    get active() { return { ...active() }; },
    get documents() { return state.docs.map((d) => ({ ...d })); },
    setSource(code) { active().source = code; saveDocs(); if (codeEl) { codeEl.value = code; syncHighlight(); } },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    highlightSC,
    EXAMPLE,
  };
}

export const SYNTHDEF_SERVICE_DEFAULT = SERVICE_DEFAULT;
