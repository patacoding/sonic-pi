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
//   square_root  real = stored^2 as well: the knob is the square root of the value
//   exponential  real = exp(stored)     -- the base is not yet confirmed; see the protocol document section 10
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
  // filters: 8..136 is not Hz
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
    case 'square_root': return v * v;
    case 'exponential': return Math.exp(v);          // base unconfirmed; callers must be able to say so
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
