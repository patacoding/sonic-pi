// SPDX-License-Identifier: AGPL-3.0-or-later
// Elementary, from the page's side: a WebRenderer whose output goes to the engine's INPUT, exactly where our own synth's worklet goes
// (web/synth.js and docs/web-synth-engine.md §5). So Elementary's sound is Sonic Pi's to process: with_fx wraps it, the scope shows
// it, the Recorder captures it. No microphone, no second AudioContext.
//
// Live coding here is what @elemaudio/web-renderer makes it: render the graph again and the core reconciles the nodes it already has,
// so an edit changes the sound without stopping it. There is no musical clock in this first version -- the graph is a function of the
// code, not of a beat.

import { el } from "./vendor/core/dist/index.js";
import WebRenderer from "./vendor/web-renderer/dist/index.js";

export const API = { el };
export const createElementary = () => {
  let core = null, node = null, ctx = null, started = false;

  /** The engine boots lazily, on the first Run, so wait for it before touching its input. */
  const engine = async () => {
    const s = globalThis.sonicPi;
    if (!s) throw new Error("sonicPi is not on this page");
    for (let i = 0; i < 200 && !s.engine; i++) await new Promise((r) => setTimeout(r, 50));
    if (!s.engine) throw new Error("the engine did not boot: run something in the Sonic Pi buffer first");
    return s.engine;
  };

  const start = async () => {
    if (started) return;
    const e = await engine();
    ctx = e.audioContext ?? e.node?.context ?? globalThis.spAudioContext;
    if (!ctx) throw new Error("no audio context on the engine");
    core = new WebRenderer();
    node = await core.initialize(ctx, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    // The engine's INPUT, where synth-worklet.js goes and where Soundgineer goes: through Sonic Pi's mix, with_fx, scope and
    // Recorder. That input is only read while Sonic Pi itself runs `synth :sound_in_stereo`, so one is started here -- the same call
    // Soundgineer's startReader makes, and skipped when Soundgineer already has a reader of its own (two would read the input twice).
    const target = e.node?.input ?? e.node;
    node.connect(target);
    let reader = false;
    if (!globalThis.sonicPiSynth?.readerStarted) {
      for (let i = 0; i < 8 && !reader; i++) {
        try {
          await globalThis.sonicPi?.session?.run?.("synth :sound_in_stereo, sustain: 3600, amp: 1", { group: 0 });
          reader = true;
        } catch { await new Promise((r) => setTimeout(r, 500)); }
      }
    } else reader = true;
    // If no reader could be started the input would be silent, so fall back to the destination: audible, but outside Sonic Pi's chain.
    if (!reader) { try { node.disconnect(target); } catch {} node.connect(ctx.destination); }
    started = true;
  };

  /** Run the code as a function of `el` and render what it returns. A mono node is upmixed by the renderer. */
  const run = async (code) => {
    await start();
    // Accept both: a body with `return`, and a bare expression (the last line a REPL would evaluate). Trying the expression first
    // keeps `el.cycle(440)` working, and the body form keeps `const c = ...; return ...` working.
    let out = null, firstError = null;
    try { out = new Function("el", `"use strict";\nreturn (\n${code}\n);`)(el); } catch (e) { firstError = e; }
    if (out == null) {
      try { out = new Function("el", `"use strict";\n${code}\n`)(el); } catch (e) { throw e; }
    }
    if (out == null) throw new Error(firstError ? String(firstError.message) :
      "the code returned nothing: end with `return <node>`, or make the last line the node, e.g. el.cycle(440)");
    if (Array.isArray(out)) await core.render(...out); else await core.render(out);
    return { channels: Array.isArray(out) ? out.length : 1 };
  };

  /** Stop: render silence, and keep the renderer so the next Run does not re-initialise it. */
  const stop = async () => {
    if (!started) return;
    await core.render(el.const({ key: "silence", value: 0 }), el.const({ key: "silence", value: 0 }));
  };

  return { start, run, stop, get ready() { return started; } };
};
