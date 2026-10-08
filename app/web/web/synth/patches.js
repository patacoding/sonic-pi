// The instrument numbers the music uses: program (0..127) -> a patch.
//
// Numbers, not names, because MIDI is numbers -- and the names live here for the UI to show, so a player can see
// which channel is which instrument and which number picks it. Each patch is a list of Soundgineer parameter ids
// with normalised values (0..1), exactly what setParamById takes; a real preset importer (Soundgineer's factory
// presets, later Vital's) would fill this same shape rather than replace the idea.
export const DEFAULT_PROGRAM = 0;      // Init: what a fresh channel sounds like

export const PATCHES = [
  { n: 0, name: "Init",    params: { "osc1.enabled": 1, "osc1.level": 0.7, "filter1.enabled": 1, "filter1.cutoff": 0.8, "filter1.resonance": 0.1, "env1.attack": 0.01, "env1.decay": 0.4, "env1.sustain": 0.6, "env1.release": 0.3, "master.volume": 0.7 } },
  { n: 1, name: "Bass",    params: { "osc1.enabled": 1, "osc1.level": 0.8, "filter1.enabled": 1, "filter1.cutoff": 0.28, "filter1.resonance": 0.25, "env1.attack": 0.0, "env1.decay": 0.35, "env1.sustain": 0.25, "env1.release": 0.2, "master.volume": 0.8 } },
  { n: 2, name: "Pad",     params: { "osc1.enabled": 1, "osc2.enabled": 1, "osc2.detune": 0.15, "filter1.enabled": 1, "filter1.cutoff": 0.55, "env1.attack": 0.4, "env1.decay": 0.6, "env1.sustain": 0.7, "env1.release": 0.7, "master.volume": 0.5 } },
  { n: 3, name: "Lead",    params: { "osc1.enabled": 1, "filter1.enabled": 1, "filter1.cutoff": 0.62, "filter1.resonance": 0.35, "env1.attack": 0.02, "env1.decay": 0.3, "env1.sustain": 0.5, "env1.release": 0.25, "delay.enabled": 1, "delay.mix": 0.25, "master.volume": 0.7 } },
  { n: 4, name: "Perc",    params: { "osc1.enabled": 1, "noise.enabled": 1, "noise.level": 0.5, "filter1.enabled": 1, "filter1.cutoff": 0.7, "env1.attack": 0.0, "env1.decay": 0.12, "env1.sustain": 0.0, "env1.release": 0.1, "master.volume": 0.8 } },
];

export const patchByProgram = (n) => PATCHES.find((p) => p.n === Number(n)) ?? null;

/** What the UI shows: which number is which instrument, and how the music addresses it. */
export function guide() {
  const lines = PATCHES.map((p) => `  program ${String(p.n).padStart(2)}  ${p.name}`);
  return [
    "Driving this synth from the music (MIDI, numbers on purpose):",
    "",
    "  midi_pc <channel>, <program>          pick the instrument for that channel",
    "  midi_note_on <note>, <velocity>, channel: <channel>",
    "  midi_note_off <note>, channel: <channel>",
    "  midi_cc <cc>, <value>, channel: <channel>     (parameter map, see below)",
    "",
    "  channel = which instrument slot (0 -> main, n -> chN; 16 available)",
    "  program = which patch:",
    ...lines,
    "",
    "  example:  midi_pc 1, 0  then  midi_note_on 40, 110, channel: 1",
  ].join("\n");
}
