// SPDX-License-Identifier: AGPL-3.0-or-later
// A TAP: records what the engine's output sounds like, sample for sample, into a SharedArrayBuffer.
//
// Why it exists: the app's own capture ring is meant for the Record button, not for measurement. It must be
// drained continuously (the Recorder does it every 250 ms) and it DROPS SAMPLES between drains -- measured:
// beeps 1.2 s apart in the music came out 1.101/1.152 s apart in the ring. A comparison of two instants
// against the page's clock therefore drifts (13 ms in one run, 50 ms in the next). This tap cannot drop
// anything: the processor copies every block straight into a shared buffer until it is full, and the page
// reads it afterwards.
//
// Protocol (from web/gfx-tap.js):
//   { type: "start", sab, capacity }   begin writing at sample 0
//   { type: "stop" }                   stop writing
//   the header (Int32Array of 2) is [written samples, capacity]; the samples follow as Float32.
//
// The node is a pass-through (its output is its input) so it can be kept alive by a zero-gain connection
// without changing what is heard.

class GfxTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.header = null;
    this.data = null;
    this.capacity = 0;
    this.written = 0;
    this.recording = false;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === "start") {
        this.data = new Float32Array(m.sab, 8);          // 2 int32 of header first
        this.header = new Int32Array(m.sab, 0, 2);
        this.capacity = this.data.length;
        this.written = 0;
        this.header[0] = 0;
        this.header[1] = this.capacity;
        this.recording = true;
      } else if (m.type === "stop") {
        this.recording = false;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (output && input) output.set(input);              // pass-through: keep the node alive, change nothing
    if (this.recording && input) {
      // int32 index (not float): an index that overflows never loses a block
      if (this.written < this.capacity) {
        const n = Math.min(input.length, this.capacity - this.written);
        this.data.set(input.subarray(0, n), this.written);
        this.written += n;
        this.header[0] = this.written;                    // Atomics would be stricter; a single int32 write is atomic enough here
      }
      if (this.written >= this.capacity) this.recording = false;
    }
    return true;
  }
}

registerProcessor("gfx-tap", GfxTap);
