// SPDX-License-Identifier: AGPL-3.0-or-later
// The upper layer: the player's `puts` lines become uniform values, and the audio becomes values too.
//
// Where this sits, and why it needs so little of Sonic Pi:
//
//   the player's program
//     puts :gfx, :uGain, 0.5
//       |  lang.rb:95 (upstream, untouched)
//   the runtime's outbox -> FRAME_GUI(kind 3) -> /sonic-pi/output  [t, text]
//       |  sonic_pi.js deliver() -> on.record(r)      <- the ONE hook, one line in main.js
//   gfx.js  (this file)     parse -> validate -> type
//       |  gfx-canvas.js  glGetActiveUniform -> uniform*()
//   the WebGL2 canvas behind the interface
//
// and beside it, with no hook at all:
//
//   window.sonicPi.engine.audioContext / .node  ->  AnalyserNode  ->  uLevel, uBands
//
// That is the ONLY thing this layer reads off `window.sonicPi`, and `iTime`/`iFrame` are its OWN clock
// (gfx-canvas.js: one rAF delta per frame). The engine's clock (`session.clockNow()`) is deliberately
// not used: it was only needed while a SECOND drawing context had to be kept in step with this one --
// the output tab, which was removed (see docs/graphics-web-canvas.md §4.12).
//
// Why there is a hook at all, since it is the only line of upstream this feature costs. A record
// reaches the page through the `on` handlers given to `createLiveSession` (sonic_pi.js:476), which
// are held in a private field and in a closure: there is no way to subscribe after the fact, and
// `window.sonicPi` does not expose them. Reading the Log's DOM instead was measured and rejected --
// `deliver()` drops a record older than STALE_SECS before it can reach the log (sonic_pi.js:412,
// "paints nothing for it"), so a directive would go silently missing whenever the page had been
// held, and MAX_LOG (main.js:732) drops old lines besides. A lost directive is a wrong picture,
// which is worse than a line of coupling.
//
// The hook passes us the app's own `logInfo`, so a rejected directive is reported where the player
// is already looking -- the Log panel, beside the `puts` line it came from.

import { parseDirective, SIGIL, SIGIL_VERBOSE } from "./gfx-directive.js";
import { createCanvas } from "./gfx-canvas.js";
import { createGrounds } from "./gfx-grounds.js";
import { createSettings, stepLevel } from "./gfx-settings.js";
import { createPanel } from "./gfx-ui.js";
import { createShaderPane, resolveDocument } from "./gfx-editor.js";
import { emptyDocument } from "./gfx-document.js";
import { testCardDocument, TEST_CARD } from "./gfx-testcard.js";
import { createSynthHost, isSynthOrder } from "./synth-host.js";
import { createModeSwitch } from "./gfx-mode.js";

const STYLE_ID = "gfx-style";
const ALPHA_KEY = "sp-gfx-ui-alpha";
const CANVAS_KEY = "sp-gfx-canvas";
const SHADER_FILE = "gfx-shader.frag";
const ALPHA_STEP = 0.05;                // one press of the opacity shortcut

// web/gfx-shader.frag is the shader, and the only copy of it: one file to edit, and editing it
// changes what runs on the next reload. This is what runs when that file cannot be fetched at all —
// a small pulsing thing, declaring nothing, plus a line in the Log saying the file was missing. A
// shader that has lost its file should LOOK like a placeholder rather than like a real picture that
// happens to be wrong, so this deliberately has no rings, no audio and no uniforms of its own.
const DEFAULT_SHADER = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2  uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  float r  = length(uv);
  float g  = 0.5 + 0.5 * sin(iTime * 0.6);
  fragColor = vec4(0.10 * g, 0.16 * g, 0.30 * g, 1.0) * (1.0 - smoothstep(0.4, 1.2, r));
}`;

const style = () => {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
html { background: #05070d; }
#gfx-canvas { position: fixed; inset: 0; width: 100%; height: 100%; z-index: -1; display: block; pointer-events: none; }
/* NOTHING here makes a surface translucent, and that is deliberate. Fading selectors was the first
   attempt and it was wrong: the code -- the thing the player is actually looking at -- gets its
   background from CodeMirror's own theme, which sets \`backgroundColor: var(--Background)\` INLINE on
   .cm-editor (editor.js:646) and --MarginBackground on .cm-gutters (:654). A rule on #editor-column
   cannot reach either: the editor paints over it. So lowering the opacity faded the toolbar, the
   sidebar and the seams -- a grey rim -- while the code sat there opaque.

   What is faded instead is the theme's own GROUND COLOURS, further down in this file: the tokens,
   not the selectors that use them. Every surface, inline styles included, follows a token. */

/* The shortcut's own readout: a key press that changes something the player cannot see the value of
   has to say what it changed, and the panel's slider is usually shut. A small pill at the foot of the
   window, and it goes away by itself -- nothing to dismiss mid-performance. */
/* The renderer readout (Ctrl+Alt+G, or the panel switch): TOP-LEFT, just under the app's own top bar.
   Where exactly was measured, not guessed: at top:10px the bar (0-38px tall) covered it completely --
   document.elementFromPoint() at the readout's own position returned sn-brand, so the readout WAS there
   and invisible, which is exactly how it was reported ("I cannot see fps in the UI"). It has to be
   readable WHILE the shader runs, so it is not in the panel (shut during a performance) and not in the
   editor pane (same). Monospace, the app's own foreground, a faint ground, and never a pointer target. */
/* "Picture only" (F9): the app's interface is hidden and the shader is what is on screen. It is CSS of
   ours over the app's own elements -- no upstream file is touched -- and it is meant for a projector or a
   second screen, or just for looking at the picture without the editor around it. */
html.gfx-picture-only #site-nav,
html.gfx-picture-only #site-strip,
html.gfx-picture-only #toolbar,
html.gfx-picture-only #main,
html.gfx-picture-only #statusbar,
html.gfx-picture-only #drawer,
html.gfx-picture-only #drawer-rail,
html.gfx-picture-only #info-card { display: none !important; }

#gfx-hud {
  font: 11px/1.3 var(--code-font, ui-monospace, monospace);
  color: var(--DefaultForeground, #ddd);
  pointer-events: none;              /* a readout is never in the way of a click */
  white-space: nowrap;
  opacity: 0; transition: opacity .15s ease;
}
#gfx-hud.in-bar {
  /* laid out BY the status bar: no coordinates, so nothing to get wrong when the interface zooms */
  align-self: center; margin: 0 10px 0 4px; width: max-content;   /* the box is the text, not the whole gap */
}
#gfx-hud:not(.in-bar) {
  /* no status bar to live in: out of the way in the corner, and the toast's z-index (measured to sit
     above the app's own chrome) */
  position: fixed; left: 10px; top: 8px; z-index: 40;
}
#gfx-hud.on { opacity: .92; }

#gfx-toast {
  position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%) translateY(6px);
  z-index: 40; pointer-events: none; opacity: 0; transition: opacity 120ms ease, transform 120ms ease;
  padding: 5px 12px; border-radius: var(--r-pill, 999px); border: 1px solid var(--WindowBorder);
  background: var(--raisedSurface, var(--PaneBackground)); color: var(--WindowForeground);
  font: 600 var(--t-small, 13px) var(--code-font); white-space: nowrap;
}
#gfx-toast.on { opacity: 1; transform: translateX(-50%) translateY(0); }
#gfx-toast.bad { border-color: var(--ErrorBackground); color: var(--ErrorBackground); }
`;
  document.head.appendChild(el);
};

