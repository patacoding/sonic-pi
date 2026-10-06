// The Shadertoy editor: documents, PASSES and CHANNELS -- the model, not just a text box.
//
// A Shadertoy shader is not one piece of code. It is a set of documents ("sets"), each with passes -- Common,
// Buffer A..D, Image -- and four channel slots (iChannel0..3) that say what each pass reads: another pass's
// output, a picture, the audio, or nothing. The first rewrite threw all of that away and left a textarea; this
// one is built on it.
//
// Self-contained on purpose: no imports from the rest of the layer, nothing bundled, so the UI cannot be broken
// by the layout it used to live in. Compiling checks each pass and says what it can and cannot know yet -- the
// render canvas is not wired up in this piece.
export const PASSES = ["Common", "Buffer A", "Buffer B", "Buffer C", "Buffer D", "Image"];
export const CHANNEL_KINDS = [
  { kind: "none", label: "none" },
  { kind: "buffer", label: "buffer" },
  { kind: "image", label: "image" },
  { kind: "audio", label: "audio" },
];
export const AUDIO_BANDS = ["fft", "wave", "scope"];
const KEY = "sp-shadertoy-sets";
const CORE = (body) => `void mainImage(out vec4 c, in vec2 p) {\n${body}\n}\n`;
const STARTER = {
  Common: "// Common: functions every pass can call. No mainImage here.\nvec3 palette(float t) {\n    return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));\n}\n",
  "Buffer A": CORE("    c = vec4(0.0);                        // write something here for Image to read"),
  "Buffer B": "",
  "Buffer C": "",
  "Buffer D": "",
  Image: CORE("    vec3 col = palette(p.x + p.y);\n    c = vec4(col, 1.0);"),
};
/** The starting passes, for anyone with nothing saved yet (the canvas needs an Image to draw). */
export const defaultPasses = () => ({ ...STARTER });

const blankDoc = (name) => ({
  name,
  passes: Object.fromEntries(PASSES.map((p) => [p, STARTER[p] ?? ""])),
  channels: [0, 1, 2, 3].map(() => ({ kind: "none" })),
});

const STYLE = `
  #gfx-editor-btn { position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-index: 99;
    writing-mode: vertical-rl; padding: 12px 6px; cursor: pointer; font: 12px/1 system-ui, sans-serif;
    letter-spacing: .04em; color: var(--WindowForeground); border: 1px solid var(--WindowBorder); border-right: 0;
    border-radius: 8px 0 0 8px; background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); }
  #gfx-editor-btn:hover { background: color-mix(in srgb, var(--WindowBackground) 78%, transparent); }

  #gfx-ed { position: fixed; inset: 0; z-index: 98; display: flex; flex-direction: column;
    background: var(--WindowBackground); color: var(--WindowForeground); font: 13px/1.45 system-ui, sans-serif; }
  body:not([data-gfx-ed="open"]) #gfx-ed { display: none !important; }

  #gfx-ed-head, #gfx-ed-docs, #gfx-ed-passes, #gfx-ed-chans { flex: 0 0 auto; display: flex; align-items: center;
    gap: 6px; padding: 6px 10px; flex-wrap: wrap; }
  #gfx-ed-head { border-bottom: 1px solid var(--WindowBorder); }
  #gfx-ed-docs, #gfx-ed-passes { border-bottom: 1px solid var(--WindowBorder); }
  #gfx-ed-head .title { font-weight: 600; }
  #gfx-ed-head .note { opacity: .6; font-size: 12px; }
  #gfx-ed-head .spacer { flex: 1 1 auto; }
  #gfx-ed button { font: 12px/1 system-ui, sans-serif; color: var(--WindowForeground); cursor: pointer;
    background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); border: 1px solid var(--WindowBorder);
    border-radius: 6px; padding: 4px 9px; }
  #gfx-ed button:hover { background: color-mix(in srgb, var(--WindowBackground) 78%, transparent); }
  #gfx-ed button.on { background: #d53; color: #fff; border-color: #d53; }
  #gfx-ed .tag { opacity: .6; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  #gfx-ed input, #gfx-ed select { font: inherit; font-size: 12px; padding: 3px 6px; color: var(--WindowForeground);
    background: color-mix(in srgb, var(--WindowBackground) 70%, transparent); border: 1px solid var(--WindowBorder);
    border-radius: 6px; }
  #gfx-ed-docs input { width: 9em; }
  #gfx-ed .chan { display: flex; align-items: center; gap: 4px; padding: 3px 6px; border: 1px solid var(--WindowBorder);
    border-radius: 6px; }
  #gfx-ed .chan .n { opacity: .65; font-size: 11px; }
  #gfx-ed-main { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 8px 10px 10px; gap: 6px; }
  #gfx-ed-code { flex: 1 1 auto; min-height: 0; width: 100%; resize: none; tab-size: 4; white-space: pre;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--WindowForeground);
    background: color-mix(in srgb, var(--WindowBackground) 70%, transparent);
    border: 1px solid var(--WindowBorder); border-radius: 8px; padding: 10px; outline: none; }
  #gfx-ed-code:focus { border-color: #d53; }
  #gfx-ed-say { flex: 0 0 auto; min-height: 1.4em; font: 12px/1.4 ui-monospace, monospace; opacity: .85; white-space: pre-wrap; }
  #gfx-ed-say.bad { color: #f66; opacity: 1; }
`;

