// SPDX-License-Identifier: AGPL-3.0-or-later
// The page's side of the tap (web/synth-tap-worklet.js): a lossless recording of what the engine's output
// sounds like, for measuring rather than for listening.
//
// It exists because the app's own capture ring drops samples between drains (see the worklet's header), and
// "how far apart are these two onsets" needs an instrument that cannot drop anything.
//
// It is a pass-through node, kept alive by a zero-gain path to the speakers: nothing is added to the sound.

const TAP_WORKLET = new URL("synth-tap-worklet.js", import.meta.url);
const SECONDS = 8;                       // enough for a few bars of measurement

export function createTap({ log = null } = {}) {
  const say = (t) => (log ? log(`Synth — ${t}`) : console.info(`Synth — ${t}`));
  let node = null, ctx = null, sab = null, header = null, data = null, sink = null, loading = null, failed = null;

  const engine = () => globalThis.sonicPi?.engine ?? null;

  async function ensure() {
    if (node) return node;
    if (failed) throw failed;
    if (loading) return loading;
    loading = (async () => {
      const eng = engine();
      const context = eng?.audioContext ?? eng?.node?.context;
      if (!context) throw new Error("the engine is not up yet (press Run once)");
      if (!context.audioWorklet) throw new Error("this browser has no AudioWorklet");
      if (typeof SharedArrayBuffer !== "function" || !globalThis.crossOriginIsolated) {
        throw new Error("the tap needs cross-origin isolation (SharedArrayBuffer): see docs/deploy-cdn-upyun.md §3.2");
      }
      await context.audioWorklet.addModule(TAP_WORKLET);
      const capacity = Math.floor(context.sampleRate * SECONDS);
      sab = new SharedArrayBuffer(8 + capacity * 4);
      header = new Int32Array(sab, 0, 2);
      data = new Float32Array(sab, 8);
      node = new AudioWorkletNode(context, "synth-tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      node.port.postMessage({ type: "start", sab });      // configured once; start/stop just flips the flag
      ctx = context;
      sink = new GainNode(context, { gain: 0 });          // keep the node in the graph without being heard
      node.connect(sink);
      sink.connect(context.destination);
      engine().node.connect(node);                        // the engine's output is what we record
      return node;
    })().catch((e) => { failed = e; loading = null; throw e; });
    return loading;
  }

  const send = (m) => { node?.port.postMessage(m); };

  return {
    get node() { return node; },
    get ready() { return !!node; },
    ensure,
    /** Begin a fresh recording at sample 0. */
    start() { send({ type: "start", sab }); return true; },
    stop() { send({ type: "stop" }); return true; },
    /** How many samples are recorded so far. */
    get written() { return header ? header[0] : 0; },
    get capacity() { return header ? header[1] : 0; },
    /** A copy of what was recorded (so the buffer can be reused), plus the rate to turn samples into time. */
    read() {
      if (!header) return { samples: new Float32Array(0), frames: 0, sampleRate: 0 };
      const frames = Math.min(header[0], header[1]);
      return { samples: data.slice(0, frames), frames, sampleRate: ctx?.sampleRate ?? 0 };
    },
  };
}
