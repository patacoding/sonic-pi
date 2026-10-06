// A Shadertoy page of our own: the editor and its passes, the channels, the values coming from the music.
//
// No canvas in this piece (asked for), no CodeMirror (it never mounted outside the app's drawer, and a page that
// depends on that is a page that shows nothing), no reimplementation of the model: the documents are the
// ORIGINAL ones -- graphics/gfx-document.js: PASS_ORDER, Common as the document's own field, four channels per
// document, the v1 -> v2 migration, images asked for again rather than kept in storage, and the set serialisation
// behind Import/Export. The audio side keeps its own syntax -- :gfx / :gfxv through graphics/gfx-directive.js --
// and what arrives is shown in a panel, live, so a live_loop that sends values is visible in the page.
import {
  PASS_ORDER, SHARED, CHANNELS, emptyDocument, serializeSet, deserializeSet, deserialize, uniqueName,
} from "./graphics/gfx-document.js";
import { parseDirective } from "./graphics/gfx-directive.js";

const TABS = [SHARED, ...PASS_ORDER];        // Common, Buffer A..D, Image  (Shadertoy's rows)
const KINDS = ["none", "buffer", "image", "audio"];
const KEY = "sp-gfx-documents";                   // the ORIGINAL pane's own key: one storage, both editors