export function createEditorTab({ canvasView = null, log = null } = {}) {
  if (!document.getElementById("gfx-ed-style")) {
    const style = document.createElement("style");
    style.id = "gfx-ed-style";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  // ── the model: sets of documents, each with passes and channels ─────────────────────────────────────────
  const load = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
      if (saved?.docs?.length) {
        for (const d of saved.docs) {                      // a set saved by an older shape still opens
          d.passes ??= Object.fromEntries(PASSES.map((p) => [p, ""]));
          for (const p of PASSES) d.passes[p] ??= "";
          d.channels ??= [0, 1, 2, 3].map(() => ({ kind: "none" }));
          while (d.channels.length < 4) d.channels.push({ kind: "none" });
        }
        return saved;
      }
    } catch {}
    return { docs: [blankDoc("Alpha")], doc: 0, pass: "Image" };
  };
  const state = load();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
  const doc = () => state.docs[state.doc] ?? state.docs[0];

  // ── the surface ─────────────────────────────────────────────────────────────────────────────────────────
  const el = document.createElement("div");
  el.id = "gfx-ed";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Shadertoy editor");
  el.innerHTML = `<div id="gfx-ed-head"><span class="title">Shadertoy</span>
      <span class="note">passes and channels are editable; the render canvas is not wired up yet</span>
      <span class="spacer"></span>
      <button id="gfx-ed-compile" type="button">Compile</button>
      <button id="gfx-ed-compile-all" type="button">Compile all passes</button>
      <button id="gfx-ed-close" type="button">Back to audio</button></div>
    <div id="gfx-ed-docs"><span class="tag">set</span></div>
    <div id="gfx-ed-passes"><span class="tag">pass</span></div>
    <div id="gfx-ed-chans"><span class="tag">channels</span></div>
    <div id="gfx-ed-main"><textarea id="gfx-ed-code" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
      <div id="gfx-ed-say"></div></div>`;
  document.body.appendChild(el);

  const docsEl = el.querySelector("#gfx-ed-docs");
  const passesEl = el.querySelector("#gfx-ed-passes");
  const chansEl = el.querySelector("#gfx-ed-chans");
  const codeEl = el.querySelector("#gfx-ed-code");
  const sayEl = el.querySelector("#gfx-ed-say");
  const say = (text, bad = false) => { sayEl.textContent = text ?? ""; sayEl.classList.toggle("bad", !!bad); };

  function paintDocs() {
    docsEl.textContent = "";
    docsEl.appendChild(Object.assign(document.createElement("span"), { className: "tag", textContent: "set" }));
    state.docs.forEach((d, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = d.name; b.className = i === state.doc ? "on" : "";
      b.addEventListener("click", () => { state.doc = i; save(); paintAll(); });
      docsEl.appendChild(b);
    });
    const name = document.createElement("input");
    name.value = doc().name;
    name.title = "this set's name";
    name.addEventListener("change", () => { doc().name = name.value.trim() || doc().name; save(); paintDocs(); });
    const add = document.createElement("button");
    add.type = "button"; add.textContent = "+"; add.title = "another set";
    add.addEventListener("click", () => { state.docs.push(blankDoc(`Set ${state.docs.length + 1}`)); state.doc = state.docs.length - 1; save(); paintAll(); });
    const del = document.createElement("button");
    del.type = "button"; del.textContent = "−"; del.title = "remove this set";
    del.addEventListener("click", () => {
      if (state.docs.length < 2) return say("the last set stays: there has to be something to edit", true);
      state.docs.splice(state.doc, 1); state.doc = Math.max(0, state.doc - 1); save(); paintAll();
    });
    docsEl.append(name, add, del);
  }

  function paintPasses() {
    passesEl.textContent = "";
    passesEl.appendChild(Object.assign(document.createElement("span"), { className: "tag", textContent: "pass" }));
    for (const p of PASSES) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = p;
      b.className = p === state.pass ? "on" : "";
      b.dataset.pass = p;
      b.title = p === "Common" ? "shared code: no mainImage here" : `${p}'s mainImage`;
      b.addEventListener("click", () => { state.pass = p; save(); paintAll(); codeEl.focus(); });
      passesEl.appendChild(b);
    }
    // what this pass reads and writes: Shadertoy's own bookkeeping, at least as names
    const buffers = PASSES.filter((p) => p !== "Common" && p !== "Image");
    const info = document.createElement("span");
    info.className = "note";
    info.textContent = state.pass === "Image"
      ? "Image draws the screen and can read buffers and channels"
      : state.pass === "Common"
        ? "Common is shared; each pass can call what it defines"
        : `${state.pass} renders to its own buffer${buffers.includes(state.pass) ? " (an iChannel can point at it)" : ""}`;
    passesEl.appendChild(info);
  }

  function paintChannels() {
    chansEl.textContent = "";
    chansEl.appendChild(Object.assign(document.createElement("span"), { className: "tag", textContent: "channels" }));
    const buffers = PASSES.filter((p) => p !== "Common");
    doc().channels.forEach((ch, i) => {
      const box = document.createElement("div");
      box.className = "chan";
      const n = document.createElement("span");
      n.className = "n"; n.textContent = `iChannel${i}`;
      const kind = document.createElement("select");
      for (const k of CHANNEL_KINDS) {
        const o = document.createElement("option");
        o.value = k.kind; o.textContent = k.label; o.selected = ch.kind === k.kind;
        kind.appendChild(o);
      }
      kind.addEventListener("change", () => {
        const k = kind.value;
        doc().channels[i] = k === "buffer" ? { kind: "buffer", buffer: "Buffer A" }
          : k === "audio" ? { kind: "audio", band: "fft" }
            : k === "image" ? { kind: "image", name: ch.name ?? "" }
              : { kind: "none" };
        save(); paintChannels();
        canvasView?.setPasses?.(doc().passes, doc().channels);
      });
      box.append(n, kind);
      if (ch.kind === "buffer") {
        const sel = document.createElement("select");
        for (const b of buffers) {
          const o = document.createElement("option");
          o.value = b; o.textContent = b; o.selected = ch.buffer === b;
          sel.appendChild(o);
        }
        sel.addEventListener("change", () => { ch.buffer = sel.value; save(); });
        box.appendChild(sel);
      } else if (ch.kind === "audio") {
        const sel = document.createElement("select");
        for (const band of AUDIO_BANDS) {
          const o = document.createElement("option");
          o.value = band; o.textContent = band; o.selected = ch.band === band;
          sel.appendChild(o);
        }
        sel.addEventListener("change", () => { ch.band = sel.value; save(); });
        box.appendChild(sel);
      } else if (ch.kind === "image") {
        const file = document.createElement("input");
        file.type = "file"; file.accept = "image/*";
        file.title = ch.name ? `${ch.name} (kept in this browser)` : "a picture for this channel";
        file.addEventListener("change", async () => {
          const f = file.files?.[0];
          if (!f) return;
          const url = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
          ch.name = f.name; ch.data = url; save(); paintChannels();
          say(`iChannel${i} ← ${f.name} (${Math.round(url.length / 1024)} KB, kept in this browser)`);
        });
        box.appendChild(file);
        if (ch.name) box.appendChild(Object.assign(document.createElement("span"), { className: "n", textContent: ch.name }));
      }
      chansEl.appendChild(box);
    });
  }

  function paintAll() {
    paintDocs(); paintPasses(); paintChannels();
    codeEl.value = doc().passes[state.pass] ?? "";
  }

  codeEl.addEventListener("input", () => { doc().passes[state.pass] = codeEl.value; save(); });
  codeEl.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {                                    // an editor that cannot indent is a textarea
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = codeEl;
      codeEl.value = `${value.slice(0, a)}    ${value.slice(b)}`;
      codeEl.selectionStart = codeEl.selectionEnd = a + 4;
      doc().passes[state.pass] = codeEl.value; save();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); compile(); }
  });

  /** Only Image needs a mainImage; every other pass may be empty. Braces are checked everywhere. */
  function checkOne(pass) {
    const src = doc().passes[pass] ?? "";
    if (!src.trim()) return pass === "Image" ? `${pass}: empty — the screen would draw nothing` : null;
    const opens = (src.match(/\{/g) ?? []).length, closes = (src.match(/\}/g) ?? []).length;
    if (opens !== closes) return `${pass}: braces do not balance (${opens} { against ${closes} })`;
    if (pass !== "Common" && !/void\s+mainImage\s*\(/.test(src)) return `${pass}: no void mainImage(out vec4 c, in vec2 p)`;
    return null;
  }
  function compile() {
    const problems = checkOne(state.pass);
    // the Image pass is what draws: hand it (and Common) to the canvas, and report what actually happened
    if (!problems && canvasView) {
      const res = canvasView.setPasses(doc().passes, doc().channels);
      log?.(res.failed.length ? `canvas: ${res.failed.join("; ")}` : `canvas compiled: ${res.ok.join(", ")}`);
    }
    const used = doc().channels.map((c, i) => (c.kind === "buffer" ? `iChannel${i}→${c.buffer}` : c.kind === "none" ? null : `iChannel${i}→${c.kind}`)).filter(Boolean);
    say(problems ? problems
      : `${state.pass} looks like a shader. channels: ${used.length ? used.join(", ") : "none set"}. ` +
        "The render canvas is not wired up yet, so nothing was drawn — the text is saved either way.", !!problems);
  }
  function compileAll() {
    const problems = PASSES.map(checkOne).filter(Boolean);
    say(problems.length ? problems.join("\n")
      : `all ${PASSES.length} passes check out (${PASSES.filter((p) => (doc().passes[p] ?? "").trim()).length} with code). ` +
        "The render canvas is not wired up yet, so nothing was drawn.", problems.length > 0);
  }
  el.querySelector("#gfx-ed-compile").addEventListener("click", compile);
  el.querySelector("#gfx-ed-compile-all").addEventListener("click", compileAll);
  el.querySelector("#gfx-ed-close").addEventListener("click", () => set(false));
  paintAll();

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
    if (open) { paintAll(); setTimeout(() => codeEl.focus(), 0); }
    return true;
  }
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "s" || e.key === "S")) { e.preventDefault(); e.stopPropagation(); set(!open); }
    else if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); set(false); }
  }, true);

  document.body.dataset.gfxEd = "closed";
  return { el, button: btn, open: () => open, set, toggle: () => set(!open), compile, compileAll, state };
}