// The ground colours -- what "UI opacity" really turns -- live in gfx-grounds.js, with the reason
// they are the thing to turn rather than the surfaces that use them (CodeMirror paints the editor's
// background itself, inline, from --Background, so a rule on an ancestor cannot reach it).
const grounds = createGrounds();
// The player's settings, read through gfx-settings.js: an absent entry and a legitimate 0 are
// different things, and confusing them is what made the opacity fall back to the default whenever
// the value was read again (a theme switch, a reload) instead of only when it was set.
const settings = createSettings();

/** How much of the interface's ground colour stays: 0 is a real choice, not "unset". */
const alpha = () => settings.number(ALPHA_KEY, { min: 0, max: 1, fallback: 0.82 });

/** Turn the ground colours into their translucent selves -- only while there is a picture behind them. */
const applyAlpha = (v) => (canvasOn() ? grounds.apply(Math.round(v * 100)) : grounds.clear());

/** The canvas is on unless it has been turned off; a stored "0" is the only thing that turns it off. */
/** The canvas is on unless it has been turned off. */
const canvasOn = () => settings.bool(CANVAS_KEY, true);

/** The frequency bands the audio is read in, in Hz -- what a player calls bass through treble. */
const BANDS = [[40, 250], [250, 800], [800, 3000], [3000, 12000]];

async function loadShader() {
  try {
    const res = await fetch(SHADER_FILE, { cache: "no-store" });
    if (res.ok) {
      const text = await res.text();
      if (text.trim()) return { source: text, fromFile: true };
    }
    return { source: DEFAULT_SHADER, fromFile: false, why: `${SHADER_FILE} was not found beside the page (${res.status})` };
  } catch (e) {
    return { source: DEFAULT_SHADER, fromFile: false, why: `${SHADER_FILE} could not be fetched (${e.message})` };
  }
}

