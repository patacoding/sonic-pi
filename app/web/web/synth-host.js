// SPDX-License-Identifier: AGPL-3.0-or-later
// The host: everything that has to be true of our synthesizer *from the page's point of view*.
//
// It owns the two objects (the synth and its measuring tap), speaks the `:synth` language
// (synth-directive.js) to play them from the music, says what happens in the Log, and publishes the whole
// thing as `window.sonicPiSynth`. The graphics layer (gfx.js) knows only two of its methods: it hands every
// record over (`handleRecord`) and it asks where its panel section is (`sections`), so nothing about the
// synth lives in the graphics files.
//
//     window.sonicPiSynth            the synth (noteOn/noteOff/set/loadWaveform/…) and .tap (lossless capture)
//     window.sonicPiSynth.host       handleRecord / sections / stop, for the layer that hosts it
//
// Timing: a note played from the music lands on its record's own `time` (the engine clock), i.e. the same
// instant the same line's `synth`/`sample` lands on -- measured to 72 samples = 1.50 ms in
// tools/synth-align-probe. See docs/web-synth-engine.md §7.

import { createSynth } from "./synth.js";
import { createTap } from "./synth-tap.js";
import { parseSynthDirective, isSynthOrder, SYNTH_SIGIL, SYNTH_SIGIL_VERBOSE, SYNTH_COMMANDS } from "./synth-directive.js";

export { SYNTH_SIGIL, SYNTH_SIGIL_VERBOSE, isSynthOrder, SYNTH_COMMANDS };

/**
 * @param {{
 *   say?: (text: string) => void,        // a line for the Log ("Synth — …")
 *   problem?: (text: string) => void,    // something the player must see
 *   section?: (title: string) => object, // a panel section to fill, if the layer has a panel
 * }} opts
 */
export function createSynthHost({ say = null, problem = null, section = null } = {}) {
  const text = (t) => (say ? say(`Synth — ${t}`) : console.info(`Synth — ${t}`));
  const warn = (t) => (problem ? problem(t) : console.warn(t));
  const synth = createSynth({ log: text });
  const tap = createTap({ log: text });

  /**
   * A record, if it is one of ours. Returns true when it was (so the caller stops looking at it).
   * The record's `time` is in the engine clock's seconds, so `time - clockNow()` is the delay until the
   * instant the line sounds at -- which is what makes a note from the music line up with the line's synth.
   */
  function handleRecord(r) {
    const d = parseSynthDirective(r?.text);
    if (!d) return false;
    if (!d.ok) { warn(d.error); return true; }
    const delay = () => {
      const now = globalThis.sonicPi?.session?.clockNow?.();
      return typeof now === "number" && typeof r?.time === "number" ? Math.max(0, r.time - now) : 0;
    };
    synth.ensure().then(() => {
      if (d.command === "note") {
        const at = delay();
        synth.noteOn(d.note, { velocity: d.velocity, when: at });
        synth.noteOff(d.note, { when: at + d.hold });      // its own release: nothing is left hanging
        if (d.verbose) text(`note ${d.note} (velocity ${d.velocity}, held ${d.hold}s)`);
        return;
      }
      if (d.command === "off") { synth.noteOff(d.note, { when: delay() }); if (d.verbose) text(`off ${d.note}`); return; }
      if (d.command === "alloff") { synth.allNotesOff({ when: delay() }); if (d.verbose) text("all notes off"); return; }
      synth.set(d.param === "cutoff" ? { filter: { cutoff: d.value } }
              : d.param === "res" ? { filter: { q: d.value } }
              : { gain: d.value });
      if (d.verbose) text(`${d.param} = ${d.value}`);
    }).catch((e) => warn(`the synth could not be played: ${e.message}`));
    return true;
  }

  const state = { wave: "saw", cutoff: 1200, gain: 0.25, filterType: "lp" };

  /**
   * A row of choices, built with the app's own markup (`.pref-row` / `.seg` / `.sp-mini-btn` are global in
   * style.css, so the panel paints them in whatever theme is showing). gfx-ui's own `list` item is
   * display-only, and its `custom` item is exactly the hook for controls that are not its business.
   */
  const chooser = (label, options, current, choose) => ({
    kind: "custom",
    make: () => {
      const row = document.createElement("div");
      row.className = "pref-row";
      const name = document.createElement("span");
      name.textContent = label;
      row.appendChild(name);
      const group = document.createElement("div");
      group.className = "seg";
      for (const option of options) {
        const b = document.createElement("button");
        b.className = "sp-mini-btn";
        b.textContent = option;
        if (option === current()) b.classList.add("on");
        b.addEventListener("click", () => {
          choose(option);
          for (const other of group.children) other.classList.toggle("on", other === b);
        });
        group.appendChild(b);
      }
      row.appendChild(group);
      return row;
    },
  });
  const push = () => synth.set({ wave: state.wave, filter: { cutoff: state.cutoff, type: state.filterType }, gain: state.gain });
  const waves = ["saw", "square", "triangle", "sine"];
  const filters = ["lp", "bp", "hp"];

  /**
   * The synth's own section of the panel, in the app's declarative item language (gfx-ui.js). It is a
   * function so the layer can call it whenever it rebuilds its sections, and it never touches the DOM
   * itself. `loadWaveform` gets a real file picker: the click opens it, so the browser's user-activation
   * rule is satisfied.
   */
  function panelSection() {
    return {
      title: "Synth",
      items: [
        chooser("Waveform", waves, () => state.wave, (w) => { state.wave = w; push(); }),
        chooser("Filter", filters, () => state.filterType, (f) => { state.filterType = f; push(); }),
        { kind: "slider", label: "Cutoff", min: 80, max: 12000, step: 10, value: state.cutoff,
          onInput: (v) => { state.cutoff = v; push(); } },
        { kind: "slider", label: "Gain", min: 0, max: 0.8, step: 0.01, value: state.gain,
          onInput: (v) => { state.gain = v; push(); } },
        { kind: "button", label: "Load a wavetable…", title: "a single-cycle .wav (decoded, turned into harmonics)",
          onClick: () => pickWaveform() },
        { kind: "note", text: "Play it from the music: puts :synth, :note, 69" },
      ],
    };
  }

  /** A real file picker (a real click, so the browser allows it), then the file becomes the oscillator's table. */
  function pickWaveform() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*,.wav,.wave";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      synth.ensure()
        .then(() => synth.loadWaveform(file))
        .then((r) => text(`wavetable "${file.name}" loaded (${r.samples} samples, ${r.harmonics.length} harmonics)`))
        .catch((e) => warn(`the wavetable could not be loaded: ${e.message}`));
    });
    input.click();
  }

  // The published object keeps the synth's own properties as they are -- descriptors, not a spread: a
  // spread would EVALUATE its getters once (`ready`, `inbound`, `patch`, `messages`) and freeze them at
  // whatever they were when this line ran.
  const api = Object.defineProperties({}, Object.getOwnPropertyDescriptors(synth));
  api.tap = tap;                    // the lossless measuring tap
  api.host = { handleRecord, panelSection, pickWaveform, get synth() { return synth; }, get tap() { return tap; } };
  return api;
}