/** Built-in defaults, one per pass: Shadertoy's own pages are never blank and neither is this one. */
const DEFAULTS = {
  [SHARED]: `// Common: what every pass can call (no mainImage here).
vec3 palette(float t) {
    return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
}
`,
  "Buffer A": `// Buffer A: drawn once per frame, read by Image through an iChannel.
void mainImage(out vec4 c, in vec2 p) {
    vec2 uv = p / iResolution.xy;
    float w = 0.5 + 0.5 * sin(iTime + uv.x * 6.28318);
    c = vec4(palette(w), 1.0);
}
`,
  "Buffer B": `void mainImage(out vec4 c, in vec2 p) {
    c = vec4(p / iResolution.xy, 0.5, 1.0);
}
`,
  "Buffer C": `void mainImage(out vec4 c, in vec2 p) {
    c = vec4(0.0, 0.0, 0.0, 1.0);
}
`,
  "Buffer D": `void mainImage(out vec4 c, in vec2 p) {
    c = vec4(0.0, 0.0, 0.0, 1.0);
}
`,
  Image: `// Image: what the screen shows. iChannel0 is wired to Buffer A by default.
void mainImage(out vec4 c, in vec2 p) {
    vec2 uv = p / iResolution.xy;
    vec3 col = texture(iChannel0, uv).rgb;
    col *= 0.6 + 0.4 * sin(iTime);
    c = vec4(col, 1.0);
}
`,
};
const STYLE = `
  #gfx-st { --gfx-st-fs: 13px; position: fixed; inset: 0; z-index: 99; display: none; flex-direction: column;
    background: var(--WindowBackground); color: var(--WindowForeground);
    font: 13px/1.45 system-ui, sans-serif; }
  body[data-gfx-st="open"] #gfx-st { display: flex; }
  /* the right-edge buttons (this one and the canvas's) are one pair: same box, same type, same behaviour --
     only their colour of state differs. Defined identically in both files so neither can drift. */
  #gfx-st-btn, #gfx-canvas-btn { position: fixed; right: 0; z-index: 101; writing-mode: vertical-rl;
    height: 5.4em; overflow: hidden; padding: 10px 6px; cursor: pointer; font: 12px/1.1 system-ui, sans-serif;
    letter-spacing: .04em; text-align: center; color: var(--WindowForeground);
    border: 1px solid var(--WindowBorder); border-right: 0; border-radius: 8px 0 0 8px;
    background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); }
  #gfx-st-btn:hover, #gfx-canvas-btn:hover { background: color-mix(in srgb, var(--WindowBackground) 78%, transparent); }
  #gfx-st-btn { top: calc(50% - 5.4em); }
  #gfx-st-btn[aria-pressed="true"] { border-color: #d53; color: #d53; }
  #gfx-st-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 6px 10px;
    border-bottom: 1px solid var(--WindowBorder); }
  #gfx-st-head .title { font-weight: 600; }
  #gfx-st-head .spacer { flex: 1 1 auto; }
  #gfx-st button { font: 12px/1 system-ui, sans-serif; color: var(--WindowForeground); cursor: pointer;
    background: color-mix(in srgb, var(--WindowBackground) 92%, transparent); border: 1px solid var(--WindowBorder);
    border-radius: 6px; padding: 4px 9px; }
  #gfx-st button:hover { background: color-mix(in srgb, var(--WindowBackground) 78%, transparent); }
  #gfx-st button.on { background: #d53; color: #fff; border-color: #d53; }
  #gfx-st-row { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 6px 10px; flex-wrap: wrap; }
  #gfx-st-row.docs { border-bottom: 1px solid var(--WindowBorder); }
  #gfx-st-row.passes { border-bottom: 1px solid var(--WindowBorder); }
  #gfx-st .tag { opacity: .55; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  #gfx-st input[type=text] { font: 12px/1 system-ui, sans-serif; padding: 3px 6px; min-width: 8em;
    color: var(--WindowForeground); background: color-mix(in srgb, var(--WindowBackground) 70%, transparent);
    border: 1px solid var(--WindowBorder); border-radius: 6px; }
  #gfx-st select { font: 12px/1 system-ui, sans-serif; padding: 3px 4px; color: var(--WindowForeground);
    background: color-mix(in srgb, var(--WindowBackground) 70%, transparent); border: 1px solid var(--WindowBorder);
    border-radius: 6px; }
  #gfx-st .chan { display: flex; align-items: center; gap: 5px; padding: 3px 6px;
    border: 1px solid var(--WindowBorder); border-radius: 6px; }
  #gfx-st .chan .n { opacity: .6; font: 11px ui-monospace, monospace; }
  #gfx-st .chan .prev { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px;
    border: 1px solid var(--WindowBorder); border-radius: 4px; overflow: hidden; font: 11px ui-monospace, monospace; }
  #gfx-st .chan .prev img { width: 100%; height: 100%; object-fit: cover; display: block; }
  #gfx-st .chan { flex-wrap: wrap; }
  #gfx-st-main { flex: 1 1 auto; min-height: 0; display: flex; }
  /* the code area: a highlight layer UNDER the textarea, both with identical metrics so they line up exactly.
     The textarea keeps the caret, the selection and the keyboard; its own text is invisible. */
  #gfx-st-codewrap { position: relative; flex: 1 1 auto; min-width: 0; margin: 8px; }
  #gfx-st-hl, #gfx-st-code { position: absolute; inset: 0; margin: 0; padding: 10px; border-radius: 8px;
    font: var(--gfx-st-fs, 13px)/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; tab-size: 4;
    overflow: auto; border: 1px solid var(--WindowBorder); }
  #gfx-st-hl { pointer-events: none; color: var(--WindowForeground); background: color-mix(in srgb, var(--WindowBackground) 72%, transparent); }
  #gfx-st-code { resize: none; outline: none; background: transparent; color: transparent;
    caret-color: var(--WindowForeground); }
  #gfx-st-code:focus { border-color: #d53; }
  #gfx-st-code::selection { background: color-mix(in srgb, #d53 45%, transparent); }
  #gfx-st-hl .c { color: #7f8c98; font-style: italic; }   /* comment */
  #gfx-st-hl .s { color: #9ccc65; }                       /* string */
  #gfx-st-hl .p { color: #d19a66; }                       /* preprocessor */
  #gfx-st-hl .k { color: #c678dd; }                       /* keyword */
  #gfx-st-hl .t { color: #e5c07b; }                       /* type */
  #gfx-st-hl .b { color: #61afef; }                       /* builtin function */
  #gfx-st-hl .u { color: #56b6c2; }                       /* Shadertoy's own uniforms */
  #gfx-st-hl .n { color: #d19a66; }                       /* number */
  #gfx-st-hl .f { color: #98c379; }                       /* a call this shader defines */
  #gfx-st-side { flex: 0 0 300px; display: flex; flex-direction: column; gap: 8px; margin: 8px 8px 8px 0; }
  #gfx-st-side section { border: 1px solid var(--WindowBorder); border-radius: 8px; padding: 8px;
    background: color-mix(in srgb, var(--WindowBackground) 72%, transparent); }
  #gfx-st-side h4 { margin: 0 0 6px; font: 600 12px/1 system-ui, sans-serif; opacity: .8; }
#gfx-st-vars { font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; min-height: 3em; }
  #gfx-st-status { white-space: pre-wrap; }
  #gfx-st-perf { font-variant-numeric: tabular-nums; }
`;

