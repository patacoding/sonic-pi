// Vital -> Soundgineer preset conversion, entirely local.
//
// The player's own .vital files are read in the browser and converted here; nothing is uploaded and no third-party
// content is redistributed. The mapping is deliberately partial: Vital is a different synthesizer (oscillator warp
// modes, spectral morphing and its own wavetable formats have no counterpart), so what we produce is a preset in the
// same spirit -- envelopes, filters, effects, master and the oscillator basics.
//
// Units differ: Vital stores times in seconds, frequencies in hertz, cutoffs in semitone-ish units and depths as
// percentages, while this engine works in normalized 0..1. The curves below are approximations, chosen so the result is
// in the right region; the player can refine with the knobs afterwards.
import { PARAMS } from "./vendor/soundgineer-params.js";

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const logMap = (x, lo, hi) => clamp01(Math.log(Math.max(x, lo) / lo) / Math.log(hi / lo));

const TIME_KEYS = { delay: [0, 5], attack: [0.001, 20], hold: [0, 20], decay: [0.001, 20], release: [0.001, 40] };
const CC = { 'filter_1_cutoff': 'filter1.cutoff', 'filter_1_resonance': 'filter1.resonance',
             'filter_2_cutoff': 'filter2.cutoff', 'filter_2_resonance': 'filter2.resonance' };
const FX_ENABLE = { chorus: 'chorus.enabled', delay: 'delay.enabled', reverb: 'reverb.enabled', distortion: 'dist.enabled',
                    phaser: 'phaser.enabled', flanger: 'flanger.enabled', compressor: 'comp.enabled' };
const FX_MIX = { chorus: ['chorus.mix', 'chorus_dry_wet'], delay: ['delay.mix', 'delay_dry_wet'],
                 reverb: ['reverb.mix', 'reverb_dry_wet'], distortion: ['dist.mix', 'distortion_mix'],
                 phaser: ['phaser.mix', 'phaser_dry_wet'], flanger: ['flanger.mix', 'flanger_dry_wet'] };

export const knownParamIds = () => new Set(PARAMS.map((p) => p.id));
const has = (ids, id) => ids.has(id);

/** Vital envelope values: seconds (and 0..1 percentages for sustain) -> normalized. */
function envNorm(key, value) {
  if (key === 'sustain') return clamp01(value);
  if (key.endsWith('_curve') || key.endsWith('_power')) return clamp01(value);
  const range = TIME_KEYS[key];
  return range ? logMap(value, range[0], range[1]) : clamp01(value);
}

/**
 * Convert a parsed .vital object into this engine's PresetData shape.
 * Returns { preset, report } where report says what was mapped, what was dropped and why.
 */
export function vitalToPreset(vital, fallbackName = 'Imported Vital') {
  const ids = knownParamIds();
  const s = (vital && typeof vital === 'object' && vital.settings) ? vital.settings : {};
  const params = {};
  const report = { name: String(vital?.preset_name || vital?.name || fallbackName).slice(0, 60), mapped: {}, dropped: {}, total: Object.keys(s).length };
  const put = (id, v) => { if (has(ids, id)) { params[id] = clamp01(v); report.mapped[id] = +params[id].toFixed(4); return true; } report.dropped[id] = 'not a parameter of this engine'; return false; };

  // master
  if ('level' in s) put('master.volume', s.level);
  if ('polyphony' in s) put('master.polyphony', s.polyphony > 1 ? 1 : 0);
  if ('beats_per_minute' in s) put('master.bpm', s.beats_per_minute);

  // six envelopes x nine parameters: the closest thing the two engines share
  for (let e = 1; e <= 6; e++) {
    for (const key of ['delay', 'attack', 'hold', 'decay', 'sustain', 'release',
                       'delay_curve', 'attack_curve', 'decay_curve', 'release_curve']) {
      const v = s[`env_${e}_${key}`];
      if (typeof v !== 'number') continue;
      const target = `env${e}.${key.replace('_curve', '_curve')}`;
      put(target, envNorm(key, v));
    }
  }

  // the two filters
  for (const [src, dst] of Object.entries(CC)) if (typeof s[src] === 'number') put(dst, dst.endsWith('cutoff') ? clamp01(s[src] / 120) : s[src]);

  // effects: whether each is on, and its mix where the names line up
  for (const [vitalName, id] of Object.entries(FX_ENABLE)) {
    const on = s[`${vitalName}_on`] ?? (String(vitalName) in s ? 0 : undefined);
    if (typeof on === 'number') put(id, on);
    const [target, source] = FX_MIX[vitalName] ?? [];
    if (target && typeof s[source] === 'number') put(target, s[source]);
  }

  // oscillator basics that exist in both
  for (let o = 1; o <= 3; o++) {
    if (typeof s[`osc_${o}_level`] === 'number') put(`osc${o}.level`, s[`osc_${o}_level`]);
    if (typeof s[`osc_${o}_pan`] === 'number') put(`osc${o}.pan`, (s[`osc_${o}_pan`] + 1) / 2);
    if (typeof s[`osc_${o}_transpose`] === 'number') put(`osc${o}.octave`, (s[`osc_${o}_transpose`] + 24) / 48);
  }

  const preset = { name: report.name, version: 1, params, mods: [], lfoShapes: [], fxOrder: [] };
  report.mappedCount = Object.keys(params).length;
  return { preset, report };
}

/** A short human summary for the status line. */
export function describeReport(report) {
  const groups = {};
  for (const id of Object.keys(report.mapped)) groups[id.split('.')[0]] = (groups[id.split('.')[0]] ?? 0) + 1;
  const parts = Object.entries(groups).sort().map(([k, n]) => `${k} ${n}`);
  return `${report.name}: ${report.mappedCount} parameters mapped (${parts.join(', ')}), ${report.total} in the file`;
}
