// SPDX-License-Identifier: AGPL-3.0-or-later
// The shader pane: the tabs, the channel pickers, the compile button and the report. Shadertoy's
// editor, which the user asked for, with the one addition live playing needs -- several documents,
// switched during a performance.
//
// Where it sits. Sonic Pi's own bottom drawer already has the machinery for "a pane, opened from the
// rail, sharing the space with the code": the drawer is shown by `body[data-drawer="<pane>"]`, and
// the rail's lit icon, the title and the height all follow from that one attribute. So this puts a
// button in the rail and a pane in `#drawer-panes`, and sets that attribute -- which is the whole of
// the coupling. It is not `setPanel`, which is private to app.js: this button is added after app.js
// has run and collected its rail listeners, so it has none of its own, and its state is this file's.
// Opening another pane from the rail overwrites the attribute and this one closes, correctly.
//
// What is NOT here: the editing surface. CodeMirror is bundled (web/gfx-editor/entry.js) and is
// imported the first time the pane is actually opened, so a performance that never opens the editor
// never downloads it. Until it arrives the pane says so; if the bundle was never built, it says that
// instead of failing silently.
//
// The rule from gfx-document.js carries through every control here: code is saved, pictures are not.
// Uploading a picture puts it in this session's textures and nowhere else, and a document loaded
// from storage says which picture it wants rather than carrying one.
import { PASS_ORDER, SHARED, CHANNELS, BUFFER_PASSES, emptySet, uniqueName, serializeSet, deserializeSet, deserialize, emptyDocument, missingImages, wantedImages, channelsWerePerPass } from "./gfx-document.js";

export const PANE = "gfx-shader";
const STYLE_ID = "gfx-editor-style";
const OPEN_KEY = "sp-gfx-editor-open";      // whether the pane was open when the page was left
const SET_KEY = "sp-gfx-documents";         // the documents, and which one was on screen
const ONE_KEY = "sp-gfx-document";          // the single document this replaced, still read once

const TABS = [SHARED, ...PASS_ORDER];        // Common first, as Shadertoy has it, then the buffers, then Image

/**
 * Which document a `:document` order means. Pure, and here rather than in gfx.js, because "next" is
 * a fact about the set rather than about the layer that reads the line -- and because the wrapping is
 * the part worth pinning: an order that silently does nothing mid-performance is worse than one that
 * says it could not.
 *
 * @returns {{name: string} | {error: string}}
 */
export function resolveDocument(names, current, arg) {
  if (!names?.length) return { error: "there are no documents to switch to" };
  const wanted = String(arg ?? "").trim();
  const here = Math.max(0, names.indexOf(current));
  if (/^(next|\+)$/i.test(wanted)) return { name: names[(here + 1) % names.length] };
  if (/^(prev|previous|-)$/i.test(wanted)) return { name: names[(here - 1 + names.length) % names.length] };
  if (!names.includes(wanted)) return { error: `there is no document called "${wanted}" — there is ${names.map((n) => `"${n}"`).join(", ")}` };
  return { name: wanted };
}

/** Tab labels: the pass names are the document's, but a tab has to fit. */
const tabLabel = (name) => (name === SHARED ? "Common" : name === "Image" ? "Image" : name.replace("Buffer ", ""));