export function createShadertoyPage() {
  if (!document.getElementById("gfx-st-style")) {
    const style = document.createElement("style");
    style.id = "gfx-st-style";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  // ── the model: the ORIGINAL documents, in the ORIGINAL key ──────────────────────────────────────────────
  const load = () => {
    try {
      const text = localStorage.getItem(KEY) ?? "";
      if (text) {
        let read = null;
        try { read = deserializeSet(text); } catch {}                       // the current shape
        if (!read?.documents?.length) {
          try { read = deserialize(JSON.parse(text)); } catch {}           // older shapes the original reads too
        }
        if (read?.documents?.length) return read;
      }
    } catch {}
    const d = emptyDocument("Alpha", DEFAULTS.Image);
    d.common = DEFAULTS[SHARED];
    for (const pass of PASS_ORDER) d.passes[pass] = DEFAULTS[pass] ?? "";
    d.channels[0] = { kind: "buffer", pass: "Buffer A" };        // the wiring the default Image expects
    return { documents: [d], current: 0, name: "My Set" };
  };
  const set = load();
  // serializeSet returns a STRING (graphics/gfx-document.js: JSON.stringify(normalizeSet(set))); wrapping it in
  // another JSON.stringify is what stopped anything from ever coming back
  const save = () => { try { localStorage.setItem(KEY, serializeSet(set)); } catch (e) { say(`could not save: ${e?.message ?? e}`, true); } };
  let saveTimer = 0;
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); };
  const doc = () => set.documents[set.current] ?? set.documents[0];
  let tab = "Image";

  // ── the page ────────────────────────────────────────────────────────────────────────────────────────────
  const el = document.createElement("div");
  el.id = "gfx-st";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Shadertoy");
  el.innerHTML = `<div id="gfx-st-head"><span class="title">Shadertoy</span>
      <span class="tag" id="gfx-st-status"></span>
      <span class="spacer"></span>
      <span class="tag" id="gfx-st-perf">—</span>
      <button id="gfx-st-fs-down" title="smaller code (Ctrl/Cmd+-)">A−</button>
      <button id="gfx-st-fs-up" title="larger code (Ctrl/Cmd++)">A+</button>
      <button id="gfx-st-compile">Compile</button>
      <button id="gfx-st-compile-all">Compile all</button>
      <button id="gfx-st-export">Export</button>
      <button id="gfx-st-import">Import</button>
      <input id="gfx-st-file" type="file" accept=".json,application/json" hidden>
      </div>
    <div id="gfx-st-row" class="passes"></div>
    <div id="gfx-st-main"><div id="gfx-st-codewrap"><pre id="gfx-st-hl" aria-hidden="true"></pre><textarea id="gfx-st-code" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea></div>
      <div id="gfx-st-side"><section><h4>iChannels</h4><div id="gfx-st-chans"></div></section>
        <section><h4>from the music</h4><div id="gfx-st-vars">(nothing yet)</div></section></div></div>
`;
  document.body.appendChild(el);

  const passesRow = el.querySelector("#gfx-st-row.passes");
  const codeEl = el.querySelector("#gfx-st-code");
  const hlEl = el.querySelector("#gfx-st-hl");
  const paintHl = () => { hlEl.innerHTML = highlightGLSL(codeEl.value) + "\n"; hlEl.scrollTop = codeEl.scrollTop; hlEl.scrollLeft = codeEl.scrollLeft; };
  const chansEl = el.querySelector("#gfx-st-chans");
  const varsEl = el.querySelector("#gfx-st-vars");
  /**
   * GLSL, highlighted in one pass.
   *
   * One regex with its alternatives in priority order -- comment, string, preprocessor, keyword, type, builtin,
   * Shadertoy's uniforms, number, call -- and every match escaped and wrapped as it is found. Chained replaces
   * were what broke the last highlighter I wrote: each pass rescanned the markup the previous one had inserted.
   */
  const GLSL_TOKEN = new RegExp([
    "(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)",                                  // 1 comment
    "(&quot;(?:[^&\"\\\\]|\\\\.)*&quot;|\"(?:[^\"\\\\]|\\\\.)*\")",             // 2 string
    "(^[ \\t]*#[^\\n]*)",                                                              // 3 preprocessor
    "\\b(void|float|int|uint|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4|bvec2|bvec3|bvec4|mat2|mat3|mat4|sampler2D|samplerCube|uniform|varying|attribute|const|in|out|inout|if|else|for|while|do|return|break|continue|discard|struct|precision|highp|mediump|lowp|true|false)\\b", // 4 keyword/type
    "\\b(sin|cos|tan|asin|acos|atan|pow|exp|exp2|log|log2|sqrt|inversesqrt|abs|sign|floor|ceil|fract|mod|min|max|clamp|mix|step|smoothstep|length|distance|dot|cross|normalize|reflect|refract|faceforward|texture|textureLod|texelFetch|dFdx|dFdy|fwidth|mainImage)\\b", // 5 builtin
    "\\b(iResolution|iTime|iTimeDelta|iFrame|iFrameRate|iMouse|iDate|iSampleRate|iChannel0|iChannel1|iChannel2|iChannel3|iChannelResolution|iChannelTime|iAudioLevel)\\b", // 6 ours
    "\\b(\\d+\\.?\\d*(?:[eE][-+]?\\d+)?|\\.\\d+)\\b",                                     // 7 number
    "\\b([A-Za-z_]\\w*)(?=\\s*\\()",                                                          // 8 call
  ].join("|"), "gm");
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // one entry per alternative, in the same order (the 4th is decided by the test below: keyword vs type)
  const CLASSES = ["c", "s", "p", null, "b", "u", "n", "f"];
  const KEYWORDS = /^(void|uniform|varying|attribute|const|in|out|inout|if|else|for|while|do|return|break|continue|discard|struct|precision|highp|mediump|lowp|true|false)$/;
  function highlightGLSL(src) {
    return String(src).replace(GLSL_TOKEN, (...args) => {
      const groups = args.slice(1, 1 + CLASSES.length);
      const at = groups.findIndex((g) => g !== undefined);
      if (at < 0) return esc(args[0]);
      const cls = at === 3 ? (KEYWORDS.test(groups[3]) ? "k" : "t") : CLASSES[at];
      return `<span class="${cls}">${esc(args[0])}</span>`;
    });
  }

  const statusEl = el.querySelector("#gfx-st-status");
  const perfEl = el.querySelector("#gfx-st-perf");
  // one place for what the page has to say, in the head: the "from the music" panel already shows the values,
  // and a second copy of them at the bottom was pure noise
  const say = (t, bad = false) => {
    statusEl.textContent = String(t ?? "").replace(/\s+/g, " ").slice(0, 120);
    statusEl.style.color = bad ? "#f66" : "";
  };
  // the render cost, as the original layer had it (and as honestly: a number, or a dash)
  setInterval(() => {
    const p = globalThis.sonicPiCanvas?.perf?.();
    perfEl.textContent = p ? `${p.fps.toFixed(1)} fps · ${p.ms ?? "—"} ms · gpu ${p.gpuMs ?? "—"} · ${p.passed} pass(es)` : "no canvas";
  }, 500);

  function paintPasses() {
    passesRow.textContent = "";
    passesRow.appendChild(Object.assign(document.createElement("span"), { className: "tag", textContent: "pass" }));
    for (const t of TABS) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = t === SHARED ? "Common" : t.replace("Buffer ", "");
      b.title = t;
      b.className = t === tab ? "on" : "";
      b.dataset.tab = t;
      b.addEventListener("click", () => { remember(); save(); tab = t; paintAll(); codeEl.focus(); });
      passesRow.appendChild(b);
    }
  }
  const remember = () => {
    if (tab === SHARED) doc().common = codeEl.value; else doc().passes[tab] = codeEl.value;
    save();
  };
  function paintChannels() {
    chansEl.textContent = "";
    const d = doc();
    (d.channels ??= Array.from({ length: CHANNELS }, () => ({ kind: "none" }))).forEach((ch, i) => {
      const box = document.createElement("div");
      box.className = "chan";
      box.dataset.chan = String(i);
      const n = document.createElement("span"); n.className = "n"; n.textContent = `iChannel${i}`;
      const kind = document.createElement("select");
      for (const k of KINDS) {
        const o = document.createElement("option"); o.value = k; o.textContent = k; o.selected = ch.kind === k;
        kind.appendChild(o);
      }
      kind.addEventListener("change", () => {
        d.channels[i] = kind.value === "buffer" ? { kind: "buffer", pass: "Buffer A" }
          : kind.value === "audio" ? { kind: "audio", band: "fft" }
            : kind.value === "image" ? { kind: "image", name: ch.name ?? "" } : { kind: "none" };
        save(); paintChannels(); push();
      });
      box.append(n, kind);
      if (ch.kind === "buffer") {
        const sel = document.createElement("select");
        for (const p of PASS_ORDER) { const o = document.createElement("option"); o.value = p; o.textContent = p; o.selected = (ch.pass ?? ch.buffer) === p; sel.appendChild(o); }
        sel.addEventListener("change", () => { ch.pass = sel.value; save(); push(); });
        box.appendChild(sel);
      } else if (ch.kind === "image") {
        // a picture for this channel: a button that says what it does, the picture itself, and its name
        const hidden = document.createElement("input");
        hidden.type = "file"; hidden.accept = "image/*"; hidden.hidden = true;
        const pick = document.createElement("button");
        pick.type = "button"; pick.dataset.pick = String(i);
        pick.textContent = ch.data ? "replace" : "choose picture";
        pick.title = ch.name ? `choose ${ch.name} again` : "a picture for this channel (kept in memory, not in storage)";
        const frame = document.createElement("span");
        frame.className = "prev";
        if (ch.data) {
          const img = document.createElement("img");
          img.src = ch.data; img.alt = ch.name ?? "channel picture"; img.title = ch.name ?? "";
          frame.appendChild(img);
        } else {
          frame.textContent = ch.name ? "?" : "-";
          frame.title = ch.name ? `${ch.name} is not loaded: choose it again` : "no picture chosen";
        }
        const label = document.createElement("span");
        label.className = "n";
        label.textContent = ch.data ? (ch.name ?? "picture") : ch.name ? `${ch.name} (choose again)` : "no picture";
        pick.addEventListener("click", () => hidden.click());
        hidden.addEventListener("change", () => {
          const file = hidden.files?.[0];
          if (!file) return;
          const rd = new FileReader();
          rd.onload = () => {
            ch.name = file.name; ch.data = String(rd.result);        // memory: storage keeps the CODE only
            save(); paintChannels(); push();
            say(`iChannel${i} <- ${file.name} (${Math.round(String(ch.data).length / 1024)} KB) - the canvas has it now; a reload asks for it again`);
          };
          rd.onerror = () => say(`could not read ${file.name}`, true);
          rd.readAsDataURL(file);
        });
        box.append(pick, hidden, frame, label);
      } else if (ch.kind === "audio") {
        const sel = document.createElement("select");
        for (const band of ["fft", "wave", "scope"]) { const o = document.createElement("option"); o.value = band; o.textContent = band; o.selected = ch.band === band; sel.appendChild(o); }
        sel.addEventListener("change", () => { ch.band = sel.value; save(); push(); });
        box.appendChild(sel);
      }
      chansEl.appendChild(box);
    });
  }
  const values = new Map();
  const paintVars = () => {
    varsEl.textContent = values.size
      ? [...values].map(([n, v]) => `${n} = ${v.value.join(", ")}  (${v.vec === 1 ? "float" : `vec${v.vec}`})`).join("\n")
      : "(nothing yet — put a live_loop in the music)";
  };
  /** Everything the canvas needs, sent now: a channel change must not wait for a Compile. */
  function push() {
    const d = doc();
    return globalThis.sonicPiCanvas?.setPasses?.({ Common: d.common ?? "", ...d.passes }, d.channels);
  }

  function paintAll() { paintPasses(); paintChannels(); paintVars(); codeEl.value = tab === SHARED ? (doc().common ?? "") : (doc().passes?.[tab] ?? ""); paintHl(); }

  codeEl.addEventListener("input", () => { remember(); saveSoon(); paintHl(); });
  codeEl.addEventListener("scroll", () => { hlEl.scrollTop = codeEl.scrollTop; hlEl.scrollLeft = codeEl.scrollLeft; });
  codeEl.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); return compile(tab); }
    if (e.key === "Tab") {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = codeEl;
      codeEl.value = `${value.slice(0, a)}    ${value.slice(b)}`;
      codeEl.selectionStart = codeEl.selectionEnd = a + 4; remember();
    }
  });

  /** Compile: what Shadertoy's button does -- check the passes, put them on the canvas, say what happened. */
  function compile(which = null) {
    remember();
    const d = doc();
    const passes = which ? [which] : PASS_ORDER;
    const problems = [];
    for (const pc of passes) {
      const src = (pc === SHARED ? d.common : d.passes[pc]) ?? "";
      if (!src.trim()) { if (pc === "Image") problems.push("Image is empty: the screen would draw nothing"); continue; }
      const o = (src.match(/\{/g) ?? []).length, c = (src.match(/\}/g) ?? []).length;
      if (o !== c) problems.push(`${pc}: braces do not balance (${o} { against ${c} })`);
      if (pc !== SHARED && !/void\s+mainImage\s*\(/.test(src)) problems.push(`${pc}: no void mainImage(out vec4 c, in vec2 p)`);
    }
    if (problems.length) { say(problems.join("\n"), true); return false; }
    const r = push() ?? { ok: [], failed: ["there is no canvas to compile into"] };
    say(r.failed.length ? `compiled ${r.ok.join(", ") || "nothing"}; not compiled: ${r.failed.join("; ")}`
      : `compiled ${r.ok.length} pass(es)`, r.failed.length > 0);
    return r.failed.length === 0;
  }
  /** The code's size: one number, worn by both layers, so the highlight cannot drift off the text. */
  const FS_KEY = "sp-gfx-code-size";
  let fontSize = Number((() => { try { return localStorage.getItem(FS_KEY); } catch { return null; } })()) || 13;
  function setFont(px) {
    fontSize = Math.max(9, Math.min(28, Math.round(px)));
    el.style.setProperty("--gfx-st-fs", `${fontSize}px`);
    try { localStorage.setItem(FS_KEY, String(fontSize)); } catch {}
    say(`code size ${fontSize}px`);
  }
  el.querySelector("#gfx-st-fs-up").addEventListener("click", () => setFont(fontSize + 1));
  el.querySelector("#gfx-st-fs-down").addEventListener("click", () => setFont(fontSize - 1));

  el.querySelector("#gfx-st-compile").addEventListener("click", () => compile(tab === SHARED ? SHARED : tab));
  el.querySelector("#gfx-st-compile-all").addEventListener("click", () => compile(null));

  el.querySelector("#gfx-st-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(serializeSet(set), null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(set.name ?? "shaders").replace(/\s+/g, "-")}.sonicpi-gfx.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    say(`exported ${set.documents.length} document(s) — the format the original pane reads and writes`);
  });
  const fileEl = el.querySelector("#gfx-st-file");
  el.querySelector("#gfx-st-import").addEventListener("click", () => fileEl.click());
  fileEl.addEventListener("change", async () => {
    const f = fileEl.files?.[0];
    if (!f) return;
    try {
      const next = deserialize(JSON.parse(await f.text()));
      if (!next?.documents?.length) throw new Error("no documents in that file");
      Object.assign(set, next);
      save(); paintAll();
      say(`imported ${set.documents.length} document(s) from ${f.name}`);
    } catch (e) { say(`that file did not read as a set: ${e?.message ?? e}`, true); }
  });

  // ── the audio side's way in: the same records the old layer took, the same syntax ────────────────────────
  function record(r) {
    const text = typeof r === "string" ? r : (r?.text ?? r?.message ?? r?.output ?? "");
    if (!/^\s*:?gfx/i.test(String(text).trim())) return false;
    const d = parseDirective(String(text));
    if (!d.ok) { say(`the music said something I could not read: ${d.error}`, true); return false; }
    if (d.command) { say(`the music asked for "${d.arg}" — switching documents is not wired to this page yet`); return false; }
    const vec = d.values.length;
    values.set(d.name, { value: d.values, vec });
    paintVars();
    // and on to the render loop -- without this the value only ever reached this panel, which is exactly how it
    // looked: the page showed "uGain = 0.5" while no shader ever saw it
    globalThis.sonicPiCanvas?.setVariable?.(d.name, d.values);
    return true;                                  // the panel above IS the report: saying it again was the duplicate
  }
  globalThis.sonicPiGfx = Object.assign(globalThis.sonicPiGfx ?? {}, { record });

  // ── the button ──────────────────────────────────────────────────────────────────────────────────────────
  const btn = document.createElement("button");
  btn.id = "gfx-st-btn";
  btn.type = "button";
  btn.textContent = "Shadertoy";
  btn.title = "the shader editor (Ctrl/Cmd+Alt+S)";
  btn.addEventListener("click", () => setOpen(!open));
  document.body.appendChild(btn);

  let open = false;
  function setOpen(next) {
    if (next === open) return false;
    if (!next) remember();
    open = next;
    document.body.dataset.gfxSt = open ? "open" : "closed";
    btn.textContent = open ? "Audio" : "Shadertoy";          // what clicking does, not what is on screen
    btn.setAttribute("aria-pressed", String(open));
    btn.title = open ? "back to the audio page (Ctrl/Cmd+Alt+S, or Escape)" : "the shader editor (Ctrl/Cmd+Alt+S)";
    if (open) { paintAll(); setTimeout(() => { paintHl(); codeEl.focus(); }, 0); }
    return true;
  }
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "s" || e.key === "S")) { e.preventDefault(); e.stopPropagation(); setOpen(!open); }
    else if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (open && (e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=")) { e.preventDefault(); setFont(fontSize + 1); }
    else if (open && (e.ctrlKey || e.metaKey) && (e.key === "-" || e.key === "_")) { e.preventDefault(); setFont(fontSize - 1); }
  }, true);

  document.body.dataset.gfxSt = "closed";
  setFont(fontSize);      // the remembered size, before the first paint
  paintAll();
  return { el, button: btn, open: () => open, set: setOpen, toggle: () => setOpen(!open), record,
    set: () => set, doc, values: () => Object.fromEntries([...values].map(([n, v]) => [n, v.value])), tab: () => tab };
}
