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

/**
 * [min, max, default, scale, status] for the parameters we map. Anything absent is reported rather than guessed.
 *
 * The status is not decoration: vitalToReal() succeeding only means the arithmetic ran. Per the review's standard --
 *
 *   verified     a source or a two-way test supports both the scale and the serialisation
 *   partial      a declared default or range supports it, but not both directions
 *   approximate  a recorded approximation rather than the original semantics
 *   unsupported  the target engine has no equivalent, so no value is written
 */
export const VITAL_PARAMS = {
  // envelopes: quartic times, the classic trap. The only parameters with two-way evidence: the writer's
  // `seconds ** 0.25` and the declared maximum of 2.37842 being exactly 32 seconds.
  env_1_attack: [0, 2.37842, 0.1495, 'quartic', 'verified'], env_2_attack: [0, 2.37842, 0.1495, 'quartic', 'verified'],
  env_3_attack: [0, 2.37842, 0.1495, 'quartic', 'verified'], env_4_attack: [0, 2.37842, 0.1495, 'quartic', 'verified'],
  env_5_attack: [0, 2.37842, 0.1495, 'quartic', 'verified'], env_6_attack: [0, 2.37842, 0.1495, 'quartic', 'verified'],
  env_1_hold: [0, 1.4142135624, 0, 'quartic', 'verified'], env_1_decay: [0, 2.37842, 1, 'quartic', 'verified'],
  env_1_release: [0, 2.37842, 0.5476, 'quartic', 'verified'],
  // oscillators
  osc_1_level: [0, 1, 0.70710678119, 'quadratic', 'partial'], osc_2_level: [0, 1, 0.70710678119, 'quadratic', 'partial'],
  osc_3_level: [0, 1, 0.70710678119, 'quadratic', 'partial'],
  osc_1_unison_detune: [0, 10, 4.472135955, 'quadratic', 'partial'], osc_2_unison_detune: [0, 10, 4.472135955, 'quadratic', 'partial'],
  osc_3_unison_detune: [0, 10, 4.472135955, 'quadratic', 'partial'],
  osc_1_unison_voices: [1, 16, 1, 'indexed', 'partial'], osc_1_wave_frame: [0, 256, 0, 'linear', 'partial'],
  osc_1_phase: [0, 1, 0.5, 'linear', 'partial'], osc_1_transpose: [-48, 48, 0, 'indexed', 'partial'],
  osc_1_tune: [-1, 1, 0, 'linear', 'partial'],
  // filters: the cutoff is SEMITONES RELATIVE TO THE PLAYED NOTE -- the source declares units "semitones" with a
  // post_offset of -60 (so the display is stored - 60, ranging -52..+76), not a MIDI note number as I first assumed.
  // A single hertz value cannot be derived at import time without knowing the note, so it stays unmapped and reported.
  filter_1_cutoff: [8, 136, 60, 'linear', 'unsupported'], filter_2_cutoff: [8, 136, 60, 'linear', 'unsupported'],
  filter_1_resonance: [0, 1, 0.5, 'linear', 'partial'], filter_1_drive: [0, 20, 0, 'linear', 'partial'],
  filter_1_keytrack: [-1, 1, 0, 'linear', 'partial'],
  // lfos
  lfo_1_frequency: [-7, 9, 1, 'exponential', 'partial'], lfo_1_phase: [0, 1, 0, 'linear', 'partial'],
  lfo_1_sync: [0, 4, 1, 'indexed', 'partial'], lfo_1_delay_time: [0, 4, 0, 'linear', 'partial'],
  // effects and master
  volume: [0, 7399.4404, 5473.0404, 'square_root', 'partial'], polyphony: [1, 32, 8, 'indexed', 'partial'],
  chorus_frequency: [-6, 3, -3, 'exponential', 'partial'], reverb_decay_time: [-6, 6, 0, 'exponential', 'partial'],
  delay_frequency: [-2, 9, 2, 'exponential', 'partial'], distortion_drive: [-30, 30, 0, 'linear', 'partial'],
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

/** How far each parameter's conversion is trusted, so a count of mapped parameters is never mistaken for correctness. */
export function vitalParamStatus(name) {
  const def = VITAL_PARAMS[name];
  return def && def.length > 4 ? def[4] : 'unknown';
}

/** The table by status. A mapped count says how much was computed; this says how much is trustworthy. */
export function vitalParamStatusSummary() {
  const out = { verified: 0, partial: 0, approximate: 0, unsupported: 0, unknown: 0 };
  for (const name of Object.keys(VITAL_PARAMS)) {
    const s = vitalParamStatus(name);
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}
