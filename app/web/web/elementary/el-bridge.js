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
    // The engine's INPUT, the same place synth-worklet.js connects to. sound_in_stereo reads it and the rest of Sonic Pi's chain
    // (mix, with_fx, scope, Recorder) follows.
    const target = e.node?.input ?? e.node;
    node.connect(target);
    started = true;
  };

  /** Run the code as a function of `el` and render what it returns. A mono node is upmixed by the renderer. */
  const run = async (code) => {
    await start();
    const fn = new Function("el", `"use strict";\n${code}\n`);
    const out = fn(el);
    if (out == null) throw new Error("the code returned nothing: end it with the node to hear, e.g. el.cycle(440)");
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
