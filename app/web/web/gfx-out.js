// The output tab: draws the main tab's shader, on this window's own GPU surface, with no interface.
//
// This file is deliberately thin, because the rendering is NOT reimplemented here: it is the same
// gfx-canvas.js + gfx-renderer.js the main tab uses. What this page brings is the other half of the
// contract -- where the audio and the music's uniforms come from. In the main tab they come from the
// engine's analyser (gfx.js `feed()`); here they come off a BroadcastChannel, and everything else
// (the passes, the buffers, the ping-pong, the prelude, the channel resolution) is the same code, so
// the picture is the same picture rather than a lookalike.
//
// Protocol (main → out):
//   { t: "doc",   doc: {name, common, passes, channels}, images: {name: dataUrl} }
//   { t: "frame", fft, wave, uniforms: {uLevel, uBands}, clock: {time, frame}, mouse, sampleRate }
// (out → main): { t: "hello" } on load, { t: "bye" } on unload  -- the main tab only broadcasts when
// somebody is listening, so an app with no output window pays nothing.
import { createCanvas } from "./gfx-canvas.js";

const CHANNEL = "sonic-pi-gfx-output";
const note = document.getElementById("out-note");
const problemEl = document.getElementById("out-problem");

const out = createCanvas({ onProblem: (text) => { problemEl.textContent = text; } });
document.body.insertBefore(out.canvas, document.body.firstChild);
out.setSampleRate(() => sampleRate);

let sampleRate = 48000;
let last = null;                      // the last frame message
let shots = 0;                        // frames drawn since a document arrived (a probe reads this)
let currentDoc = null;

/** The audio and the music's values, put where the renderer reads them, just before it draws. */
out.onFeed(() => {
  if (!last) return;
  if (last.clock) out.setClock(last.clock.time, last.clock.frame);
  if (last.fft && last.wave) {
    const held = out.audio;
    const bins = Math.min(held.fft.length, last.fft.length);
    for (let i = 0; i < bins; i++) held.fft[i] = last.fft[i];
    const samples = Math.min(held.wave.length, last.wave.length);
    for (let i = 0; i < samples; i++) held.wave[i] = last.wave[i];
  }
  for (const [name, values] of Object.entries(last.uniforms ?? {})) out.set(name, values);
  sampleRate = last.sampleRate ?? sampleRate;
  shots++;
});

function adopt(message) {
  const { doc, images } = message;
  if (!doc) return;
  // the pictures this document names: decoded here, into this tab's own textures
  for (const [name, url] of Object.entries(images ?? {})) {
    const img = new Image();
    img.onload = () => out.addImage(name, img);
    img.src = url;
  }
  const result = out.compile(doc);
  currentDoc = doc;
  shots = 0;
  if (result && result.ok === false) {
    const bad = (result.failures ?? []).map((f) => `${f.pass}: ${String(f.report ?? "").split("\n")[0]}`).join("\n");
    problemEl.textContent = bad || "the shader did not compile";
  } else {
    problemEl.textContent = "";
    note.classList.add("gone");       // the picture is up: get out of the way
  }
}

const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
if (!channel) {
  note.textContent = "this browser has no BroadcastChannel, so an output tab cannot be fed";
} else {
  channel.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.t === "doc") adopt(m);
    if (m.t === "frame") { last = m; sampleRate = m.sampleRate ?? sampleRate; if (note.textContent) note.classList.add("gone"); }
  });
  channel.postMessage({ t: "hello" });
  window.addEventListener("pagehide", () => { try { channel.postMessage({ t: "bye" }); } catch { /* going away anyway */ } });
}

// ── the same renderer readout as the main tab, on this side of the link ─────────────────────────────
// A projector's machine is not the machine doing the editing: what matters here is what THIS window can
// do -- its resolution, its fps, its GPU. `g` toggles it, off by default so the picture stays clean.
let hud = null;
function hudText() {
  const p = out.perf?.();
  if (!p) return "no canvas";
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
  const gpu = p.gpuMs == null ? "gpu —" : `gpu ${p.gpuMs.toFixed(1)} ms`;
  return `${p.fps.toFixed(0)} fps · ${p.ms.toFixed(1)} ms · ${gpu} · ${p.passes.length} pass · `
    + `tex ${mb(p.memory?.total ?? 0)} · ${p.size.w}x${p.size.h} @${p.dpr.toFixed(2)}`
    + (last ? "" : " · waiting for the main tab");
}
function toggleHud() {
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "gfx-hud";
    hud.setAttribute("aria-hidden", "true");
    document.body.appendChild(hud);
    setInterval(() => { if (hud?.classList.contains("on")) hud.textContent = hudText(); }, 250);
  }
  hud.classList.toggle("on");
  hud.textContent = hudText();
}
document.addEventListener("keydown", (e) => { if (e.key === "g" || e.key === "G") toggleHud(); });

// F (or a click) goes fullscreen: a projector is a click away, and nothing else is on this page
const fullscreen = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); };
document.addEventListener("keydown", (e) => { if (e.key === "f" || e.key === "F") fullscreen(); });
document.addEventListener("click", fullscreen);

/**
 * What a probe (or a player with the console open) can ask this tab.
 *
 *   __gfxOut.state()    -> { connected, shots, document, frames, size }
 *   __gfxOut.capture()  -> the same PNG + mean the main tab's capture() gives
 */
window.__gfxOut = {
  state() {
    return {
      connected: !!last,
      shots,
      document: currentDoc ? { name: currentDoc.name, image: currentDoc.passes?.Image?.length ?? 0 } : null,
      size: { w: out.canvas.width, h: out.canvas.height },
      passes: out.live,
      error: problemEl.textContent || null,
      // what the last frame carried: the two links a probe (or a debugging player) wants to see
      uniforms: last?.uniforms ?? null,
      clock: last?.clock ?? null,
      hasAudio: !!(last?.fft && last?.wave),
    };
  },
  capture: (opts) => out.capture(opts),
};