function install() {
  if (window.sonicPiGfx) return;
  style();
  grounds.capture();               // what the theme painted, before we touch anything
  grounds.watch(() => applyAlpha(alpha()));   // and follow it when the player switches theme
  applyAlpha(alpha());
  document.documentElement.classList.add("gfx-on");

  let canvas = null;
  let pane = null;                 // the shader editor's pane (gfx-editor.js)
  let shaderSource = "";           // web/gfx-shader.frag: what the FIRST document starts from
  let log = null;                  // the app's logInfo, handed to us by the one hook
  let analyser = null, taps = null, bandBins = null;
  const level = { rms: 0 }, bandValues = [0, 0, 0, 0];

  const problem = (text) => {
    const line = `Graphics — ${text}`;
    if (!log) console.warn(line);              // said now, where a developer will see it
    say(line);                                 // and kept for the Log if there is not one yet
  };

  // The app hands us its own `logInfo` only WITH A RECORD -- that is, the first time the player's code
  // prints something, which is the first Run. Until then there is no Log to write to, and everything the
  // layer wanted to say (which shader it loaded, which document is running, the numbers a report asked
  // for) was silently dropped: a page nobody had run yet looked like a page where nothing had happened.
  // One of those lines is also the probe's proof that the detached starter reached its end -- so losing
  // it hid a real bug. What is said while there is no Log is held here and said the moment there is one.
  const unsaid = [];
  // Our own visible channel for what we have to say.
  //
  // The app's Log used to be the place, and after the upstream sync it no longer is: its lines are built lazily
  // (`logInfo` -> `append(logBox, { make })`, main.js:972) and text handed to that function appears in NO element
  // -- measured with a marker string, Log pane open and closed, waited for. The layer's news ("the shader
  // linked", a rejected directive, a report) was therefore invisible to the player, which is worse than noisy.
  // So we say it ourselves, in a slim bar, and keep handing it to the app's log as well for when that works.
  const sayBar = () => {
    let el = document.getElementById("gfx-say");
    if (!el) {
      el = document.createElement("div");
      el.id = "gfx-say";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
      const style = document.createElement("style");
      style.id = "gfx-say-style";
      style.textContent = `#gfx-say { position: fixed; left: 8px; right: 8px; bottom: 8px; z-index: 97;
        font: 12px/1.45 ui-monospace, monospace; color: var(--WindowForeground); background: color-mix(in srgb, var(--WindowBackground) 88%, transparent);
        border: 1px solid var(--WindowBorder); border-radius: 6px; padding: 6px 8px; max-height: 22vh; overflow: auto;
        white-space: pre-wrap; pointer-events: none; }
        #gfx-say:empty { display: none; }
        #gfx-say b { font-weight: 600; opacity: .8; }`;
      document.head.appendChild(style);
    }
    return el;
  };
  const say = (text) => {
    if (log) log(text); else if (unsaid.length < 60) unsaid.push(text);
    try {
      const bar = sayBar();
      const line = document.createElement("div");
      line.innerHTML = "<b>Graphics</b> ";
      line.appendChild(document.createTextNode(String(text)));
      bar.appendChild(line);
      while (bar.children.length > 8) bar.removeChild(bar.firstChild);     // the last few, then out of the way
      clearTimeout(say._t);
      say._t = setTimeout(() => { bar.textContent = ""; }, 20000);
      window.sonicPiGfx && (window.sonicPiGfx.lastSaid = String(text));
    } catch { /* a bar is not worth breaking the layer for */ }
  };

  // ── the numbers: fps, frame time, GPU time, memory ────────────────────────────────────────────────
  //
  // WHERE, and why there: a small readout in the TOP-LEFT corner of the picture, over the canvas.
  //   * it has to be visible while the shader is running (that is when the numbers mean anything), so it
  //     cannot live in the panel or the editor pane, both of which are shut during a performance;
  //   * the bottom of the window is the app's own: the status bar, the toast pill and the drawer all
  //     live there, and the rail is on the right -- the top-left corner is the one place nothing else
  //     claims (the top bar is a strip above it, and nothing is drawn under it);
  //   * it is OFF until asked for (Ctrl+Alt+G, or the panel switch), because a readout is a tool, not
  //     part of the picture -- and the output tab has the same readout on its own key, for looking at
  //     what the projector's machine can do.
  //
  // What it shows, in one line: fps, frame ms (and the worst of the window), GPU ms when the browser
  // will give it, how many passes are drawing, what we have allocated in textures, and the resolution.
  const HUD_KEY = "sp-gfx-hud";
  let hudEl = null, hudTimer = 0;

  const mb = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} kB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`);

  function hudText() {
    const p = canvas?.perf?.();
    if (!p) return "the shader canvas is not running";
    const gpu = p.gpuMs == null ? "gpu —" : `gpu ${p.gpuMs.toFixed(1)} ms`;
    return `${p.fps.toFixed(0)} fps · ${p.ms.toFixed(1)} ms (worst ${p.worstMs.toFixed(0)}) · ${gpu} · `
      + `${p.passes.length} pass${p.passes.length === 1 ? "" : "es"} · tex ${mb(p.memory?.total ?? 0)} · `
      + `${p.size.w}x${p.size.h} @${p.dpr.toFixed(2)}`;
  }

  function paintHud() {
    if (!hudEl) return;
    hudEl.textContent = hudText();
  }

  /**
   * Put the readout somewhere it can actually be seen -- measured, because the first version was not.
   *
   * It was `top: 10px; z-index: 6`, which is *inside the app's own toolbar* (the layout is: site-nav
   * 0-38px, toolbar 38-94px full width, the editor below that) and *below it* in the stacking order, so
   * the readout was there and invisible: "I cannot see fps in the UI". `elementFromPoint()` is no help
   * for checking this (the readout is `pointer-events: none`, so it never wins a hit test) -- the check
   * that works is a screenshot of its own corner with it on and off.
   *
   * So: below the toolbar (not over its buttons), clear of the rail whichever side it is on, and at the
   * toast's z-index, which is measured to sit above the app's chrome.
   */
  function placeHud() {
    if (!hudEl) return;
    // IN the status bar's own empty middle -- not positioned over the window at all.
    //
    // Two measured reasons. (1) The app's interface is zoomed/transformed, so a fixed element positioned
    // from getBoundingClientRect() coordinates lands somewhere else entirely: in the probe the readout
    // came out at y=2 while the bar was at y=248, i.e. "fixed" was not fixed to the viewport at all.
    // (2) Any overlay has to cover something, and the code buffer is what a player is using: the first
    // version sat at y=102, over the player's own music ("you mixed this line into my Sonic Pi buffer").
    // Letting the status bar lay it out removes both problems: the bar runs [status-engine][status-jobs]
    // [spacer 1042px][status-version], and the spacer is room the app itself left empty.
    //
    // The app may rebuild the bar's contents, so this re-checks where the readout lives rather than
    // trusting one append: it is called on every paint (4x a second) while the readout is on.
    const bar = document.getElementById("statusbar");
    const spacer = bar?.querySelector(".spacer");
    // ...and only when the bar is actually ON SCREEN: with the drawer open (or focus mode) the status bar
    // can have no layout at all, and a readout appended into a hidden row is a readout that vanished.
    const showing = !!bar && bar.getBoundingClientRect().height > 0;
    if (spacer && showing) {
      if (hudEl.parentElement !== spacer) spacer.appendChild(hudEl);
      hudEl.classList.add("in-bar");
      return;
    }
    if (hudEl.parentElement !== document.body) document.body.appendChild(hudEl);   // no status bar: fall back
    hudEl.classList.remove("in-bar");
  }

  /** The numbers with their names, in the Log -- the panel has a button for it. */
  function sayReport() {
    const p = canvas?.perf?.();
    if (!p) { say("Graphics — the shader canvas is not running, so there is nothing to report."); return; }
    const m = p.memory ?? {};
    const lines = [
      `fps ${p.fps.toFixed(1)} over the last ${p.samples} frames (frame ${p.ms.toFixed(2)} ms, worst ${p.worstMs.toFixed(1)} ms)`,
      p.gpuMs == null
        ? "GPU time: not available in this browser (EXT_disjoint_timer_query_webgl2 is missing; a software renderer or a driver that will not say)"
        : `GPU time: ${p.gpuMs.toFixed(2)} ms per frame`,
      `resolution ${p.size.w}x${p.size.h} (device pixel ratio ${p.dpr.toFixed(2)}), ${p.passes.length} pass(es) drawing: ${p.passes.join(", ") || "none"}`,
      `textures this layer allocated: ${mb(m.total ?? 0)} in all — render targets ${mb(m.targets ?? 0)} (${m.precision ?? "?"}), pictures ${mb(m.images ?? 0)}, audio ${mb(m.audio ?? 0)}`,
      `programs: ${p.programs.compiled} compiled, ${p.programs.reused} reused, ${p.programs.held}/${p.programs.cap} held`,
      m.renderer ? `GPU: ${m.renderer}${m.vendor ? ` (${m.vendor})` : ""}, max texture ${m.maxTexture}, float+linear ${m.floatLinear ? "yes" : "no"}` : "GPU: the browser hides the renderer string",
      "note: a browser cannot report the driver's memory, so the texture figure is what THIS layer allocated, not what the GPU holds.",
    ];
    say(`Graphics — renderer report\n${lines.join("\n")}`);
  }

  /**
   * Picture only: hide the app's interface and leave the shader.
   *
   * It is EXACTLY one class on <html>, and nothing else: it does not go fullscreen, it does not exit
   * fullscreen, it does not touch the browser's own state in any way. The picture is already the whole
   * window (#gfx-canvas is `position: fixed; inset: 0`); the interface is what is on top of it, so
   * hiding the interface IS the feature. The first version also asked for fullscreen on the way in,
   * which was wrong twice over: the player said the two have nothing to do with each other, and the
   * browser consumes Escape to leave fullscreen -- so Escape never reached this handler, the class
   * stayed on, and the interface did not come back. One thing, one switch.
   *
   * F9 toggles it (a pair with F8, which compiles: both are document-level and neither depends on where
   * the caret is). Escape also comes back. The readout survives it: it lives in the status bar, and when
   * that is hidden the fallback puts it in the corner (see placeHud).
   */
  const PICTURE_KEY = "sp-gfx-picture-only";
  const pictureOnly = (v) => {
    const on = v == null ? settings.bool(PICTURE_KEY, false) === true : v === true;
    if (v != null) settings.set(PICTURE_KEY, on);
    document.documentElement.classList.toggle("gfx-picture-only", on);
    if (on) toast("Picture only — F9 or Esc brings the interface back");
    placeHud();                                                  // the status bar may have just gone away
    return on;
  };

  document.addEventListener("keydown", (e) => {
    if (e.key === "F9") { e.preventDefault(); pictureOnly(!pictureOnly()); return; }
    if (e.key === "Escape" && document.documentElement.classList.contains("gfx-picture-only")) pictureOnly(false);
  }, true);

  function hudOn(v) {
    if (v == null) return settings.bool(HUD_KEY, true) === true;      // ON unless the player turned it off
    settings.set(HUD_KEY, v === true);
    if (v && !hudEl) {
      hudEl = document.createElement("div");
      hudEl.id = "gfx-hud";
      hudEl.setAttribute("aria-hidden", "true");     // a readout is not something to be read out
      document.body.appendChild(hudEl);
    }
    if (hudEl) hudEl.classList.toggle("on", v === true);
    if (v) {
      placeHud();
      paintHud();
      clearInterval(hudTimer);
      hudTimer = setInterval(() => { placeHud(); paintHud(); }, 250);   // four times a second: readable, free,
                                                                       // and it keeps up with a folding bar
    } else {
      clearInterval(hudTimer);
      hudTimer = 0;
    }
    return v === true;
  }

  // the key: Ctrl+Alt+G. Measured against the app's own catalogue, Ctrl+Alt is free apart from i/n/p,
  // and a letter with AltGr would type a character on some layouts -- G is not one of those three.
  window.addEventListener("resize", placeHud);
  document.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey) return;
    if (String(e.key).toLowerCase() !== "g") return;
    e.preventDefault();
    hudOn(!hudOn());
    toast(`renderer readout ${hudOn() ? "on" : "off"}`);
  }, true);


  // ── the document ───────────────────────────────────────────────────────────────────────────────
  // What runs is one of the documents the editor holds (gfx-document.js, gfx-editor.js), and the
  // editor is where they are saved. Only code is ever saved: a picture a channel asks for is named,
  // never carried, so a document that wants one comes back wanting it.
  const compileDocument = (doc) => canvas.compile(doc);

  // ── the extension panel ────────────────────────────────────────────────────────────────────────
  // Every feature we add gets a section here and draws nothing of its own: see gfx-ui.js. The spec is
  // rebuilt rather than mutated, so a value that changes (the uniform list, once the shader links) is
  // just the next rebuild.
  // Our own synthesizer lives in its own namespace (synth-host.js + synth.js + synth-worklet.js) and
  // publishes itself as `window.sonicPiSynth`. This layer only hands it the records it owns and its own
  // section of the panel -- nothing about the synth itself is written here.
  const synthHost = createSynthHost({ say: (t) => say(t), problem: (t) => problem(t) });
  window.sonicPiSynth = synthHost;

  const sections = () => [
    // a section of ours that is switched off returns null (see OWN_SYNTH in synth-host.js)
    synthHost.host.panelSection(),
    synthHost.host.synthdefSection(),
    {
      id: "interface",
      title: "Interface",
      items: [
        {
          kind: "note",
          text: "UI opacity fades the THEME'S GROUND COLOURS — the editor's own background and gutters included, since CodeMirror paints those itself — so the picture shows through the whole interface. The colours the text is drawn in are not touched, so live code stays legible on top.",
        },
        {
          kind: "slider", label: "UI opacity", min: 0, max: 100, step: 1,
          value: Math.round(alpha() * 100),
          format: (v) => `${v}%`,
          title: "How much of the interface's own ground colour stays. Lower shows more of the picture; the text is unaffected.",
          onInput: (v) => { settings.set(ALPHA_KEY, v / 100); applyAlpha(v / 100); },
        },
        {
          kind: "switch", label: "Shader canvas", value: canvasOn(),
          title: "Draw the shader behind the interface. Off leaves everything else working, and puts the interface's own grounds back to opaque.",
          onChange: (on) => {
            settings.set(CANVAS_KEY, on);
            if (canvas) canvas.canvas.style.display = on ? "" : "none";
            applyAlpha(alpha());
          },
        },
      ],
    },
    {
      id: "shader",
      title: "Shader",
      items: [
        {
          kind: "switch", label: "Picture only (no interface)", value: document.documentElement.classList.contains("gfx-picture-only"),
          title: "Hide the app's interface and leave the shader filling the window — for a projector or a second screen. F9 toggles it, Escape comes back. The app keeps running: the music, the directives and the readout all carry on.",
          onChange: (on) => pictureOnly(on),
        },
        {
          kind: "switch", label: "Renderer readout", value: hudOn(),
          title: "A one-line readout in the top-left corner of the picture: fps, frame time (and the worst of the window), GPU time when the browser will give it, passes drawing, the textures this layer allocated, and the resolution. Ctrl+Alt+G toggles it.",
          onChange: (on) => hudOn(on),
        },
        {
          kind: "button", label: "Say the renderer's numbers in the Log",
          title: "The same readout with every number named, plus the GPU's own name and the program cache: for working out where the milliseconds go.",
          onClick: () => sayReport(),
        },
        {
          kind: "button", label: "Open the shader editor",
          title: "The tabs, the code and the channels, in the panel at the foot of the window (the picture frame in the rail)",
          onClick: () => pane?.open(),
        },
        {
          kind: "note",
          text: `The editor is a pane of the bottom drawer — the picture frame in the rail. web/${SHADER_FILE} is only what the FIRST document starts from; what runs is what the editor holds. What is saved is the code: an uploaded picture is kept in this session and named, never carried.`,
        },
        {
          kind: "list", label: "Uniforms the shader really has (from the link, not its source):",
          items: canvas ? [...canvas.userUniforms, ...canvas.renderer.builtins.map((b) => `${b} (frame)`)] : ["— the shader has not linked yet"],
        },
        {
          kind: "button", label: "Test card: audio + a picture",
          title: "A new document that draws the spectrum, the waveform and a picture, so all three can be seen working. iChannel0 and iChannel1 are wired to the audio for you; choose a picture on iChannel2 and its swatch turns green.",
          onClick: () => {
            const doc = testCardDocument();
            const name = pane?.addDocument(TEST_CARD, doc.name);
            pane?.setChannels(doc.channels);
            ui.close();
            say(`Graphics — the test card is up as "${name}": iChannel0 the spectrum, iChannel1 the waveform, iChannel2 a picture (choose one and its swatch turns green)`);
          },
        },
        {
          kind: "button", label: "Reset to the default shader",
          title: `Put web/${SHADER_FILE} back as this document's Image pass and compile it. The other tabs of this document go.`,
          onClick: () => {
            pane?.loadDocument(emptyDocument("Default", shaderSource), { compileIt: true });
            say("Graphics — the default shader is back");
          },
        },
        {
          kind: "button", label: "Say the uniforms in the Log",
          title: "Write the list above into Sonic Pi's own Log panel",
          onClick: () => say(`Graphics — passes: ${canvas ? canvas.live.join(", ") || "none" : "none"}; the shader's own values: ${canvas ? canvas.userUniforms.join(", ") || "none" : "none"}`),
        },
      ],
    },
    {
      id: "next",
      title: "Coming here",
      items: [
        { kind: "note", text: "The rest of the desktop graphics feature lands in this panel, one section each." },
      ],
    },
  ].filter(Boolean);

  const ui = createPanel({
    title: "Extensions",
    sections: sections(),
    // rebuilt on open, so a list that could only be known later (the shader's uniforms) is right
    onOpen: () => ui.rebuild(),
  });

  // The editor's pane, in the drawer. Made now rather than with the canvas below, because it is
  // what the rail's button opens and a player who opens it before the first Run should find the
  // editor and the code rather than a pane that is not there yet. Its `canvas` is read late.
  pane = createShaderPane({
    compile: compileDocument,
    canvas: () => canvas,
    starter: () => shaderSource,           // a new document starts from web/gfx-shader.frag
    onCompiled: (answer, bad) => toast(`Shader: ${answer}`, bad),   // the compile key works from anywhere, so its answer shows anywhere
    log: (text) => say(text),
  });


  // Wrapped: this runs detached (an async IIFE nobody awaits), so a throw here used to end in an
  // unhandled rejection and NO canvas, with the Log saying nothing -- exactly the shape of bug that
  // costs an afternoon. Whatever goes wrong, it is said out loud and the panel still opens.
  (async () => {
   try {
    const shader = await loadShader();
    shaderSource = shader.source;
    if (!shader.fromFile) problem(`${shader.why}, so the placeholder shader is running — it declares no uniform and answers no directive`);
    // the documents the editor holds, or a first one from the .frag: which one it lands on is the
    // one that was on screen when the page was left
    hudOn(hudOn());                                   // the readout is ON by default: show it now (the panel
                                                    // section reads the same setting, so the switch agrees)
    const doc = pane.load(() => emptyDocument("Default", shader.source));
    say(`Graphics — the document "${doc.name}" (${pane.documents.join(", ")}). Pictures are not saved: a channel that wants one draws a placeholder until it is uploaded again.`);
    canvas = createCanvas({ document: doc, onProblem: problem });
    if (!canvas) { window.sonicPiGfx.started = true; return; }    // no WebGL2: said as a problem, and that is that
    canvas.canvas.setAttribute("aria-hidden", "true");
    canvas.canvas.style.display = canvasOn() ? "" : "none";
    document.body.insertBefore(canvas.canvas, document.body.firstChild);
    canvas.setSampleRate(() => taps?.ctx.sampleRate ?? 48000);
    canvas.onFeed(feed);
    window.sonicPiGfx.canvas = canvas.canvas;
    // the editor shows the document that is running, and only now can the channels point anywhere
    pane.loadDocument(doc);
    pane.uniformsChanged();
    pane.restore();                                  // the pane was open when the page was left
    ui.rebuild();                                    // the uniform list is only knowable now
    say(`Graphics — the shader's own values: ${canvas.userUniforms.join(", ") || "none"}; the frame's: ${canvas.renderer.builtins.join(", ")}`);
    window.sonicPiGfx.started = true;                // read the note on `started`: the starter is detached
   } catch (e) {
    window.sonicPiGfx.error = (e && e.message) || String(e);
    problem(`the layer could not start (${(e && e.message) || e}) — the picture is not running`);
    console.error("Graphics — start failed:", e);
   }
  })();

  // ── the top bar's tabs leave for sonic-pi.net ───────────────────────────────────────────────────
  // This app IS the editor; the site's pages (Home, Examples, Learn, Tutorial, Support) live on
  // sonic-pi.net, and the user asked for the bar's buttons to point there rather than at the copies
  // in this tree. So the links are rewritten as the app starts -- in OUR layer, so upstream's build
  // and its own tests are untouched, and so the change holds in dev and in the packaged site alike.
  //
  // They open a NEW TAB on purpose: a performance is running, and navigating the only tab away from
  // the editor would stop the music.
  //
  // The local copies stay where they are: the Info card FETCHES a page's own document to show it
  // inside the app (info.js textOf -> fileOf), so deleting them would break Info rather than tidy up.
  const SITE_URL = "https://sonic-pi.net/";
  const SITE_PAGES = { about: "index.html", examples: "examples.html", learn: "learn.html", tutorial: "tutorial.html", support: "support.html" };
  // The site's pages as FILES, for the anchors that name one directly (the Info card's own body is full
  // of them: `index.html`, `tutorial.html`, `support.html`). `code.html` is deliberately NOT here -- it
  // is this app -- and neither is `specs.html`, which is the spec browser in this tree.
  const SITE_FILES = new Set([...Object.values(SITE_PAGES), "index.html", "examples.html", "learn.html", "support.html", "tutorial.html"]);
  const isSiteFile = (file) => SITE_FILES.has(file) || /^tutorial-[0-9a-z]+\.html$/.test(file);   // a chapter a page

  /** The official URL an anchor of ours should point at, or null if it is not ours to move. */
  function outwardOf(a) {
    if (!a || a.dataset.gfxOutward || !a.getAttribute) return null;
    const href = a.getAttribute("href") ?? "";
    // same page (`#mac`), or something that is already somebody else's or a scheme (`https:`, `mailto:`)
    if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
    const parts = href.split(/(?=[?#])/);                        // index.html#mac -> ["index.html", "#mac"]
    if (!isSiteFile(parts[0])) return null;
    return SITE_URL + parts.join("");
  }

  /**
   * Send every anchor that names one of this tree's own site pages to the official site, in a new tab.
   *
   * Why this is not only the tab row: the Info card's BODY is a copy of the page, and it is full of
   * cross-page links ("the app for macOS" is `index.html#mac`). In the shipped product `index.html` is a
   * redirect to `code.html` (see build-for-cdn.sh), so such a link would reload the whole editor and lose
   * the anchor -- mid-performance, from a click a player made to read something. The page it names is the
   * official site's page and lives there, so that is where it goes.
   *
   * The card's content is fetched and adopted LATER (info.js), so a pass at load is not enough: a
   * MutationObserver catches each page as it arrives. Only childList is watched -- this function sets
   * attributes, and watching those would be a loop.
   */
  function sendPagesOutward(root = document) {
    const anchors = root.matches?.("a[href]") ? [root] : [];
    if (root.querySelectorAll) anchors.push(...root.querySelectorAll("a[href]"));
    let moved = 0;
    for (const a of anchors) {
      const url = outwardOf(a);
      if (!url) continue;
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      a.dataset.gfxOutward = "1";
      moved++;
    }
    return moved;
  }

  function sendTabsOutward() {
    const nav = document.getElementById("site-nav");
    if (!nav) return 0;
    let moved = 0;
    for (const a of nav.querySelectorAll(".ic-tabs a[data-tab]")) {
      const file = SITE_PAGES[a.dataset.tab];
      if (!file || a.href.startsWith(SITE_URL)) continue;         // unknown tab, or already moved
      a.href = SITE_URL + file;
      a.target = "_blank";
      a.rel = "noopener";
      moved++;
    }
    const brand = nav.querySelector(".sn-brand");
    if (brand && !brand.href.startsWith(SITE_URL)) {               // the wordmark is the site's home
      brand.href = SITE_URL;
      brand.target = "_blank";
      brand.rel = "noopener";
    }
    // `a.sn-code` (the editor) and every one of the app's own toolbar buttons are left alone
    return moved;
  }

  sendTabsOutward();
  sendPagesOutward();
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) sendPagesOutward(n);
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("load", () => { sendTabsOutward(); sendPagesOutward(); });   // and once more, after the page settles

  // Changing the href is not enough, and this is where the first attempt failed: the app has its OWN
  // handlers on that row (info.js) which preventDefault and show the LOCAL page inside the Info card.
  // So a plain left click kept landing on this tree's pages -- exactly what was reported as "the tabs
  // still go to the local dev pages". The click is taken in the CAPTURE phase (before the app's own
  // listeners, which are on the row itself) and the official page is opened instead. A modified click
  // (Cmd/Ctrl/Shift) is left alone: that is the browser's own new-tab gesture and the href is right.
  //
  // The card's own body links are taken the same way (`a[data-gfx-outward]`): they are ordinary anchors
  // inside a page the app adopted, and a capture listener is the only thing that can keep info.js from
  // swapping the card to a local page instead.
  //
  // The app's own tap handler is on `pointerup` and ignores a drag of more than 12px, so this does the
  // same: a scroll that starts on the row must not open anything.
  const TAB_SELECTOR = "#site-nav .ic-tabs a[data-tab], #site-nav .sn-brand, a[data-gfx-outward]";
  let pressedAt = null, openedAt = 0;
  const siteOf = (el) => {
    if (el.dataset.gfxOutward) return el.href;                    // already pointing at the official page
    if (el.classList.contains("sn-brand")) return SITE_URL;
    const file = SITE_PAGES[el.dataset.tab];
    return file ? SITE_URL + file : null;
  };
  document.addEventListener("pointerdown", (e) => {
    pressedAt = e.target?.closest?.(TAB_SELECTOR) ? { x: e.clientX, y: e.clientY } : null;
  }, true);
  const leave = (e) => {
    const el = e.target?.closest?.(TAB_SELECTOR);
    if (!el) return;
    if (e.type === "pointerup" && (!pressedAt || Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) > 12)) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;             // the browser's new tab: let it have it
    const url = siteOf(el);
    if (!url) return;
    e.preventDefault();
    e.stopImmediatePropagation();                                 // and the app's own handler never runs
    if (performance.now() - openedAt < 600) return;               // pointerup then click: one tab, not two
    openedAt = performance.now();
    window.open(url, "_blank", "noopener");
  };
  document.addEventListener("pointerup", leave, true);
  document.addEventListener("click", leave, true);

  // ── an exported shader file opens from the app's own Open ───────────────────────────────────────
  // What went wrong once, and is worth not repeating: a player looking for "load a file" reaches for
  // the toolbar's Open, not for a pane they must open first -- so the exported JSON was picked up by
  // the app's loader and PASTED INTO THE CODE BUFFER as if it were Ruby, with the iChannels untouched.
  // (The input would not even offer a .json in its file dialog.) So the input is taught to accept one,
  // and a file that is OURS is taken by this layer instead. Everything else -- .rb, .txt, .sonicpi --
  // is left entirely to the app, sets included.
  const loadInput = document.getElementById("load-file");
  if (loadInput) {
    loadInput.accept = `${loadInput.accept},.json,application/json`;
    document.addEventListener("change", (e) => {
      const input = e.target;
      if (input !== loadInput) return;
      const file = input.files?.[0];
      if (!file) return;
      if (!/\.json$/i.test(file.name) && file.type !== "application/json") return;   // the app's, not ours
      e.stopImmediatePropagation();                     // before the app's own handler does the pasting
      input.value = "";                                 // so the same file can be opened twice
      file.text().then(async (text) => {
        const result = await pane?.importSet(text);
        if (!result?.ok) {
          toast(`not a shader document set: ${result?.error ?? "unreadable"}`, true);
          say(`Graphics — that file could not be opened: ${result?.error ?? "unreadable"}`);
          return;
        }
        const pictures = result.images?.length ? ` and ${result.images.length} picture${result.images.length > 1 ? "s" : ""}` : "";
        toast(`opened ${result.documents.length} shader document${result.documents.length > 1 ? "s" : ""}${pictures}`);
        say(`Graphics — opened ${result.documents.join(", ")}${pictures} from ${file.name}`);
      }).catch((err) => toast(`could not read ${file.name}: ${err.message}`, true));
    }, true);
  }

  // ── the opacity shortcut ───────────────────────────────────────────────────────────────────────
  // Ctrl+Alt+Up / Ctrl+Alt+Down, 5% a press, because a performance should not need the mouse and the
  // panel. Chosen by MEASURING what is taken rather than by taste: of the 163 chords this app's own
  // catalogue claims (shortcut-defs.js + shortcuts.js, all three keymaps) plus its ad-hoc ones
  // (Ctrl+G, Ctrl+R, Ctrl+A in the log), nothing is on Ctrl+Alt with an arrow -- only i, n and p are
  // on Ctrl+Alt at all. It is also free of the two traps that catch the obvious alternatives: the
  // browser keeps Ctrl+Shift+O (bookmarks) and Ctrl+Shift+I (devtools) to itself, and Ctrl+Alt with
  // a LETTER is AltGr on a German or Polish layout, which would type a character instead. AltGr does
  // not touch the arrow keys, so this chord cannot be a character on any layout.
  //
  // Listening here rather than registering a command with app.js's dispatcher (the user's choice) means
  // this file must answer the conflict question itself -- hence the note above, and hence the guard
  // below: the app's dispatcher runs first (it is a capture listener registered earlier) and stops any
  // chord it owns, so `defaultPrevented` is exactly "that key was already somebody's".
  const stepOpacity = (direction) => {
    const next = stepLevel(alpha(), direction, ALPHA_STEP);
    settings.set(ALPHA_KEY, next);
    applyAlpha(next);
    if (ui.isOpen) ui.rebuild();        // the panel's slider follows if it is on screen...
    // ...and either way the readout says where it landed: the slider is usually shut, and a key that
    // changes something invisible has to answer "by how much?" (the panel reads `alpha()` when it is
    // opened, so a rebuild for a shut panel would be work nobody sees)
    toast(`UI opacity ${Math.round(next * 100)}%`);
    return next;
  };

  let toastEl = null, toastTimer = 0;
  function toast(text, bad = false) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "gfx-toast";
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.toggle("bad", bad);
    toastEl.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("on"), 900);
  }

  document.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.defaultPrevented) return;     // the app's dispatcher already had this key: leave it alone

    // Compile: F8, on its own, NOT in the Ctrl+Alt family the opacity key uses -- the user was clear
    // that the two have nothing to do with each other. F8 because it is free in all three of the app's
    // keymaps and no browser claims it (F7 is Firefox's caret browsing, F5 reloads, F11/F12 are taken),
    // and because a function key is the old convention for "build" rather than something invented here.
    //
    // Document-level, and that is the lesson this key cost twice: a shortcut that only works with the
    // editor focused does nothing whenever the focus is elsewhere -- in the player's Sonic Pi code, in
    // the Log, or nowhere. (The app's own documentation card makes #main `inert` while it shows, and
    // then nothing in this pane can be focused at all.) The user reported "the compile key does not
    // work" twice; both times the key was fine and the focus was the problem.
    if (e.key === "F8") {
      if (!pane?.isOpen()) return;      // nothing is being edited: a compile would change nothing
      e.preventDefault();
      return void pane.compile();
    }

    // The opacity: Ctrl+Alt+Up / Down, 5% a press. Measured free in the app's catalogue (see the note
    // above), and free of the two traps that catch the obvious alternatives: the browser keeps
    // Ctrl+Shift+O and Ctrl+Shift+I to itself, and Ctrl+Alt with a LETTER is AltGr on a German or
    // Polish layout, which would type a character. AltGr does not touch the arrow keys.
    if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      stepOpacity(e.key === "ArrowUp" ? 1 : -1);
    }
  }, true);

  /** The audio, from the engine's own output node -- the same tap the scope uses. */
  function attachAudio(engine) {
    const ac = engine?.audioContext ?? engine?.node?.context;
    if (!ac || !engine.node) return false;
    if (analyser?.context === ac) return true;                 // already tapped this context
    // fftSize 1024 is not arbitrary: it is what makes the analyser's 512 bins land one per column of
    // the audio texture, with the newest 512 of its 1024 samples as the waveform (gfx-renderer.js)
    analyser = Object.assign(ac.createAnalyser(), { fftSize: 1024, smoothingTimeConstant: 0.6 });
    engine.node.connect(analyser);
    taps = { ctx: ac, time: new Float32Array(analyser.fftSize), freq: new Float32Array(analyser.frequencyBinCount), connected: true };
    const binHz = ac.sampleRate / analyser.fftSize;
    bandBins = BANDS.map(([lo, hi]) => [
      Math.max(0, Math.floor(lo / binHz)),
      Math.min(analyser.frequencyBinCount - 1, Math.ceil(hi / binHz)),
    ]);
    return true;
  }

  function feed() {
    if (!taps) return;
    analyser.getFloatTimeDomainData(taps.time);
    let sum = 0;
    for (let i = 0; i < taps.time.length; i++) sum += taps.time[i] * taps.time[i];
    const rms = Math.sqrt(sum / taps.time.length);
    level.rms = Math.max(rms, level.rms * 0.90);               // fast up, slow down: a picture, not a meter

    analyser.getFloatFrequencyData(taps.freq);                 // dBFS, so -100..0 becomes 0..1
    for (let b = 0; b < bandBins.length; b++) {
      const [from, to] = bandBins[b];
      let peak = -Infinity;
      for (let i = from; i <= to; i++) if (taps.freq[i] > peak) peak = taps.freq[i];
      const v = Number.isFinite(peak) ? Math.max(0, Math.min(1, (peak + 90) / 90)) : 0;
      bandValues[b] = Math.max(v, bandValues[b] * 0.90);
    }
    const clamped = Math.max(0, Math.min(1, level.rms * 6));   // a little gain: RMS on music sits low
    canvas.setIfPresent("uLevel", [clamped]);
    canvas.setIfPresent("uBands", bandValues);

    // ...and the same reading, as a texture a shader can sample (Shadertoy's 512x2 layout: the FFT
    // row, then the waveform row). Filled in place, so a frame allocates nothing, and bounded by the
    // data rather than by the array -- how many columns there are is the analyser's business.
    const held = canvas.audio;
    const norm = (db) => Math.max(0, Math.min(1, (db + 90) / 90));         // dBFS, as uBands does it
    const bins = Math.min(held.fft.length, taps.freq.length);
    for (let x = 0; x < bins; x++) held.fft[x] = norm(taps.freq[x]);
    const samples = Math.min(held.wave.length, taps.time.length);
    const from = taps.time.length - samples;                               // the newest samples
    for (let x = 0; x < samples; x++) held.wave[x] = Math.max(0, Math.min(1, (taps.time[from + x] + 1) / 2));

  }

  /** `puts :gfx, :document, "rings"` — which document is on screen, from the music. */
  function documentDirective(arg) {
    if (!pane) return problem("the editor is not up yet, so there is nothing to switch to");
    const target = resolveDocument(pane.documents, pane.current, arg);
    if (target.error) return problem(target.error);
    if (target.name === pane.current) return;   // already there: saying so on every beat would flood the Log
    if (!pane.switchTo(target.name)) problem(`could not switch to "${target.name}"`);
  }

  /** One record, from the hook. Only `output` can carry a directive. */
  function record(r, appLog) {
    if (appLog) {
      log = appLog;
      // published, so a probe (or a person in the console) can SEE whether the app has handed its Log over:
      // it arrives only with the first record, and "our news went nowhere" is otherwise indistinguishable
      // from "our news was never said".
      if (window.sonicPiGfx) window.sonicPiGfx.logReady = true;   // the published object (gfx.js:856)
      while (unsaid.length) say(unsaid.shift());    // what was said while there was no Log, in order
      // (through say, not log: the same lines must reach OUR bar too, or the news a player missed
      //  stays invisible -- which is the bug this whole path exists to fix)
    }
    // `puts :synth, …` is the synthesizer's language, not ours (synth-directive.js)
    if (synthHost.host.handleRecord(r)) return;
    const d = parseDirective(r?.text);
    if (!d) return;                                            // the player's own output: theirs
    if (!d.ok) return problem(d.error);
    // an order rather than a value for a name the shader declared
    if (d.command === "document") {
      documentDirective(d.arg);
      if (d.verbose) say(`Graphics — document ${d.arg}`);
      return;
    }
    if (!canvas) return;                                       // the shader never compiled; the problem is already said
    const result = canvas.set(d.name, d.values);
    if (!result.ok) {
      // `puts :gfx, :note, 69`: that name belongs to the synthesizer, and saying so beats "the shader
      // declares no uniform called note"
      if (isSynthOrder(d.name)) return problem(`${d.name} is an order for the synthesizer: say :synth, :${d.name} (the :gfx sigil is for the shader's own values)`);
      return problem(result.error);
    }
    if (d.verbose) say(`Graphics — ${d.name} = ${d.values.join(" ")} (${d.shape})`);
  }

  // The engine is null until the first Run, and its audio context is made then: watch until it
  // is there, then stop watching. A new context (the page reloaded the engine) is tapped again.
  const watch = setInterval(() => {
    const engine = window.sonicPi?.engine;
    if (!engine) return;
    if (attachAudio(engine)) clearInterval(watch);
  }, 500);

  // the top-level switch between the two halves of the page (gfx-mode.js)
  const modeSwitch = createModeSwitch({ onChange: (m) => say(`switched to ${m}`) });

  window.sonicPiGfx = {
    modeSwitch,
    record,
    canvas: null,
    /**
     * Has the layer finished starting? The starter below runs DETACHED, and a throw in it used to leave
     * the interface, the panel and this whole API perfectly installed with no canvas and no word said --
     * so "is the picture up?" needs an answer that is not read off the interface. It becomes true only
     * on the last line of the starter; `error` is what stopped it, or null.
     */
    started: false,
    error: null,
    /** The extension panel (gfx-ui.js): the place every feature we add puts its controls. */
    ui,
    /** The shader editor's pane (gfx-editor.js): the tabs, the code and the channels. */
    get pane() { return pane; },
    /** What the passes declare: the player's own values, and the frame's. */
    get uniforms() { return canvas ? canvas.usable : []; },
    /** Every pass that has a program drawing right now. */
    get passes() { return canvas ? canvas.live : []; },
    /** Set one by hand, as the directive would: `sonicPiGfx.set("uGain", [0.5])` */
    set: (name, values) => canvas?.set(name, values) ?? { ok: false, error: "no canvas" },
    /**
     * The picture the shader is drawing, as a PNG data URL: an audio-visual script's "screenshot",
     * without the interface in it and without disturbing the animation (gfx-canvas.js `capture()`).
     *
     *     const shot = await sonicPiGfx.capture();                 // { dataUrl, width, height, mean, frame }
     *     const small = await sonicPiGfx.capture({ scale: 0.5 });
     *
     * `mean` is the average luminance (0 = black) -- the cheapest way for a script to tell "something
     * drew" from "that pass is off".
     */
    capture: (opts) => (canvas ? canvas.capture(opts) : Promise.reject(new Error("the shader canvas is not running"))),

    /** What the frame costs: fps, frame ms (window), GPU ms if the browser will say, memory we allocated. */
    perf: () => canvas?.perf?.() ?? null,
    /** Picture only: `pictureOnly()` reads it, `pictureOnly(true|false)` sets it. `F9` toggles it. */
    pictureOnly,
    /** The readout in the corner: `hud()` reads it, `hud(true|false)` sets it. `Ctrl+Alt+G` toggles it. */
    hud: (v) => hudOn(v),
    /** The long version, into the Log: every number with its name, for when one line is not enough. */
    report() { sayReport(); return true; },
    reload: () => location.reload(),
    alpha(v) { if (v == null) return alpha(); settings.set(ALPHA_KEY, v); applyAlpha(v); ui.rebuild(); return v; },
    canvasOn(v) {
      if (v == null) return canvasOn();
      settings.set(CANVAS_KEY, v);
      if (canvas) canvas.canvas.style.display = v ? "" : "none";
      applyAlpha(alpha());       // the grounds fade only while there is a picture to show through
      ui.rebuild();
      return v;
    },
    sigils: [SIGIL, SIGIL_VERBOSE],
  };
}

