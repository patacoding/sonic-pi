// The Vital parameters this converter maps, with the range and scale each one is stored in.
//
// Vital stores a parameter in a space of its own: envelope times are seconds ** (1/4) (2.37842 ** 4 == 32 seconds),
// oscillator level is quadratic, volume is square-root, several effect rates are exponential. Reading a value without
// its own scale is how a preset imports and still sounds wrong, which is what this file exists to prevent.
//
// Where the facts come from: Vital's own parameter definitions as published in its source-generated documentation
// (ValueDetails: name, min, max, default, scale), cross-checked against serum2vital's write path, which is GPL-3 and is
// therefore used as a reference only -- no table of its making is copied here, just the format facts, and only for the
// parameters this converter actually writes.
//
// scale meanings, in the direction this file needs them (stored -> real):
//   linear       real = stored
//   quadratic    real = stored^2        (stored = sqrt(real))
//   cubic        real = stored^3
//   quartic      real = stored^4        (stored = real^(1/4))
//   square_root  real = sqrt(stored)    -- "Volume" is the only one that matters here: its stored default 5473.0404
//                                         is sqrt(73.98), and with the entry's post_offset of -80 that is -6.02 dB
//   exponential  real = 2 ** stored     -- confirmed by the declared ranges: reverb_decay_time -6..6 is 0.0156..64 s,
//                                         chorus_frequency -6..3 is 0.0156..8 Hz, phaser_frequency -5..2 is 0.031..4 s
//   indexed      a menu index; not a continuous quantity at all

/** [min, max, default, scale] for the parameters we map. Anything absent is reported rather than guessed. */
export const VITAL_PARAMS = {
  // envelopes: quartic times, the classic trap
  env_1_attack: [0, 2.37842, 0.1495, 'quartic'], env_2_attack: [0, 2.37842, 0.1495, 'quartic'],
  env_3_attack: [0, 2.37842, 0.1495, 'quartic'], env_4_attack: [0, 2.37842, 0.1495, 'quartic'],
  env_5_attack: [0, 2.37842, 0.1495, 'quartic'], env_6_attack: [0, 2.37842, 0.1495, 'quartic'],
  env_1_hold: [0, 1.4142135624, 0, 'quartic'], env_1_decay: [0, 2.37842, 1, 'quartic'],
  env_1_release: [0, 2.37842, 0.5476, 'quartic'],
  // oscillators
  osc_1_level: [0, 1, 0.70710678119, 'quadratic'], osc_2_level: [0, 1, 0.70710678119, 'quadratic'],
  osc_3_level: [0, 1, 0.70710678119, 'quadratic'],
  osc_1_unison_detune: [0, 10, 4.472135955, 'quadratic'], osc_2_unison_detune: [0, 10, 4.472135955, 'quadratic'],
  osc_3_unison_detune: [0, 10, 4.472135955, 'quadratic'],
  osc_1_unison_voices: [1, 16, 1, 'indexed'], osc_1_wave_frame: [0, 256, 0, 'linear'],
  osc_1_phase: [0, 1, 0.5, 'linear'], osc_1_transpose: [-48, 48, 0, 'indexed'], osc_1_tune: [-1, 1, 0, 'linear'],
  // filters: 8..136 with a default of 60 is MIDI note numbers (60 = middle C), not Hz -- see vitalMidiToHz below
  filter_1_cutoff: [8, 136, 60, 'linear'], filter_2_cutoff: [8, 136, 60, 'linear'],
  filter_1_resonance: [0, 1, 0.5, 'linear'], filter_1_drive: [0, 20, 0, 'linear'],
  filter_1_keytrack: [-1, 1, 0, 'linear'],
  // lfos
  lfo_1_frequency: [-7, 9, 1, 'exponential'], lfo_1_phase: [0, 1, 0, 'linear'],
  lfo_1_sync: [0, 4, 1, 'indexed'], lfo_1_delay_time: [0, 4, 0, 'linear'],
  // effects and master
  volume: [0, 7399.4404, 5473.0404, 'square_root'], polyphony: [1, 32, 8, 'indexed'],
  chorus_frequency: [-6, 3, -3, 'exponential'], reverb_decay_time: [-6, 6, 0, 'exponential'],
  delay_frequency: [-2, 9, 2, 'exponential'], distortion_drive: [-30, 30, 0, 'linear'],
};

/** The stored value turned into the real quantity the table's min/max are expressed in. */
export function vitalToReal(value, scale) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  switch (scale) {
    case 'linear': return v;
    case 'quadratic': return v * v;
    case 'cubic': return v * v * v;
    case 'quartic': return v * v * v * v;
    case 'square_root': return Math.sqrt(v);         // stored = real ** 2, so real = sqrt(stored)
    case 'exponential': return Math.pow(2, v);       // base 2, read off the declared ranges
    case 'indexed': return v;                        // a menu index, passed through as a number
    default: return null;
  }
}

/** Convenience: the real value for a named parameter, or null when we do not have its definition. */
export function vitalReal(name, value) {
  const def = VITAL_PARAMS[name];
  if (!def) return null;
  return vitalToReal(value, def[3]);
}

/** The cutoff family is stored as a MIDI note number (60 = middle C, 8..136 about C-1..E9), not as hertz. */
export const vitalMidiToHz = (note) => 440 * Math.pow(2, (Number(note) - 69) / 12);