const style = () => {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  // The drawer's own rules, for a pane it does not know about (style.css names each of its panes).
  // Both lines are needed: the first gives the drawer the space under the code, the second shows it.
  el.textContent = `
body[data-drawer="${PANE}"] #main { grid-template-rows: minmax(80px, 1fr) 6px var(--drawer-size); }
body[data-drawer="${PANE}"] #drawer { display: flex; }
#gfx-shader-pane { display: none; flex: 1; min-width: 0; min-height: 0; flex-direction: column; background: var(--PaneBackground); color: var(--WindowForeground); }
body[data-drawer="${PANE}"] #gfx-shader-pane { display: flex; }

.gfx-ed-head { display: flex; align-items: center; gap: 8px; padding: 4px 8px 4px 6px; flex-shrink: 0; min-width: 0; }
.gfx-ed-docs { display: flex; align-items: center; gap: 3px; padding: 4px 8px 0 6px; flex-shrink: 0; overflow-x: auto; }
.gfx-ed-doc { display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px; border: none; border-bottom: 2px solid transparent; background: none; color: var(--softForeground, var(--Foreground)); font: 500 var(--t-tiny, 12px) var(--code-font); cursor: pointer; white-space: nowrap; }
.gfx-ed-doc:hover { color: var(--WindowForeground); }
.gfx-ed-doc.on { color: var(--WindowForeground); border-bottom-color: var(--HighlightedBackground); font-weight: 700; }
.gfx-ed-doc .x { color: var(--faintText, var(--mutedForeground)); padding: 0 1px; border-radius: 2px; }
.gfx-ed-doc .x:hover { color: var(--accentContrastText); background: var(--ErrorBackground); }
.gfx-ed-add { font-weight: 700; padding: 2px 6px; }
.gfx-ed-docbtns { display: flex; gap: 4px; margin-bottom: 4px; }
.gfx-ed-rename { width: 9em; background: var(--Background); color: var(--DefaultForeground, var(--Foreground)); border: 1px solid var(--HighlightedBackground); border-radius: var(--r-s, 3px); font: 500 var(--t-tiny, 12px) var(--code-font); padding: 1px 4px; }
.gfx-ed-tabs { display: flex; gap: 2px; flex-shrink: 0; }
.gfx-ed-tab { position: relative; padding: 3px 9px; border: none; border-radius: var(--r-s, 3px); background: var(--Tab); color: var(--TabText); font: 500 var(--t-tiny, 11px) var(--code-font); cursor: pointer; }
.gfx-ed-tab.off { opacity: 0.55; }
.gfx-ed-tab.on { background: var(--TabSelected); color: var(--tabSelectedText); }
.gfx-ed-tab .dot { position: absolute; top: 1px; right: 2px; color: var(--ErrorBackground); font-size: 0.9em; line-height: 1; }
.gfx-ed-spacer { flex: 1; min-width: 0; }
.gfx-ed-say { font: var(--t-tiny, 11px) var(--code-font); color: var(--mutedForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gfx-ed-say.bad { color: var(--ErrorBackground); }
.gfx-ed-btn { padding: 3px 10px; border: 1px solid var(--WindowBorder); border-radius: var(--r-s, 3px); background: var(--subtleFill, var(--PaneBackground)); color: var(--WindowForeground); font: 500 var(--t-tiny, 11px) var(--code-font); cursor: pointer; }
.gfx-ed-btn:hover { background: var(--HighlightedBackground); color: var(--accentContrastText); }
.gfx-ed-btn.primary { border-color: var(--HighlightedBackground); }

.gfx-ed-body { flex: 1; min-height: 0; display: flex; }
.gfx-ed-code { flex: 1; min-width: 0; min-height: 0; display: flex; overflow: hidden; }
.gfx-ed-code > * { flex: 1; min-width: 0; }
.gfx-ed-wait { padding: 10px 12px; font: var(--t-small, 12px) var(--code-font); color: var(--mutedForeground); }

.gfx-ed-side { flex-shrink: 0; width: 264px; min-height: 0; overflow: auto; border-left: 1px solid var(--WindowBorder); padding: 6px 8px 10px; }
.gfx-ed-note { font: var(--t-tiny, 11px) var(--code-font); color: var(--faintText, var(--mutedForeground)); margin: 2px 0 8px; }
.gfx-ed-chan { display: flex; align-items: center; gap: 4px; margin-bottom: 3px; }
.gfx-ed-chan-n { width: 4.9em; flex-shrink: 0; font: var(--t-tiny, 11px) var(--code-font); color: var(--mutedForeground); }
.gfx-ed-chan select { flex: 1; min-width: 0; background: var(--Background); color: var(--DefaultForeground, var(--Foreground)); border: 1px solid var(--WindowBorder); border-radius: var(--r-s, 3px); font: var(--t-tiny, 11px) var(--code-font); }
.gfx-ed-chan.over { outline: 1px dashed var(--HighlightedBackground); outline-offset: 1px; }
.gfx-ed-pick { padding: 0 5px; line-height: 1.5; flex-shrink: 0; }
.gfx-ed-chan-prev { display: inline-flex; align-items: center; justify-content: center; width: 2.4em; height: 1.5em; font: var(--t-tiny, 11px) var(--code-font); color: var(--mutedForeground); flex-shrink: 0; }
/* THE picture of a channel, and the only place a picture is drawn: one size, so one picture never
   appears as a big one and a small one side by side */
.gfx-ed-thumb-sm { width: 2.4em; height: 1.5em; object-fit: cover; border-radius: 2px; background: var(--PaneBackground); }
.gfx-ed-forget { padding: 0 5px; line-height: 1.5; flex-shrink: 0; }
.gfx-ed-forget:hover { border-color: var(--ErrorBackground); color: var(--ErrorBackground); }
.gfx-ed-report { margin-top: 8px; }
.gfx-ed-rep { border-left: 2px solid var(--ErrorBackground); padding: 2px 0 2px 6px; margin-bottom: 6px; }
.gfx-ed-rep-pass { font: 600 var(--t-tiny, 11px) var(--code-font); }
.gfx-ed-line { display: block; width: 100%; text-align: left; border: none; background: none; color: var(--softForeground, var(--Foreground)); font: var(--t-tiny, 11px) var(--code-font); padding: 1px 0; cursor: pointer; }
.gfx-ed-line:hover { background: var(--HighlightedBackground); color: var(--accentContrastText); }
.gfx-ed-ok { font: var(--t-tiny, 11px) var(--code-font); color: var(--mutedForeground); }
.gfx-ed-h { font: 600 var(--t-tiny, 11px) var(--code-font); color: var(--faintText, var(--mutedForeground)); margin: 10px 0 4px; text-transform: uppercase; letter-spacing: 0.04em; }
`;
  document.head.appendChild(el);
};

/** The rail's glyph: a picture frame, next to the app's own icons (which are tabler's, 24x24, stroked). */
const railIcon = () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.innerHTML = `<path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z"/><path d="M3 15l4 -4a2 2 0 0 1 3 0l2 2a2 2 0 0 0 3 0l2 -2a2 2 0 0 1 3 0l4 4"/><path d="M8 8.5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/>`;
  return svg;
};

/**
 * @param {{compile: (doc) => object, canvas: () => object, starter?: () => string, log?: (text) => void}} hooks
 *   `compile` is gfx.js's: it compiles a document and returns the renderer's result.
 *   `canvas` is read late (the GL canvas arrives after the audio is attached), so it is a function.
 *   `starter` is the code a NEW document begins with (web/gfx-shader.frag, in gfx.js).
 */
