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

const STYLE_ID = "gfx-style";
const ALPHA_KEY = "sp-gfx-ui-alpha";
const SHADER_FILE = "gfx-shader.frag";

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
/* The interface over the picture. Each surface keeps its own colour and loses only its opacity,
   so the theme still decides what it looks like; --gfx-ui-pct is what the player turns.
   The selectors are the ones style.css gives these backgrounds to: body/#toolbar/#site-nav take
   --WindowBackground (style.css:35,56,116), #editor-column takes --Background (:301), and
   #sidebar/#info-card/.ic-body take --PaneBackground (:1029,:132,:136). */
html.gfx-on body,
html.gfx-on #toolbar,
html.gfx-on #site-nav { background: color-mix(in srgb, var(--WindowBackground) var(--gfx-ui-pct, 82%), transparent); }
html.gfx-on #editor-column { background: color-mix(in srgb, var(--Background) var(--gfx-ui-pct, 82%), transparent); }
html.gfx-on #sidebar,
html.gfx-on #info-card,
html.gfx-on .ic-body { background: color-mix(in srgb, var(--PaneBackground) var(--gfx-ui-pct, 82%), transparent); }
`;
  document.head.appendChild(el);
};

const alpha = () => {
  const v = Number(localStorage.getItem(ALPHA_KEY));
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.82;
};
const applyAlpha = (v) => document.documentElement.style.setProperty("--gfx-ui-pct", `${Math.round(v * 100)}%`);

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
  applyAlpha(alpha());
  document.documentElement.classList.add("gfx-on");

  let canvas = null;
  let log = null;                  // the app's logInfo, handed to us by the one hook
  let analyser = null, taps = null, bandBins = null;
  const level = { rms: 0 }, bandValues = [0, 0, 0, 0];

  const problem = (text) => (log ? log(`Graphics — ${text}`) : console.warn(`Graphics — ${text}`));

  (async () => {
    const shader = await loadShader();
    if (!shader.fromFile) problem(`${shader.why}, so the placeholder shader is running — it declares no uniform and answers no directive`);
    canvas = createCanvas({ source: shader.source, onProblem: problem });
    if (!canvas) return;
    canvas.canvas.setAttribute("aria-hidden", "true");
    document.body.insertBefore(canvas.canvas, document.body.firstChild);
    canvas.setSampleRate(() => taps?.ctx.sampleRate ?? 48000);
    canvas.onFeed(feed);
    window.sonicPiGfx.canvas = canvas.canvas;
    log?.(`Graphics — ${canvas.usable.length} uniform${canvas.usable.length === 1 ? "" : "s"} in the shader: ${canvas.usable.join(", ") || "none"}`);
  })();

  /** The audio, from the engine's own output node -- the same tap the scope uses. */
  function attachAudio(engine) {
    const ac = engine?.audioContext ?? engine?.node?.context;
    if (!ac || !engine.node) return false;
    if (analyser?.context === ac) return true;                 // already tapped this context
    analyser = Object.assign(ac.createAnalyser(), { fftSize: 2048, smoothingTimeConstant: 0.6 });
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
  }

  /** One record, from the hook. Only `output` can carry a directive. */
  function record(r, appLog) {
    if (appLog) log = appLog;
    const d = parseDirective(r?.text);
    if (!d) return;                                            // the player's own output: theirs
    if (!d.ok) return problem(d.error);
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
    get uniforms() { return canvas ? [...canvas.uniforms].map(([n, u]) => `${n}:${u.type ?? "unsupported"}`) : []; },
    /** Set one by hand, as the directive would: `sonicPiGfx.set("uGain", [0.5])` */
    set: (name, values) => canvas?.set(name, values) ?? { ok: false, error: "no canvas" },
    reload: () => location.reload(),
    alpha(v) { if (v == null) return alpha(); localStorage.setItem(ALPHA_KEY, String(v)); applyAlpha(v); return v; },
    sigils: [SIGIL, SIGIL_VERBOSE],
  };
}

// `app.js` is what sets window.sonicPi, and it is a module: this one runs after it. The engine
// itself is null until the first Run, so the canvas goes in now and the audio is attached later.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
else install();