// `app.js` is what sets window.sonicPi, and it is a module: this one runs after it. The engine
// itself is null until the first Run, so the canvas goes in now and the audio is attached later.
function installSafely() {
  try {
    install();
  } catch (e) {
    // nothing here can fix it, but silence cannot be debugged: a throw in install() used to mean the whole
    // layer was simply absent, and the page went on to behave like an app without graphics. That happened
    // for real (a wiring member that was never exported), and the only trace was in the console -- so now
    // the reason is ON THE PAGE, where whoever notices "everything is gone" is actually looking.
    const why = String(e?.message ?? e);
    console.error("Graphics — the layer could not install, so there is no shader canvas, no editor pane and no directives:", e);
    try {
      window.sonicPiGfx = { ...(window.sonicPiGfx ?? {}), error: why };
      if (!document.getElementById("gfx-install-error")) {
        const bar = document.createElement("div");
        bar.id = "gfx-install-error";
        bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;padding:6px 10px;" +
          "background:rgb(150 40 30 / 92%);color:#fff;font:12px/1.45 system-ui,sans-serif;white-space:pre-wrap";
        bar.textContent = `Graphics — the layer could not install, so there is no shader canvas, no editor ` +
          `pane and no directives:\n${why}`;
        bar.addEventListener("click", () => bar.remove());
        (document.body ?? document.documentElement).appendChild(bar);
      }
    } catch { /* showing the reason must never be the thing that breaks */ }
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installSafely);
else installSafely();
