// SPDX-License-Identifier: AGPL-3.0-or-later
// One Elementary instance for the page, two ways in:
//   · code   -- the player's JavaScript, run as an expression or a module body (A 档 / B 档)
//   · MIDI   -- Sonic Pi is the sequencer; its midi_note_on/off reach here through the app's midi hook and play a built-in
//               polyphonic voice pool. Elementary never needs a clock of its own: the notes arrive when Sonic Pi says so.
// The node goes to the engine's input (through Sonic Pi's chain: with_fx, scope, Recorder), with a reader started so that input is
// actually read -- the same two steps Soundgineer takes (web/synth/host.js:100).

import { el } from "./vendor/core/dist/index.js";
import WebRenderer from "./vendor/web-renderer/dist/index.js";

export const API = { el };
const VOICES = 8;
const hz = (note) => 440 * Math.pow(2, (note - 69) / 12);

export const createElementary = () => {
  let core = null, node = null, ctx = null, started = false;
  const state = Array.from({ length: VOICES }, () => ({ note: null, vel: 0, ch: 0, on: false }));

  const engine = async () => {
    const s = globalThis.sonicPi;
    if (!s) throw new Error("sonicPi is not on this page");
    for (let i = 0; i < 200 && !s.engine; i++) await new Promise((r) => setTimeout(r, 50));
    if (!s.engine) throw new Error("the engine did not boot: run something in the Sonic Pi buffer first");
    return s.engine;
  };

  /**
   * The voice pool's graph. Each voice's frequency and gate are `el.const` nodes with a stable key, so rendering the graph again
   * with new values is how a note changes: the core reconciles by key and the node keeps its identity (this is the playground's
   * model -- no mutable refs needed).
   */
  const voiceGraph = () => {
    const voices = state.map((v, i) => el.mul(
      el.lowpass(1800, 1, el.blepsaw(el.const({ key: `v${i}f`, value: hz(v.note ?? 60) }))),
      el.adsr(0.005, 0.12, 0.6, 0.3, el.const({ key: `v${i}g`, value: v.on ? 1 : 0 }))));
    const mix = el.mul(0.18, el.add(...voices));
    return [mix, mix];
  };

  const start = async () => {
    if (started) return;
    const e = await engine();
    ctx = e.audioContext ?? e.node?.context ?? globalThis.spAudioContext;
    if (!ctx) throw new Error("no audio context on the engine");
    core = new WebRenderer();
    node = await core.initialize(ctx, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const target = e.node?.input ?? e.node;
    node.connect(target);
    let reader = false;
    if (!globalThis.sonicPiSynth?.readerStarted) {
      for (let i = 0; i < 8 && !reader; i++) {
        try { await globalThis.sonicPi?.session?.run?.("synth :sound_in_stereo, sustain: 3600, amp: 1", { group: 0 }); reader = true; }
        catch { await new Promise((r) => setTimeout(r, 500)); }
      }
    } else reader = true;
    if (!reader) { try { node.disconnect(target); } catch {} node.connect(ctx.destination); }

    await core.render(...voiceGraph());
    started = true;
  };

  const update = async () => { await core.render(...voiceGraph()); };

  /** A note from Sonic Pi. `rec` is the runtime's MIDI record: { path, args: [channel, note, velocity, …] }. */
  const handleMidi = (rec) => {
    if (!started) return null;
    const nums = (rec?.args ?? []).filter((x) => typeof x === "number");
    const path = String(rec?.path ?? "");
    const ch = nums[0] ?? 0, note = nums[1], vel = nums[2] ?? 100;
    if (note == null) return null;
    if (/note_on/i.test(path)) {
      let i = state.findIndex((v) => !v.on);
      if (i < 0) i = state.reduce((a, v, k) => (v.vel <= state[a].vel ? k : a), 0);   // steal the quietest
      state[i] = { note, vel: Math.max(1, Math.min(127, vel)) / 127, ch, on: true };
      update();
      return { voice: i, note, ch };
    }
    if (/note_off/i.test(path)) {
      const i = state.findIndex((v) => v.on && v.note === note && (ch === 0 || v.ch === ch));
      if (i < 0) return { released: false };
      state[i].on = false;
      update();
      return { voice: i, note, released: true };
    }
    return null;
  };

  /** Run the player's code. A 档: a body with `el` in scope; B 档: `export default { render() }` (see el-panel.js). */
  const run = async (code) => {
    await start();
    const isModule = /\bexport\s+default\b/.test(code);
    let out = null;
    if (isModule) {
      globalThis.__elemEl = el;
      const src = `const el = globalThis.__elemEl;\n${code}\n`;
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      try {
        const mod = await import(url);
        const api = mod.default;
        if (!api || typeof api.render !== "function") throw new Error("the module's default export needs a render() function");
        if (typeof api.getVirtualFileSystem === "function") {
          const vfs = await api.getVirtualFileSystem((b) => ctx.decodeAudioData(b));
          if (vfs && Object.keys(vfs).length) await core.updateVirtualFileSystem(vfs);
        }
        out = await api.render();
      } finally { URL.revokeObjectURL(url); }
    } else {
      let firstError = null;
      try { out = new Function("el", `"use strict";\nreturn (\n${code}\n);`)(el); } catch (e) { firstError = e; }
      if (out == null) {
        try { out = new Function("el", `"use strict";\n${code}\n`)(el); } catch (e) { throw e; }
      }
      if (out == null) throw new Error(firstError ? String(firstError.message) :
        "the code returned nothing: end with `return <node>`, or make the last line the node, e.g. el.cycle(440)");
    }
    if (out == null) throw new Error("render() returned nothing");
    const channels = Array.isArray(out) ? out.length : 1;
    if (Array.isArray(out)) await core.render(...out); else await core.render(out);
    return { channels, module: isModule };
  };

  const stop = async () => {
    if (!started) return;
    // silence both paths: the voice gates, and the code's graph
    state.forEach((v) => { v.on = false; });
    await update();
    await core.render(el.const({ key: "silence", value: 0 }), el.const({ key: "silence", value: 0 }));
  };

  return { start, run, stop, handleMidi, voices: () => state.map((v) => ({ ...v })), get ready() { return started; } };
};