export function createShaderPane({ compile, canvas, starter, log }) {
  style();

  // ── the rail button and the drawer pane ─────────────────────────────────────────────────────────
  const rail = document.getElementById("drawer-rail");
  const button = document.createElement("button");
  button.dataset.drawer = PANE;
  button.title = "Shader: the code behind the picture";
  button.setAttribute("aria-label", "Shader");
  button.appendChild(railIcon());
  rail.appendChild(button);

  const el = document.createElement("div");
  el.id = "gfx-shader-pane";
  el.setAttribute("aria-label", "Shader editor");
  document.getElementById("drawer-panes").appendChild(el);

  const head = document.createElement("div");
  head.className = "gfx-ed-head";
  const tabsEl = document.createElement("span");
  tabsEl.className = "gfx-ed-tabs";
  const spacer = document.createElement("span");
  spacer.className = "gfx-ed-spacer";
  const sayEl = document.createElement("span");
  sayEl.className = "gfx-ed-say";
  const compileBtn = document.createElement("button");
  compileBtn.className = "gfx-ed-btn primary";
  compileBtn.textContent = "Compile";
  compileBtn.title = "Compile every pass that has code (Alt-Enter). A pass that fails keeps the one that is running.";
  head.append(tabsEl, spacer, sayEl, compileBtn);

  // the documents: the row above the passes' tabs, since a document is what holds the passes
  const docsEl = document.createElement("div");
  docsEl.className = "gfx-ed-docs";

  const body = document.createElement("div");
  body.className = "gfx-ed-body";
  const codeHost = document.createElement("div");
  codeHost.className = "gfx-ed-code";
  const side = document.createElement("div");
  side.className = "gfx-ed-side";
  body.append(codeHost, side);
  el.append(docsEl, head, body);

  const note = (text, cls = "") => { const p = document.createElement("div"); p.className = `gfx-ed-note ${cls}`.trim(); p.textContent = text; return p; };
  const heading = (text) => { const p = document.createElement("div"); p.className = "gfx-ed-h"; p.textContent = text; return p; };

  // ── state ───────────────────────────────────────────────────────────────────────────────────────
  let editor = null;                 // the CodeMirror surface, once it has been imported
  let loading = null;                // the import, so two opens are one import
  let set = null;                    // every document there is, and which one is on screen
  let doc = null;                    // the document being edited (the set's current one)
  let tab = SHARED;                  // the tab on screen
  const pictures = new Map();        // name → the picture, THIS SESSION ONLY (never saved)
  let report = null;                 // the last compile's result

  const say = (text, bad = false) => { sayEl.textContent = text; sayEl.classList.toggle("bad", bad); };
  const canvasNow = () => canvas();

  // ── the documents ───────────────────────────────────────────────────────────────────────────────
  // A set: several documents, and the one on screen. Switching is the point of having them -- it is
  // how the look changes mid-performance -- so a switch compiles the document it arrives at, and a
  // switch that will not compile leaves the picture that was running alone (gfx-program.js's rule)
  // with the report saying why.

  const save = () => {
    if (!set || !doc) return;
    const now = collect();
    const at = set.documents.findIndex((d) => d.name === now.name);
    // a document the set has not got is added rather than dropped: that is how "reset to the default
    // shader" puts a document back, and a set whose current names nothing comes back on the wrong one
    if (at < 0) set.documents.push(now);
    else set.documents[at] = now;
    set.current = now.name;
    try { localStorage.setItem(SET_KEY, serializeSet(set)); } catch {}
  };

  /** The stored set, or one document made by `fallback` if nothing was ever stored. */
  function load(fallback) {
    let stored = null;
    try {
      stored = deserializeSet(localStorage.getItem(SET_KEY) ?? "");
      // one document, the way the first version of this stored it: taken in rather than dropped
      if (!stored) {
        const one = localStorage.getItem(ONE_KEY);
        const d = one ? deserialize(one) : null;
        if (d) stored = emptySet(d);
      }
    } catch { stored = null; }
    set = stored ?? emptySet(fallback());
    doc = set.documents.find((d) => d.name === set.current) ?? set.documents[0];
    // the channels used to belong to each pass; if an older document wired one channel NUMBER
    // differently in different passes, collapsing it onto the document's four lost the difference --
    // so it is said rather than going quietly missing
    try {
      const raw = JSON.parse(localStorage.getItem(SET_KEY) ?? "null");
      if (raw?.documents?.some?.(channelsWerePerPass)) {
        log?.("Graphics — this document's channels used to be per pass. There is one set of iChannels now, so the wiring Image had was kept; check the others if a picture changed.");
      }
    } catch {}
    return doc;
  }

  // ── the report ──────────────────────────────────────────────────────────────────────────────────
  const reportEl = document.createElement("div");
  reportEl.className = "gfx-ed-report";

  /** Every diagnostic a failure carries, as the editor wants it: one tab's lines at a time. */
  const marksFor = (failures) => {
    const byTab = new Map(TABS.map((t) => [t, []]));
    const loose = [];
    for (const f of failures) {
      for (const d of f.diagnostics ?? []) {
        const tabName = d.where === "common" ? SHARED : d.where === "pass" ? f.pass : null;
        const mark = { line: d.line, message: d.message, severity: d.severity ?? "error" };
        // a line inside the prelude, or output the driver gave with no line at all: listed, not marked
        if (tabName && byTab.has(tabName) && Number.isInteger(d.line)) byTab.get(tabName).push(mark);
        else loose.push({ pass: f.pass, ...mark, line: null });
      }
    }
    return { byTab, loose };
  };

  function paintReport() {
    reportEl.textContent = "";
    reportEl.appendChild(heading("Compile"));
    if (!report) { reportEl.appendChild(note("Not compiled yet.")); return; }
    const { failures, compiled } = report;
    if (!failures.length) {
      reportEl.appendChild(Object.assign(document.createElement("div"), { className: "gfx-ed-ok", textContent: `All good: ${compiled.join(", ") || "nothing to compile"}.` }));
      return;
    }
    const { loose } = marksFor(failures);
    for (const f of failures) {
      const box = document.createElement("div");
      box.className = "gfx-ed-rep";
      box.appendChild(Object.assign(document.createElement("div"), { className: "gfx-ed-rep-pass", textContent: `${f.pass} — ${f.where === "link" ? "did not link" : "did not compile"}` }));
      for (const d of f.diagnostics ?? []) {
        const line = document.createElement("button");
        line.className = "gfx-ed-line";
        line.textContent = d.where === "common" ? `Common, line ${d.line}: ${d.message}`
          : d.where === "pass" ? `line ${d.line}: ${d.message}`
          : d.message;
        // a line that is the player's to fix is a line to go to; one inside the prelude is not
        if (d.line && (d.where === "pass" || d.where === "common")) line.addEventListener("click", () => show(d.where === "common" ? SHARED : f.pass, d.line));
        else line.disabled = true;
        box.appendChild(line);
      }
      reportEl.appendChild(box);
    }
    if (loose.length) reportEl.appendChild(note("Some of the driver's output names no line of yours to go to; it is in the Log as well."));
  }

  // ── the editor's text ───────────────────────────────────────────────────────────────────────────
  const textOf = (which) => (editor ? editor.code(which) : (doc ? (which === SHARED ? doc.common : doc.passes[which] ?? "") : ""));

  /** What the editor says the document is, channels included. */
  const collect = () => ({
    ...doc,
    name: doc?.name ?? "Untitled",
    common: textOf(SHARED),
    passes: Object.fromEntries(PASS_ORDER.map((p) => [p, textOf(p)])),
    channels: [...chanRefs],
  });

  // ── the channel pickers ─────────────────────────────────────────────────────────────────────────
  // `chanRefs` is the truth for the channels while the pane is open: picking one has to be instant,
  // and a channel is a binding rather than a line of GLSL, so it does not need a compile.
  // THE FOUR INPUTS, and there is one set of them: see gfx-document.js. They belong to the document,
  // not to a tab, so nothing here is keyed by pass and switching tabs cannot show a different set.
  let chanRefs = Array.from({ length: CHANNELS }, () => ({ kind: "none" }));
  const chanEl = document.createElement("div");
  // the side of the pane: the set in and out of a file, the cables, then what the compile said
  side.append(docsSide(), chanEl, reportEl);

  /** The side panel's documents section: the set in and out of a file. Built once -- it is the same
   *  two controls whatever document is on screen, unlike the channels below it. */
  function docsSide() {
    const box = document.createElement("div");
    box.appendChild(heading("Documents"));
    const row = document.createElement("div");
    row.className = "gfx-ed-docbtns";
    const out = document.createElement("button");
    out.className = "gfx-ed-btn";
    out.textContent = "Export to a file";
    out.title = "Every document, as one JSON file. The code and the channels: a picture a channel wants is named, not carried.";
    out.addEventListener("click", () => exportSet());
    const into = document.createElement("button");
    into.className = "gfx-ed-btn";
    into.textContent = "Import a file";
    into.title = "Read a file this exported. Its documents are added, and the first of them is shown.";
    into.addEventListener("click", () => importPicker());
    row.append(out, into);
    box.append(row, note("Saved in this browser as you work, and in a file when you ask. Code only: an uploaded picture is kept for the session and named, never saved."));
    return box;
  }

  /** The set as a file's text. Separate from the download, so what is written can be read back. */
  const exportText = () => (set ? serializeSet(set) : "");

  function exportSet() {
    const text = exportText();
    if (!text) return { ok: false, error: "there is nothing to export" };
    const name = (doc?.name ?? "shaders").replace(/[^\w.-]+/g, "-") || "shaders";
    const file = `${name}.sonicpi-gfx.json`;
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    say(`exported ${set.documents.length} document${set.documents.length > 1 ? "s" : ""}`);
    return { ok: true, name: file };
  }

  /** Read a file this exported. Its documents are ADDED rather than put in place of what is here: a
   *  file is not worth losing what is on screen for, and a name that is taken is made unique. */
  function importSet(text) {
    const incoming = deserializeSet(text);
    if (!incoming) return { ok: false, error: "that file is not a shader set this can read" };
    save();                                  // what is on screen first: it is about to change
    const added = [];
    for (const d of incoming.documents) {
      d.name = uniqueName(set.documents, d.name);
      set.documents.push(d);
      added.push(d.name);
    }
    loadDocument(set.documents.find((d) => d.name === added[0]), { compileIt: true });
    say(`imported ${added.join(", ")}`);
    log?.(`Graphics — imported ${added.join(", ")}`);
    return { ok: true, added };
  }

  function importPicker() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      try {
        const result = importSet(await file.text());
        if (!result.ok) say(result.error, true);
      } catch (e) { say(`could not read that file: ${e.message}`, true); }
    });
    document.body.appendChild(input);
    input.click();
  }

  function paintChannels() {
    chanEl.textContent = "";
    if (canvasNow() == null) { chanEl.appendChild(note("The shader canvas is not running, so there is nothing to point at a channel.")); return; }
    // the document's inputs, named as the document's -- no tab's name on them, because they are not
    // a tab's: they are the same four wherever the code on screen came from
    chanEl.appendChild(heading("iChannels"));
    const refs = chanRefs;
    for (let i = 0; i < CHANNELS; i++) {
      const row = document.createElement("div");
      row.className = "gfx-ed-chan";
      const label = document.createElement("span");
      label.className = "gfx-ed-chan-n";
      label.textContent = `iChannel${i}`;
      const select = document.createElement("select");
      const add = (value, text) => select.appendChild(Object.assign(document.createElement("option"), { value, textContent: text }));
      add("", "None");
      // the engine's own audio first, because it is the one input that is always there: no file to
      // find, nothing to be missing. Shadertoy's two audio inputs, and its texture layout (see the
      // note under the channels).
      add("audio:fft", "Audio — spectrum");
      add("audio:wave", "Audio — waveform");
      // every buffer is offered, not only the ones this pass could read: the same four channels feed
      // EVERY pass, so a binding has to be possible for the ones that draw later as well. A pass that
      // reads a buffer drawn after it sees the previous frame -- which the renderer documents.
      for (const b of BUFFER_PASSES) add(`buffer:${b}`, b);
      for (const name of pictures.keys()) add(`image:${name}`, name);
      const current = refs[i] ?? { kind: "none" };
      const what = current.buffer ?? current.name ?? current.band;
      const value = current.kind === "none" ? "" : `${current.kind}:${what}`;
      // a picture this session does not have (a document loaded from storage): shown, and marked
      if (current.kind === "image" && !pictures.has(current.name)) add(value, `${current.name} (not here)`);
      select.value = value;
      select.addEventListener("change", () => {
        const [kind, ...rest] = select.value.split(":");
        const name = rest.join(":");
        const next = kind === "buffer" ? { kind: "buffer", buffer: name }
          : kind === "image" ? { kind: "image", name }
          : kind === "audio" ? { kind: "audio", band: name }
          : { kind: "none" };
        // read the refs again rather than closing over the array this row was painted from: another
        // channel may have been moved since, and rebuilding from a stale copy would undo it
        const now = chanRefs.length ? chanRefs : refs;
        chanRefs = now.map((r, j) => (j === i ? next : r ?? { kind: "none" }));
        const { gone } = applyChannels(true);
        paintChannels();                 // the row's own preview follows what it now draws
        if (gone.length) say(`${gone.join(", ")} left this session — nothing wants it now`);
      });
      // a file dropped on the row is chosen for the row, the same as the + is
      row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("over"); });
      row.addEventListener("dragleave", () => row.classList.remove("over"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        row.classList.remove("over");
        const f = e.dataTransfer?.files?.[0];
        if (f) upload(f, i);
      });
      row.append(label, previewOf(current), select, channelPicker(i));
      // a × beside a dropdown clears it -- for a picture or a buffer, and for a picture it is shown
      // here and nowhere else: a second copy of it elsewhere was the "one big, one small" this lost
      if (current.kind !== "none") row.append(clearButton(i));
      chanEl.appendChild(row);
    }
    const missing = missingImages(collect(), new Set(pictures.keys()));
    if (missing.length) chanEl.appendChild(note(`Wanted but not here: ${missing.join(", ")}. A picture lives in this session only — it is never saved with the code — so choose it again on the channel that wants it, or that channel draws a placeholder.`));
    if (wantedImages(collect()).length) chanEl.appendChild(note("A picture is kept in memory for this session and never written anywhere: saving a document saves the code and the name of the picture, not the picture."));
    if (chanRefs.some((r) => r?.kind === "audio")) {
      chanEl.appendChild(note("Audio is a 512x2 texture, Shadertoy's layout: texture(iChannelN, vec2(f, 0.25)).x is the spectrum at f, and vec2(t, 0.75).x is the waveform, both 0..1. It is made from what the engine is playing every frame, so there is nothing to save."));
    }
  }

  /** What a channel is drawing, at a glance: the picture itself, a buffer's letter, or nothing. */
  function previewOf(ref) {
    const cell = document.createElement("span");
    cell.className = "gfx-ed-chan-prev";
    const held = ref?.kind === "image" ? pictures.get(ref.name) : null;
    if (held) {
      const img = document.createElement("img");
      img.className = "gfx-ed-thumb-sm";
      img.src = held.url;
      img.alt = ref.name;
      cell.appendChild(img);
      cell.title = `${ref.name} — ${held.width}×${held.height}, this session only`;
    } else if (ref?.kind === "buffer") {
      cell.textContent = ref.buffer.replace("Buffer ", "");   // a buffer is a texture there is no cheap way to read back
      cell.title = ref.buffer;
    } else if (ref?.kind === "audio") {
      cell.textContent = ref.band;
      cell.title = `the engine's audio, as a 512x2 texture (${ref.band === "fft" ? "the spectrum" : "the waveform"}), made fresh every frame`;
    } else {
      cell.textContent = "–";
      cell.title = ref?.kind === "image" ? `${ref.name} is not in this session — choose it again` : "nothing";
    }
    return cell;
  }

  /** Every picture anything still names: the document on screen live, the others as they are saved. */
  function wantedEverywhere() {
    const want = new Set();
    for (const d of set?.documents ?? []) {
      // the document on screen is read live (the editor holds the truth while it is open), the others
      // as they were saved. One array each, and no pass in it.
      const channels = d.name === doc?.name ? chanRefs : d.channels;
      for (const r of channels ?? []) if (r?.kind === "image") want.add(r.name);
    }
    return want;
  }

  /**
   * Let go of the pictures nothing names any more -- out of this session's textures, out of the
   * dropdowns. A picture a channel still names stays: that channel is going to draw it. This is why
   * clearing a channel RESETS its dropdown but does not take a picture away from the channels that
   * still want it, and why a document loaded from storage that names a picture this session has not
   * got still says "(not here)" rather than being quietly tidied away.
   */
  function prunePictures(repaint = true) {
    const want = wantedEverywhere();
    const gone = [];
    for (const name of [...pictures.keys()]) {
      if (want.has(name)) continue;
      const held = pictures.get(name);
      URL.revokeObjectURL(held.url);
      pictures.delete(name);
      canvasNow()?.removeImage?.(name);
      gone.push(name);
    }
    if (gone.length && repaint) paintChannels();
    return gone;
  }

  /**
   * The way a picture gets onto a channel, which is where Shadertoy puts it: an iChannel slot is
   * given a picture, rather than a picture being uploaded somewhere and then wired up. So choosing a
   * file here BINDS THIS ROW to it -- the one thing that makes "I chose a picture" and "the picture
   * is on iChannel2" the same act. Dragging a file onto the row does the same.
   */
  function channelPicker(at) {
    const button = document.createElement("button");
    button.className = "gfx-ed-btn gfx-ed-pick";
    button.textContent = "+";
    button.title = `Choose a picture for iChannel${at} (it stays in this session, and is never saved)`;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    input.addEventListener("change", () => { const f = input.files?.[0]; if (f) upload(f, at); });
    button.addEventListener("click", () => input.click());
    button.appendChild(input);
    return button;
  }

  /**
   * A channel's ×: this channel stops drawing what it draws. It RESETS THE DROPDOWN, because that is
   * what a × beside a dropdown means -- and it is what the pane got wrong first: the × threw the
   * picture out of the session while the dropdown went on naming it, so the dropdown looked stuck on
   * a picture that no longer existed. The picture itself is let go of by `prunePictures`, when nothing
   * names it any more.
   */
  function clearButton(i) {
    const x = document.createElement("button");
    x.className = "gfx-ed-btn gfx-ed-forget";
    x.textContent = "×";
    x.title = `iChannel${i}: read nothing. A picture stays in this session while something else still wants it.`;
    x.addEventListener("click", () => {
      chanRefs = chanRefs.map((r, j) => (j === i ? { kind: "none" } : r ?? { kind: "none" }));
      const { gone } = applyChannels(true);           // saves, and lets go of any picture nothing names
      paintChannels();
      say(gone.length
        ? `iChannel${i} reads nothing now — ${gone.join(", ")} left this session (never saved)`
        : `iChannel${i} reads nothing now`);
    });
    return x;
  }

  /** A picture goes into this session's textures -- `addImage` -- and is not written to storage.
   *  `at` is the channel it was chosen for: choosing a picture for iChannel2 is what puts it there. */
  async function upload(file, at = null) {
    if (!file || !/^image\//.test(file.type)) { say(`"${file?.name ?? "that"}" is not a picture`, true); return; }
    const name = (file.name ?? "").slice(0, 60) || "picture";
    // a big photograph takes a moment to decode, and a pane that says nothing for a moment is the
    // complaint this is answering -- so it says what it is doing before it does it
    say(`reading ${name}…`);
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const was = pictures.get(name);
      if (was) URL.revokeObjectURL(was.url);          // the same file chosen again: one picture, one URL
      pictures.set(name, { img, url, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
      canvasNow()?.addImage(name, img);
      if (at != null) {
        chanRefs = chanRefs.map((r, j) => (j === at ? { kind: "image", name } : r ?? { kind: "none" }));
        applyChannels(true);
      }
      paintChannels();
      say(at == null
        ? `${name} is in this session (never saved) — pick it on a channel`
        : `${name} → ${tab} iChannel${at} (never saved)`);
    } catch (e) {
      URL.revokeObjectURL(url);        // it was never taken, so there is nothing holding it
      say(`could not read "${name}": ${e.message}`, true);
    }
  }



  /**
   * Push a pass's channels into the running renderer. A separate act from compiling, because it is
   * one: moving a cable is not a line of GLSL. `notify` is for a change the player made -- the pane
   * saving the document is this file's -- and not for the same refs arriving from a document just loaded.
   */
  function applyChannels(notify = false) {
    canvasNow()?.setChannels(chanRefs);
    if (!notify) return { gone: [] };
    save();                      // a cable moved, so the document in storage has moved with it
    // ...and it may have left a picture that nothing names any more: that is when one is let go of.
    // What that was is RETURNED rather than said, so the caller can say it along with its own news --
    // two `say`s in a row leave only the second, which is how this lost the more useful of the two.
    return { gone: prunePictures(false) };
  }

  // ── the tabs ────────────────────────────────────────────────────────────────────────────────────
  const tabButtons = new Map();
  for (const name of TABS) {
    const b = document.createElement("button");
    b.className = "gfx-ed-tab";
    b.textContent = tabLabel(name);
    b.title = name === SHARED ? "Common: code put in front of every pass" : name;
    b.addEventListener("click", () => show(name));
    tabButtons.set(name, b);
    tabsEl.appendChild(b);
  }

  const paintTabs = () => {
    for (const [name, b] of tabButtons) {
      b.classList.toggle("on", name === tab);
      // a pass with no code is off (gfx-document.js): the tab says so rather than looking empty by accident
      b.classList.toggle("off", name !== SHARED && textOf(name).trim() === "");
      const dirty = editor?.isDirty(name);
      const dot = b.querySelector(".dot");
      if (dirty && !dot) b.appendChild(Object.assign(document.createElement("span"), { className: "dot", textContent: "*" }));
      else if (!dirty && dot) dot.remove();
      b.title = name === SHARED ? "Common: code put in front of every pass" : `${name}${textOf(name).trim() === "" ? " (off: no code)" : ""}`;
    }
  };

  // ── the documents' row ──────────────────────────────────────────────────────────────────────────
  // The row above the passes' tabs, since a document is what holds the passes. Switching one is the
  // point of having several -- it is how the look changes mid-performance -- so a switch compiles
  // what it arrives at, and leaves the running picture alone if that will not compile.
  function paintDocs() {
    docsEl.textContent = "";
    if (!set) return;
    for (const d of set.documents) {
      const button = document.createElement("button");
      button.className = `gfx-ed-doc${d.name === doc.name ? " on" : ""}`;
      button.textContent = d.name;
      button.title = `${d.name}${d.name === doc.name ? " (on screen)" : " — click to switch"}. Double-click to rename.`;
      button.addEventListener("click", () => { if (d.name !== doc.name) switchTo(d.name); });
      button.addEventListener("dblclick", (e) => { e.preventDefault(); rename(d.name); });
      // a single document is not one to delete: deleting the only one leaves nothing to edit
      if (set.documents.length > 1) {
        const x = document.createElement("span");
        x.className = "x";
        x.textContent = "×";
        x.title = `Delete "${d.name}"`;
        x.addEventListener("click", (e) => { e.stopPropagation(); remove(d.name); });
        button.appendChild(x);
      }
      docsEl.appendChild(button);
    }
    const add = document.createElement("button");
    add.className = "gfx-ed-doc gfx-ed-add";
    add.textContent = "+";
    add.title = "A new document, with the default shader in its Image pass";
    add.addEventListener("click", () => addDocument());
    docsEl.appendChild(add);
  }

  /** Go to another document. Returns false if there is no such document to go to. */
  function switchTo(name) {
    const next = set.documents.find((d) => d.name === name);
    if (!next) return false;
    save();                                   // the document leaving the screen keeps its edits
    loadDocument(next, { compileIt: true });
    say(`switched to ${name}`);
    log?.(`Graphics — the document "${name}"`);
    return true;
  }

  function addDocument(source = null, want = "Untitled") {
    const name = uniqueName(set.documents, want);
    const next = emptyDocument(name, source ?? (starter ? starter() : ""));
    set.documents.push(next);
    loadDocument(next, { compileIt: true });
    say(`new document: ${name}`);
    return name;
  }

  /** Delete a document. Only asks when there is code to lose: a tool should not nag about nothing. */
  function remove(name) {
    if (set.documents.length < 2) return false;
    const target = set.documents.find((d) => d.name === name);
    if (!target) return false;
    const hasCode = PASS_ORDER.some((p) => (target.passes[p] ?? "").trim() !== "") || (target.common ?? "").trim() !== "";
    if (hasCode && !window.confirm(`Delete "${name}" and its code? This cannot be undone.`)) return false;
    const wasCurrent = name === doc.name;
    set.documents = set.documents.filter((d) => d.name !== name);
    if (wasCurrent) loadDocument(set.documents[0], { compileIt: true });
    else { save(); paintDocs(); }
    say(`deleted ${name}`);
    return true;
  }

  /** Rename in place: the tab becomes a field, Enter keeps it, Escape does not. */
  function rename(name) {
    const target = set.documents.find((d) => d.name === name);
    if (!target) return false;
    const button = [...docsEl.querySelectorAll(".gfx-ed-doc")].find((b) => b.textContent.startsWith(name));
    const input = document.createElement("input");
    input.className = "gfx-ed-rename";
    input.value = name;
    input.setAttribute("aria-label", "Document name");
    const done = (commit) => {
      input.removeEventListener("blur", onBlur);
      const want = input.value.trim();
      input.remove();
      if (!commit || !want || want === name) { paintDocs(); return; }
      // uniqueName against the others, so a rename cannot collide with a document that is already there
      target.name = uniqueName(set.documents.filter((d) => d !== target), want);
      if (name === doc.name) doc = target;
      save();
      paintDocs();
    };
    const onBlur = () => done(true);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); done(true); }
      else if (e.key === "Escape") { e.preventDefault(); done(false); }
    });
    input.addEventListener("blur", onBlur);
    if (button) button.replaceWith(input); else docsEl.appendChild(input);
    input.focus();
    input.select();
    return true;
  }

  // ── the editor, imported the first time it is needed ────────────────────────────────────────────
  async function ensureEditor() {
    if (editor) return editor;
    if (loading) return loading;
    codeHost.appendChild(note("Loading the editor…", "gfx-ed-wait"));
    loading = (async () => {
      let mod;
      try {
        mod = await import("./gfx-editor/editor.js");
      } catch (e) {
        codeHost.textContent = "";
        codeHost.appendChild(note(`The editor is not built: web/gfx-editor/editor.js is missing. Build it with "node scripts/build-gfx-editor.mjs" in app/web (tools/serve-dev.sh does it too), then reload. (${e.message})`));
        loading = null;
        return null;
      }
      codeHost.textContent = "";
      editor = mod.createShaderEditor({
        parent: codeHost,
        onCompile: () => compileNow(),
        onDirty: () => paintTabs(),
      });
      if (doc) loadDocument(doc);
      return editor;
    })();
    return loading;
  }

  // ── compiling ───────────────────────────────────────────────────────────────────────────────────
  function compileNow() {
    if (!editor) return;
    const next = collect();
    doc = next;
    save();                       // what runs is what is kept, so a compile is a save
    const result = compile(next) ?? { ok: false, failures: [], compiled: [] };
    report = result;
    // the marks: one tab's lines at a time, and every other tab's cleared (this compile replaced them)
    const { byTab } = marksFor(result.failures);
    for (const name of TABS) editor.report(name, byTab.get(name) ?? []);
    // clean is a claim that the code running is the code in the tab, so it is only made about the
    // passes that compiled and -- since Common goes in front of all of them -- about Common when
    // every pass did. A pass that failed stays marked, which is the honest thing for it to be.
    for (const name of result.compiled) editor.markClean(name);
    if (result.ok) editor.markClean(SHARED);
    paintTabs();
    paintReport();
    const bad = result.failures.length;
    say(bad ? `${bad} pass${bad > 1 ? "es" : ""} did not compile — the one that was running still is` : `compiled: ${result.compiled.join(", ") || "nothing"}`, bad > 0);
    if (bad) for (const f of result.failures) log?.(`Graphics — ${f.pass} did not compile.\n${f.report}`);
    return result;
  }

  // ── documents ───────────────────────────────────────────────────────────────────────────────────
  /** Show a document: every pass's text into the editor, the channels into the renderer. */
  function loadDocument(next, { compileIt = false } = {}) {
    const wanted = tab;
    doc = next;
    chanRefs = Array.from({ length: CHANNELS }, (_, i) => next.channels?.[i] ?? { kind: "none" });
    if (editor) {
      editor.setCode(SHARED, next.common ?? "");
      for (const p of PASS_ORDER) editor.setCode(p, next.passes[p] ?? "");
      editor.clearReports();
      editor.markAllClean();
      editor.setUniformNames(canvasNow()?.usable ?? []);
    }
    for (const p of PASS_ORDER) applyChannels(p);
    show(TABS.includes(wanted) ? wanted : SHARED);
    report = null;
    paintReport();
    // the set now says this is the document on screen, and holds it as the editor has it
    save();
    paintDocs();
    say("");
    if (compileIt) compileNow();
  }

  /** Which tab is on screen, and where the caret goes if a line was named. */
  function show(name, line) {
    if (!TABS.includes(name)) name = SHARED;
    tab = name;
    paintTabs();
    paintChannels();
    // The editor is imported when the pane is OPENED and not before: showing a tab is also what a
    // document being loaded does, and a page that loads a document without ever opening the shader
    // editor must not pay 375 kB for CodeMirror. So a shut pane only records which tab it will show.
    if (!editor) {
      if (isOpen()) ensureEditor().then((e) => { if (e) { e.show(tab); if (line) e.jumpTo(tab, line); } });
      return;
    }
    editor.show(name);
    if (line) editor.jumpTo(name, line);
  }

  // ── opening and closing ─────────────────────────────────────────────────────────────────────────
  const isOpen = () => document.body.dataset.drawer === PANE;

  function open() {
    // the app's rail buttons keep their lit state until something clears it, and this pane is not
    // in app.js's list of panes: so the lit icon, the attribute and the drawer's space are set here
    document.body.dataset.drawer = PANE;
    document.body.classList.add("panel-open");
    document.body.classList.remove("prefs-open");
    for (const b of rail.querySelectorAll("[data-drawer]")) b.classList.toggle("on", b === button);
    try { localStorage.setItem(OPEN_KEY, "1"); } catch {}
    show(tab);
    ensureEditor().then((e) => { if (e && isOpen()) { e.refresh(); e.setUniformNames(canvasNow()?.usable ?? []); } });
  }

  function close() {
    if (isOpen()) { document.body.dataset.drawer = ""; document.body.classList.remove("panel-open"); }
    button.classList.remove("on");
    try { localStorage.removeItem(OPEN_KEY); } catch {}
  }

  button.addEventListener("click", () => (isOpen() ? close() : open()));
  compileBtn.addEventListener("click", () => compileNow());

  /** Put the pane back as it was, if it was open when the page was left. */
  function restore() {
    let was = false;
    try { was = localStorage.getItem(OPEN_KEY) === "1"; } catch {}
    if (was) open();
  }

  return {
    el, button,
    open, close,
    isOpen,
    restore,
    loadDocument,
    /** The stored documents, or one made by `fallback` if nothing was ever stored. The document it
     *  returns is the one to compile: what was on screen when the page was left. */
    load,
    /** What the pane is editing now, channels included -- the top layer's copy of the truth. */
    document: () => (editor ? collect() : doc),
    compile: compileNow,
    /** The pane was hidden and shown, or the document changed underneath: measure and repaint. */
    refresh() { editor?.refresh(); paintTabs(); paintChannels(); },
    /** The shader has just linked: the names a player can send are only known now. */
    uniformsChanged() { editor?.setUniformNames(canvasNow()?.usable ?? []); },
    // the documents, for the music to drive (`puts :gfx, :document, "name"`) and for the Log
    get documents() { return set ? set.documents.map((d) => d.name) : []; },
    get current() { return doc?.name ?? null; },
    switchTo,
    addDocument,
    remove,
    rename,
    save,
    /** Wire the four inputs by hand: the test card needs two of them to be the audio. */
    setChannels(refs) {
      chanRefs = Array.from({ length: CHANNELS }, (_, i) => refs?.[i] ?? { kind: "none" });
      applyChannels(true);
      paintChannels();
    },
    exportText,
    exportSet,
    importSet,
    pictures,
  };
}
