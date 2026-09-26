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
//   window.sonicPi.session.clockNow()           ->  iTime (the engine's own clock, not the wall)
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
#gfx-toast {
  position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%) translateY(6px);
  z-index: 40; pointer-events: none; opacity: 0; transition: opacity 120ms ease, transform 120ms ease;
  padding: 5px 12px; border-radius: var(--r-pill, 999px); border: 1px solid var(--WindowBorder);
  background: var(--raisedSurface, var(--PaneBackground)); color: var(--WindowForeground);
  font: 600 var(--t-small, 13px) var(--code-font); white-space: nowrap;
}
#gfx-toast.on { opacity: 1; transform: translateX(-50%) translateY(0); }
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

  const problem = (text) => (log ? log(`Graphics — ${text}`) : console.warn(`Graphics — ${text}`));

  // ── the document ───────────────────────────────────────────────────────────────────────────────
  // What runs is one of the documents the editor holds (gfx-document.js, gfx-editor.js), and the
  // editor is where they are saved. Only code is ever saved: a picture a channel asks for is named,
  // never carried, so a document that wants one comes back wanting it.
  const compileDocument = (doc) => canvas.compile(doc);

  // ── the extension panel ────────────────────────────────────────────────────────────────────────
  // Every feature we add gets a section here and draws nothing of its own: see gfx-ui.js. The spec is
  // rebuilt rather than mutated, so a value that changes (the uniform list, once the shader links) is
  // just the next rebuild.
  const sections = () => [
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
            log?.(`Graphics — the test card is up as "${name}": iChannel0 the spectrum, iChannel1 the waveform, iChannel2 a picture (choose one and its swatch turns green)`);
          },
        },
        {
          kind: "button", label: "Reset to the default shader",
          title: `Put web/${SHADER_FILE} back as this document's Image pass and compile it. The other tabs of this document go.`,
          onClick: () => {
            pane?.loadDocument(emptyDocument("Default", shaderSource), { compileIt: true });
            log?.("Graphics — the default shader is back");
          },
        },
        {
          kind: "button", label: "Say the uniforms in the Log",
          title: "Write the list above into Sonic Pi's own Log panel",
          onClick: () => log?.(`Graphics — passes: ${canvas ? canvas.live.join(", ") || "none" : "none"}; the shader's own values: ${canvas ? canvas.userUniforms.join(", ") || "none" : "none"}`),
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
  ];

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
    log: (text) => log?.(text),
  });

  (async () => {
    const shader = await loadShader();
    shaderSource = shader.source;
    if (!shader.fromFile) problem(`${shader.why}, so the placeholder shader is running — it declares no uniform and answers no directive`);
    // the documents the editor holds, or a first one from the .frag: which one it lands on is the
    // one that was on screen when the page was left
    const doc = pane.load(() => emptyDocument("Default", shader.source));
    log?.(`Graphics — the document "${doc.name}" (${pane.documents.join(", ")}). Pictures are not saved: a channel that wants one draws a placeholder until it is uploaded again.`);
    canvas = createCanvas({ document: doc, onProblem: problem });
    if (!canvas) return;
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
    log?.(`Graphics — the shader's own values: ${canvas.userUniforms.join(", ") || "none"}; the frame's: ${canvas.renderer.builtins.join(", ")}`);
  })();

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
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "gfx-toast";
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("on"), 900);
  }

  document.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (e.defaultPrevented) return;     // the app's dispatcher already had this key: leave it alone
    e.preventDefault();
    stepOpacity(e.key === "ArrowUp" ? 1 : -1);
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
    if (appLog) log = appLog;
    const d = parseDirective(r?.text);
    if (!d) return;                                            // the player's own output: theirs
    if (!d.ok) return problem(d.error);
    // an order rather than a value for a name the shader declared
    if (d.command === "document") {
      documentDirective(d.arg);
      if (d.verbose) log?.(`Graphics — document ${d.arg}`);
      return;
    }
    if (!canvas) return;                                       // the shader never compiled; the problem is already said
    const result = canvas.set(d.name, d.values);
    if (!result.ok) return problem(result.error);
    if (d.verbose) log?.(`Graphics — ${d.name} = ${d.values.join(" ")} (${d.shape})`);
  }

  // The engine is null until the first Run, and its audio context is made then: watch until it
  // is there, then stop watching. A new context (the page reloaded the engine) is tapped again.
  const watch = setInterval(() => {
    const engine = window.sonicPi?.engine;
    if (!engine) return;
    if (attachAudio(engine)) clearInterval(watch);
  }, 500);

  window.sonicPiGfx = {
    record,
    canvas: null,
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
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
else install();
