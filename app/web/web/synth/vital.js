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

import { VITAL_PARAMS, vitalToReal, vitalMidiToHz } from './vital-params.js';

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
function envNorm(key, value, api, paramId) {
  if (key === 'sustain') return clamp01(value);
  if (key.endsWith('_curve') || key.endsWith('_power')) return clamp01(value);
  // Vital stores these as seconds ** (1/4): 2.37842 ** 4 is 32 seconds. Reading the stored number as seconds clamped
  // every time above one second, which is most of them.
  const def = VITAL_PARAMS[`env_1_${key}`];
  if (def && def[3] === 'quartic') {
    const seconds = vitalToReal(value, 'quartic');
    if (api?.paramDef && api?.valueToNorm && paramId) {
      try {
        const norm = api.valueToNorm(api.paramDef(paramId), seconds);
        if (Number.isFinite(norm)) return clamp01(norm);
      } catch { /* fall through to the old mapping */ }
    }
    const range = TIME_KEYS[key];
    return range ? logMap(seconds, range[0], range[1]) : clamp01(seconds);
  }
  const range = TIME_KEYS[key];
  return range ? logMap(value, range[0], range[1]) : clamp01(value);
}

/**
 * Convert a parsed .vital object into this engine's PresetData shape.
 * Returns { preset, report } where report says what was mapped, what was dropped and why.
 */
export function vitalToPreset(vital, fallbackName = 'Imported Vital', api = null) {
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
      put(target, envNorm(key, v, api, `env${e}.${key}`));
    }
  }

  // the two filters
  // (the filter cutoffs are converted from MIDI note numbers in vitalExtraParams; the legacy /120 guess used to
  //  write a wrong value here and fight with it)

  // effects: whether each is on, and its mix where the names line up
  for (const [vitalName, id] of Object.entries(FX_ENABLE)) {
    const on = s[`${vitalName}_on`] ?? (String(vitalName) in s ? 0 : undefined);
    if (typeof on === 'number') put(id, on);
    const [target, source] = FX_MIX[vitalName] ?? [];
    if (target && typeof s[source] === 'number') put(target, s[source]);
  }

  // macros: both engines have four, one parameter each, so they map straight across
  // Vital puts the macro NAMES at the top level (macro1..4, strings) and the VALUES in settings.macro_control_1..4
  for (let m = 1; m <= 4; m++) {
    const value = s[`macro_control_${m}`];
    if (typeof value === 'number') put(`macro${m}.value`, value);
    const name = vital?.[`macro${m}`];
    if (typeof name === 'string' && name && !/^macro\s*\d+$/i.test(name)) report.macros = [...(report.macros ?? []), `${m}=${name}`];
  }

  // The scale-typed parameters: Vital stores level and unison detune as squares, and volume as a square root.
  const scaled = (name, id, toNorm) => {
    const v = s[name];
    if (typeof v !== 'number') return;
    const real = vitalToReal(v, VITAL_PARAMS[name]?.[3] ?? 'linear');
    if (real === null) return;
    put(id, clamp01(toNorm(real)));
  };
  for (let i = 1; i <= 3; i++) {
    scaled(`osc_${i}_level`, `osc${i}.level`, (r) => r);                       // quadratic: stored^2 is the level
    scaled(`osc_${i}_unison_detune`, `osc${i}.detune`, (r) => r / 100);       // 0..10 stored is 0..100 real
  }
  if (typeof s.volume === 'number') {
    const db = vitalToReal(s.volume, 'square_root') - 80;                     // the entry's post_offset
    put('master.volume', clamp01((db + 80) / 86));                            // -80..+6 dB across the range
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


// ── other Vital file types (all read locally, none of it leaves the machine) ─────────────────────────────

/** The wavetable names a preset points at (settings.wavetables is present in every preset we surveyed). */
export function wavetableRefs(vital) {
  const list = vital?.settings?.wavetables;
  if (!Array.isArray(list)) return [];
  return list.map((w, i) => ({ osc: i, name: typeof w === 'string' ? w : String(w?.name ?? `table ${i + 1}`) })).filter((w) => w.name);
}

/** A .vitallfo shape -> the point list this engine's setLfoShape expects (each point is {x, y}). */
export function vitallfoToPoints(lfo) {
  const pts = Array.isArray(lfo?.points) ? lfo.points : [];
  const powers = Array.isArray(lfo?.powers) ? lfo.powers : [];
  const points = [];
  for (let i = 0, k = 0; i + 1 < pts.length; i += 2, k++) {
    const power = Number.isFinite(powers[k]) ? Math.min(1, Math.max(-1, powers[k])) : 0;   // LfoPoint is {x, y, power}
    // Vital (like Serum) puts y = 0 at the top, where the modulation is at its maximum; this engine puts y = 1 at
    // the top, so the value has to be flipped. The two are exact mirrors: flipping a real preset's Sine gives exactly
    // the engine's own default shape.
    points.push({ x: clamp01(pts[i]), y: clamp01(1 - pts[i + 1]), power });
  }
  return points;
}

/** Encode mono float32 samples as a RIFF/WAVE file, 32-bit float, which is the simplest lossless choice here. */
export function encodeWavFloat32(samples, sampleRate = 44100) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const view = new DataView(buf);
  const str = (off, t) => { for (let i = 0; i < t.length; i++) view.setUint8(off + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + n * 4, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 1, true);   // 3 = IEEE float
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 32, true);
  str(36, 'data'); view.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) view.setFloat32(44 + i * 4, samples[i], true);
  return new Uint8Array(buf);
}

/**
 * A .vitaltable -> wav samples in 2048-sample frames.
 * The audio is base64 int16 PCM (verified against three files: int16 reads sanely, float32 does not), at the file's own
 * sample rate, and its length is a whole number of seconds rather than a whole number of frames -- window_size is the
 * original analysis window and is not integral -- so we frame it ourselves.
 */
export function vitalTableToSamples(table, frameSize = 2048) {
  const b64 = table?.groups?.[0]?.components?.[0]?.audio_file;
  if (typeof b64 !== 'string' || !b64) return { samples: null, reason: 'no audio_file in this .vitaltable' };
  const bin = atob(b64);
  const n = Math.floor(bin.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = bin.charCodeAt(i * 2), hi = bin.charCodeAt(i * 2 + 1);
    const v = ((hi << 8) | lo) << 16 >> 16;                      // little-endian int16
    out[i] = v / 32768;
  }
  const frames = Math.floor(n / frameSize);
  const usable = frames * frameSize;
  return { samples: out.subarray(0, usable), frames, frameSize, sampleRate: table?.groups?.[0]?.components?.[0]?.audio_sample_rate ?? 44100 };
}


// ── fault tolerance: what a file is, and why it could not be used ────────────────────────────────────────

/**
 * Decide what a selected file is, without trusting the extension alone (and rejecting the macOS metadata files that
 * litter these folders -- they are about half of every Vital directory we surveyed).
 */
export function classifyFile(name, text) {
  const n = String(name ?? '');
  const base = n.split('/').pop() ?? n;
  if (base.startsWith('._') || base.startsWith('.')) return { kind: 'junk', reason: 'a hidden/metadata file, not a preset' };
  if (/^\.(vital|vitaltable|vitallfo)$/i.test(base.slice(base.lastIndexOf('.')))) {
    /* falls through to content checks below */
  }
  const ext = (base.match(/\.[a-z0-9]+$/i) ?? [''])[0].toLowerCase();
  if (ext === '.wav') return text ? { kind: 'wav' } : { kind: 'wav' };
  if (!text) return { kind: 'error', reason: 'the file is empty' };
  const head = text.slice(0, 200).replace(/^\uFEFF/, '').trimStart();
  if (!head.startsWith('{')) {
    if (/^RIFF/.test(head)) return { kind: 'wav' };
    return { kind: 'error', reason: 'not JSON and not a WAV -- this does not look like a Vital file' };
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { return { kind: 'error', reason: 'JSON could not be parsed (' + String(e.message).slice(0, 60) + ')' }; }
  if (data && data.settings) return { kind: 'vital' };
  if (data && data.groups) return { kind: 'vitaltable' };
  if (data && (data.points || data.num_points)) return { kind: 'vitallfo' };
  if (data && data.settings === undefined) return { kind: 'error', reason: 'JSON, but it has no "settings" -- not a Vital preset' };
  return { kind: 'error', reason: 'unrecognised JSON shape' };
}

/** Judge a converted preset before it is applied, so a bad conversion is reported rather than silently half-applied. */
export function assessPreset(preset, knownIds) {
  const ids = knownIds ?? knownParamIds();
  const keys = Object.keys(preset?.params ?? {});
  const unknown = keys.filter((k) => !ids.has(k));
  const good = keys.filter((k) => ids.has(k));
  if (!keys.length) return { ok: false, mapped: 0, unknown: 0, note: 'it contains no parameters this engine knows -- probably a very different Vital version' };
  return { ok: good.length > 0, mapped: good.length, unknown: unknown.length,
           note: unknown.length ? unknown.length + ' parameter(s) were dropped (not in this engine)' : '' };
}


/**
 * One preset per import, for now.
 *
 * Supporting files (wavetables, LFO shapes) may be selected together with it, because they belong to that one preset --
 * but applying several presets in a row only produces a race the player cannot see, so exactly one is chosen and the
 * rest are named in the summary.
 */
export function pickSinglePreset(files) {
  const list = [...(files ?? [])];
  const presets = list.filter((f) => /\.vital$/i.test(String(f?.name ?? '')) && !String(f.name).split('/').pop().startsWith('.'));
  return { chosen: presets[0] ?? null, ignored: presets.slice(1), count: presets.length };
}


// ── wavetables embedded inside a .vital preset ───────────────────────────────────────────────────────────
//
// settings.wavetables holds THREE entries, one per oscillator, and each is a COMPLETE table: the samples are
// inside the preset, not referenced by path. A table is a chain of components; we can only take the base carrier
// (Wave Source keyframes, or an Audio File Source's audio) because the modifiers around it -- Wave Warp, Wave
// Folder, Frequency Filter, Slew Limiter, Line Source, Wave Window, Phase Shift -- are Vital's own DSP and have no
// counterpart here. That limitation is reported rather than hidden.

const b64ToBytes = (b64) => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

function framesFromWaveSource(component, frameSize = 2048) {
  const keys = Array.isArray(component?.keyframes) ? component.keyframes : [];
  const frames = [];
  for (const k of keys) {
    const b64 = k?.wave_data;
    if (typeof b64 !== 'string' || !b64) continue;
    const bytes = b64ToBytes(b64);
    const view = new DataView(bytes.buffer);
    const f = new Float32Array(Math.floor(bytes.byteLength / 4));
    for (let i = 0; i < f.length; i++) f[i] = view.getFloat32(i * 4, true);
    frames.push(f.length === frameSize ? f : resampleTo(f, frameSize));   // always exactly one frame long
  }
  return frames;
}

/** Resample a slice to exactly `size` samples: Vital's windows are not always 2048 (650 was measured), and this
 *  engine's wavetable frames are. Linear interpolation is enough to keep the shape, and it never drops a frame. */
function resampleTo(samples, size = 2048) {
  const out = new Float32Array(size);
  const n = samples.length;
  if (!n) return out;
  for (let i = 0; i < size; i++) {
    const x = (i * (n - 1)) / Math.max(1, size - 1);
    const i0 = Math.floor(x), i1 = Math.min(n - 1, i0 + 1), t = x - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}

function framesFromAudioSource(component, frameSize = 2048) {
  const b64 = component?.audio_file;
  if (typeof b64 !== 'string' || !b64) return { frames: [], reason: 'no audio_file' };
  const bytes = b64ToBytes(b64);
  const n = Math.floor(bytes.byteLength / 2);
  if (!n) return { frames: [], reason: 'audio_file is empty' };
  const all = new Float32Array(n);
  for (let i = 0; i < n; i++) all[i] = ((((bytes[i * 2 + 1] << 8) | bytes[i * 2]) << 16) >> 16) / 32768;
  const size = Math.max(64, Math.round(component?.window_size || frameSize));
  const frames = [];
  if (size >= n) {
    frames.push(resampleTo(all, frameSize));                 // one window longer than the audio: take it whole
  } else {
    for (let o = 0; o + size <= n; o += size) frames.push(resampleTo(all.subarray(o, o + size), frameSize));
    if (!frames.length) frames.push(resampleTo(all, frameSize));
  }
  return { frames, reason: null, window: size, samples: n };
}

/** The embedded tables of a preset: one entry per oscillator, with the base carrier turned into frames. */
export function vitalEmbeddedTables(vital, frameSize = 2048) {
  const list = vital?.settings?.wavetables;
  if (!Array.isArray(list)) return [];
  return list.map((entry, osc) => {
    const components = entry?.groups?.[0]?.components ?? [];
    const skipped = [];
    for (const c of components) {
      const type = String(c?.type ?? '');
      if (c?.audio_file) {
        const got = framesFromAudioSource(c, frameSize);
        if (got.frames.length) return { osc, kind: 'audio', type, frames: got.frames, frameSize: got.frames[0].length, skipped, window: got.window, samples: got.samples };
        skipped.push(type + ' (audio present but unusable: ' + (got.reason ?? 'unknown') + ')');
        skipped.push(type + ' (no usable audio)');
        continue;
      }
      const wave = framesFromWaveSource(c, frameSize);
      if (wave.length) return { osc, kind: 'wave', type, frames: wave, frameSize: wave[0].length, skipped };
      const drawn = framesFromLineSource(c, frameSize);
      if (drawn.length) return { osc, kind: 'line', type, frames: drawn, frameSize: drawn[0].length, skipped, name: c?.keyframes?.[0]?.line?.name };
      if (typeof c?.audio_file === 'string') skipped.push(type + ' (audio present but unusable)');
      if (type) skipped.push(type);
    }
    return { osc, kind: 'unsupported', type: components.map((c) => c?.type).filter(Boolean).join(' > '), frames: [], skipped };
  });
}

/** Flatten a table's frames into one sample array, which is what a "stacked frames" wav is. */
export function flattenFrames(frames, frameSize = 2048) {
  if (!frames?.length) return new Float32Array(0);
  const size = frames[0].length || frameSize;
  const out = new Float32Array(frames.length * size);
  frames.forEach((f, i) => out.set(f.subarray(0, size), i * size));
  return out;
}


/**
 * Any file a preset names instead of carrying.
 *
 * In the 300 presets we scanned there were none -- every Wave Source and Audio File Source carries its samples -- but
 * Vital can reference an external sample, so this is the safety net: collect any path or file name found anywhere in
 * the preset (nested wavetable objects included) together with the oscillator it belongs to, so a file the player
 * selected can fill it in, and anything left unfilled can be reported by name instead of silently producing silence.
 */
export function externalAudioRefs(vital) {
  const found = [];
  const looksLikeAudio = /[^\\/]+\.(wav|aif|aiff|flac|mp3|vit|vitaltable)$/i;
  const walk = (node, osc, keyPath, depth = 0) => {
    if (depth > MAX_WALK_DEPTH) return;                      // a forged deeply nested preset must not exhaust the stack
    if (Array.isArray(node)) { node.forEach((n) => walk(n, osc, keyPath, depth + 1)); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string' && node.type) {
      const hasData = (typeof node.audio_file === 'string' && node.audio_file.length > 32) ||
                      (node.keyframes ?? []).some((k) => typeof k?.wave_data === 'string' && k.wave_data.length > 32);
      if (!hasData) {
        for (const [k, v] of Object.entries(node)) {
          if (typeof v === 'string' && looksLikeAudio.test(v.trim())) found.push({ osc, key: `${keyPath}.${k}`.replace(/^\./, ''), name: v.trim().split(/[\\/]/).pop() });
        }
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'audio_file' || k === 'wave_data') continue;
      walk(v, osc, `${keyPath}.${k}`, depth + 1);
    }
  };
  (vital?.settings?.wavetables ?? []).forEach((entry, osc) => walk(entry, osc, `osc${osc + 1}`));
  return found;
}

/** Match a named file against the files the player selected, by base name (case-insensitive, extension ignored). */
export function matchLocalFile(name, files) {
  const stem = (x) => String(x).split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  const want = stem(name);
  for (const f of files ?? []) if (stem(f.name) === want) return f;
  return null;
}


/**
 * Parse a .vital file the way Vital itself does: stop at the end of the top-level object.
 *
 * The format reference (hed0rah.github.io/audio_files_anatomy/vital-anatomy.html) notes that trailing bytes after the
 * closing brace still load in Vital, because its reader stops at the object's end -- JSON.parse would throw instead and
 * we would reject a file the synth accepts. Bracket depth is tracked with strings and escapes respected.
 */
export function parseVitalText(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '');
  const start = raw.indexOf('{');
  if (start < 0) return { ok: false, reason: 'no JSON object in this file' };
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return { ok: false, reason: 'the JSON object is not closed (the file looks truncated)' };
  const trailing = raw.slice(end).trim();
  try { return { ok: true, data: JSON.parse(raw.slice(start, end)), trailing: trailing.length ? trailing.slice(0, 40) : null }; }
  catch (e) { return { ok: false, reason: 'JSON could not be parsed (' + String(e.message).slice(0, 60) + ')' }; }
}

/** Bound recursion for anything walking a preset: a forged deep object must not exhaust the stack. */
export const MAX_WALK_DEPTH = 32;


/**
 * A Line Source IS a waveform: Vital's editor draws it, and the shape lives in keyframe.line as flat x/y points with
 * per-point powers -- the same shape a .vitallfo uses. Treating it as "a DSP chain with no base waveform" was simply
 * wrong, and it is not a rare case: every oscillator whose table is a Line Source has no other carrier.
 */
function rasterizeLine(line, frameSize = 2048) {
  const pts = Array.isArray(line?.points) ? line.points : [];
  const powers = Array.isArray(line?.powers) ? line.powers : [];
  const n = Math.floor(pts.length / 2);
  const out = new Float32Array(frameSize);
  if (n < 1) return out;
  if (n === 1) { out.fill(pts[1] ?? 0); return out; }
  const xs = [], ys = [];
  for (let i = 0; i < n; i++) { xs.push(pts[i * 2]); ys.push(pts[i * 2 + 1]); }
  // order by x so a shape drawn right-to-left still comes out as a waveform
  const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const X = order.map((i) => xs[i]), Y = order.map((i) => ys[i]), P = order.map((i) => powers[i] ?? 1);
  for (let s = 0; s < frameSize; s++) {
    const x = s / (frameSize - 1);
    let seg = 0;
    while (seg < X.length - 2 && X[seg + 1] < x) seg++;
    const x0 = X[seg], x1 = X[seg + 1], y0 = Y[seg], y1 = Y[seg + 1];
    const p = P[seg] || 1;
    const t = x1 === x0 ? 0 : Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
    const shaped = p === 1 ? t : Math.pow(t, p);
    out[s] = y0 + (y1 - y0) * shaped;
  }
  return out;
}

function framesFromLineSource(component, frameSize = 2048) {
  const keys = Array.isArray(component?.keyframes) ? component.keyframes : [];
  const frames = [];
  for (const k of keys) {
    const line = k?.line;
    if (!line || !Array.isArray(line.points) || line.points.length < 4) continue;
    frames.push(rasterizeLine(line, frameSize));
  }
  return frames;
}


// ── the two structured regions, verified against Vital's own source ───────────────────────────────────────────────
//
// LoadSave::loadModulations(synth, json modulations) and loadLfos(synth, json lfos) both take a JSON value, and the
// format reference describes them as arrays of 64 slots and 8 shapes. The flat settings keys live alongside them:
// modulation_N_amount/_bipolar/_power/_stereo/_bypass carry a slot's depth while the array carries its wiring, and
// updateFromOldVersion() is why an older file can look flat. Both forms are read here.

/** The modulation matrix: [{ slot, source, destination }], with the depth read from the flat keys beside it. */
export function vitalModulations(vital) {
  const s = vital?.settings ?? {};
  const out = [];
  const arr = s.modulations;
  if (Array.isArray(arr)) {
    arr.forEach((slot, i) => {
      const source = String(slot?.source ?? "");
      const destination = String(slot?.destination ?? "");
      if (!source && !destination) return;                       // an empty slot is not wiring
      const amount = typeof s[`modulation_${i + 1}_amount`] === 'number' ? s[`modulation_${i + 1}_amount`] : null;
      out.push({ slot: i + 1, source, destination, amount,
                 bipolar: s[`modulation_${i + 1}_bipolar`] ?? null, bypass: s[`modulation_${i + 1}_bypass`] ?? null,
                 power: s[`modulation_${i + 1}_power`] ?? null });
    });
  }
  if (!out.length) {                                             // the flat form: keys without an array
    // source and destination are two separate keys, so slots have to be merged rather than pushed one per key
    const bySlot = new Map();
    for (const k of Object.keys(s)) {
      const m = /^modulation_(\d+)_(source|destination)$/.exec(k);
      if (!m) continue;
      const slot = Number(m[1]);
      const cur = bySlot.get(slot) ?? { slot, source: "", destination: "", amount: s[`modulation_${slot}_amount`] ?? null };
      if (m[2] === 'source') cur.source = String(s[k]); else cur.destination = String(s[k]);
      bySlot.set(slot, cur);
    }
    out.push(...[...bySlot.values()].sort((a, b) => a.slot - b.slot));
  }
  return out;
}

/** The eight LFO shapes: [{ index, name, points, powers, smooth }] where points are flat x/y pairs. */
export function vitalLfoShapes(vital) {
  const s = vital?.settings ?? {};
  const out = [];
  const arr = s.lfos;
  const readOne = (src, i, name) => {
    const points = Array.isArray(src?.points) ? src.points : null;
    return { index: i + 1, name: name ?? (typeof src?.name === 'string' ? src.name : null),
             points, powers: Array.isArray(src?.powers) ? src.powers : [], smooth: !!src?.smooth,
             numPoints: points ? Math.floor(points.length / 2) : 0 };
  };
  if (Array.isArray(arr)) arr.forEach((shape, i) => out.push(readOne(shape, i, null)));
  else {
    for (let i = 1; i <= 8; i++) {
      const pts = s[`lfo_${i}_points`];
      if (Array.isArray(pts)) out.push(readOne({ points: pts, powers: s[`lfo_${i}_powers`], smooth: s[`lfo_${i}_smooth`] }, i - 1, null));
    }
  }
  return out.filter((x) => x.numPoints > 0);
}


// ── taking the wiring and the shapes across ──────────────────────────────────────────────────────────────────────
//
// Two honest facts, both measured over eight hundred presets. Our engine's modulation sources are only velocity,
// keytrack, random, modwheel, pitchwheel and aftertouch, while Vital wires mostly from its own lfo_N, env_N and
// macro_control_N -- so only a minority of connections can be reproduced at all, and the rest are reported rather than
// dropped silently. LFO shapes need no such compromise: the engine wants LfoPoint[] and that is what the converter
// already produces.

const SOURCE_ALIASES = {
  mod_wheel: 'modwheel', pitch_wheel: 'pitchwheel', velocity: 'velocity', aftertouch: 'aftertouch',
  keytrack: 'keytrack', random: 'random',
};

/**
 * Vital's modulation sources against this engine's.
 *
 * The engine's MOD_SOURCES is not the six I first read out of the built bundle -- grepping the minified file for
 * `id: "..."` only found the literal entries, while six envelopes, eight LFOs and four macros are generated. The source
 * of truth is src/shared/messages.ts, and the protocol document lists all twenty-four: env1..6, lfo1..8, velocity,
 * keytrack, random, macro1..4, modwheel, pitchwheel, aftertouch. That is almost exactly Vital's vocabulary, which makes
 * this mapping the difference between a couple of percent and nearly all of it.
 *
 * Vital's indexed `random_N`, `note`, `stereo`, `lift` and `note_in_octave` have no counterpart and are reported.
 */
export function engineModSourceFromVital(name, modSources) {
  const n = String(name ?? '');
  const indexed = /^(env|lfo|macro_control|random)_(\d+)$/.exec(n);
  if (indexed) {
    // Vital has four independent randoms; this engine has one. Routing them all to it is closer to the preset than
    // dropping them, and the caller reports it as an approximation rather than passing it off as exact.
    const base = indexed[1] === 'macro_control' ? 'macro' : (indexed[1] === 'random' ? 'random' : indexed[1]);
    const id = indexed[1] === 'random' ? 'random' : `${base}${indexed[2]}`;
    return !modSources || modSources.includes(id) ? id : null;
  }
  const id = SOURCE_ALIASES[n] ?? null;
  if (!id) return null;
  return !modSources || modSources.includes(id) ? id : null;
}

/** Vital parameter names to this engine's ids: grouped names flatten (osc_1_level -> osc1.level) with the exceptions
 *  that the two synths spell differently. Returns null when there is no counterpart at all. */
export function engineParamIdFromVital(name) {
  const n = String(name ?? '');
  if (!n) return null;
  const aliases = {
    osc_wave_frame: 'morph', osc_tune: 'fine',
    reverb_dry_wet: 'mix', delay_dry_wet: 'mix', chorus_dry_wet: 'mix', phaser_dry_wet: 'mix',
    flanger_dry_wet: 'mix', distortion_dry_wet: 'mix', compressor_dry_wet: 'mix',
    lfo_frequency: 'rate',
    distortion_drive: 'drive', distortion_mix: 'mix', distortion_filter_cutoff: 'tone', distortion_on: 'enabled',
    compressor_on: 'enabled', compressor_threshold: 'threshold', compressor_ratio: 'ratio',
    compressor_attack: 'attack', compressor_release: 'release', compressor_makeup: 'makeup',
    reverb_on: 'enabled', delay_on: 'enabled', chorus_on: 'enabled', phaser_on: 'enabled',
    flanger_on: 'enabled', distortion_filter_on: 'enabled',
  };
  // groups spelled the same on both sides, plus the effects that differ
  const m = /^(osc|filter|lfo|env|noise|sub|chorus|delay|reverb|comp|eq|phaser|flanger|macro|random|filter_fx|distortion|compressor|master)_(\d*)_?(.*)$/.exec(n);
  if (!m) {
    if (n === 'distortion_on') return 'fxdist.enabled';
    return null;
  }
  let [, group, index, rest] = m;
  if (group === 'distortion') return 'fxdist.' + (aliases[`distortion_${rest}`] ?? rest);
  if (group === 'compressor') return 'comp.' + (aliases[`compressor_${rest}`] ?? rest);
  if (group === 'filter_fx') {                                             // the engine's own filter section
    const map = { cutoff: 'filter.cutoff', resonance: 'filter.resonance', on: 'filter.enabled', mix: 'filter.mix' };
    return map[rest] ?? null;
  }
  if (group === 'random') return null;                                     // a different random source
  if (group === 'sample') return null;                                     // the engine has no sample oscillator
  if (group === 'master') return 'master.' + ({ volume: 'volume', bpm: 'bpm', polyphony: 'polyphony' }[rest] ?? rest);
  const r = aliases[`${group}_${rest}`] ?? rest;
  return `${group}${index}.${r}`;
}

/** The connections this engine can actually hold: source in MOD_SOURCES, destination an id it has. */
export function vitalModRoutes(vital, paramIds, modSources = ['velocity', 'keytrack', 'random', 'modwheel', 'pitchwheel', 'aftertouch']) {
  const routes = [], skipped = [];
  for (const c of vitalModulations(vital)) {
    if (!c.source && !c.destination) continue;
    const source = engineModSourceFromVital(c.source, modSources);
    if (!source) { skipped.push(`${c.source} → ${c.destination}: this engine has no ${c.source} as a modulation source`); continue; }
    const dest = engineParamIdFromVital(c.destination);
    if (!dest || (paramIds && !paramIds.has(dest))) { skipped.push(`${c.source} → ${c.destination}: no counterpart for ${c.destination}`); continue; }
    routes.push({ source, dest, depth: typeof c.amount === 'number' ? c.amount : 1, from: c.source, to: c.destination });
  }
  return { routes, skipped };
}

/** The eight LFO shapes, ready for setLfoShape(lfo, points) -- the engine's own LfoPoint shape. */
export function vitalLfoShapeApplications(vital) {
  return vitalLfoShapes(vital).filter((x) => x.points && x.numPoints > 0).map((x) => ({ lfo: x.index - 1, points: vitallfoToPoints(x) }));
}


// ── the parameters beyond the first pass: the LFOs and the insides of the effects ──────────────────────────────────
//
// This engine's parameters are normalised, and it exposes the conversion itself -- valueToNorm(def, value) with the
// definition from paramDef(id) -- so a frequency in Hz or a time in seconds can be handed over faithfully instead of
// being written raw into a 0..1 slot. Anything without a counterpart is reported by name.

const LFO_KEYS = {
  frequency: 'rate', phase: 'phase', sync: 'sync', sync_type: 'division', smooth_mode: 'smooth',
};
const LFO_NO_COUNTERPART = ['delay_time', 'fade_time', 'stereo', 'tempo', 'keytrack_transpose', 'keytrack_tune', 'smooth_time'];
const FX_GROUPS = {
  chorus: 'chorus', delay: 'delay', reverb: 'reverb', phaser: 'phaser', flanger: 'flanger', eq: 'eq',
};
const FX_KEYS = {
  rate: 'rate', depth: 'depth', dry_wet: 'mix', mix: 'mix', feedback: 'feedback', size: 'size', damp: 'damp',
  width: 'width', delay: 'time', sync: 'sync', division: 'division', ping_pong: 'pingpong', pingpong: 'pingpong',
  low_gain: 'low_gain', mid_gain: 'mid_gain', mid_freq: 'mid_freq', high_gain: 'high_gain',
};

/** The LFO and effect parameters, converted into this engine's normalised values. */
export function vitalExtraParams(vital, api) {
  const s = vital?.settings ?? {};
  const params = {}, mapped = {}, dropped = {};
  // A definition lookup must never throw: an id this engine does not have is answered, not raised.
  const def = (id) => { try { return api?.paramDef ? api.paramDef(id) : null; } catch { return null; } };
  const known = (id) => { try { return api?.knownParamIds ? api.knownParamIds().has(id) : true; } catch { return false; } };
  const put = (id, value) => {
    // A key from my own table that this engine does not have is simply not attempted; only a Vital parameter that
    // genuinely exists and has nowhere to go is worth reporting, or the log fills with noise.
    if (!known(id)) return false;
    const d = def(id);
    let norm;
    if (api?.valueToNorm && d) { try { norm = api.valueToNorm(d, value); } catch { norm = null; } if (!Number.isFinite(norm)) norm = null; }
    if (norm === null || norm === undefined) norm = Math.max(0, Math.min(1, value));
    params[id] = norm; mapped[id] = +Number(norm).toFixed(4);
    return true;
  };

  for (let i = 1; i <= 8; i++) {
    for (const [vitalKey, mine] of Object.entries(LFO_KEYS)) {
      const v = s[`lfo_${i}_${vitalKey}`];
      if (typeof v === 'number') put(`lfo${i}.${mine}`, v);
    }
    for (const k of LFO_NO_COUNTERPART) {
      const v = s[`lfo_${i}_${k}`];
      if (typeof v === 'number' && v !== 0) dropped[`lfo${i}.${k}`] = 'this engine has no counterpart';
    }
  }
  for (const [vitalGroup, mine] of Object.entries(FX_GROUPS)) {
    for (const [vitalKey, myKey] of Object.entries(FX_KEYS)) {
      const v = s[`${vitalGroup}_${vitalKey}`];
      if (typeof v === 'number') put(`${mine}.${myKey}`, v);
    }
  }
  if (typeof s.compressor_threshold === 'number') put('comp.threshold', s.compressor_threshold);
  if (typeof s.compressor_ratio === 'number') put('comp.ratio', s.compressor_ratio);
  if (typeof s.compressor_attack === 'number') put('comp.attack', s.compressor_attack);
  if (typeof s.compressor_release === 'number') put('comp.release', s.compressor_release);
  if (typeof s.compressor_makeup === 'number') put('comp.makeup', s.compressor_makeup);
  // The oscillators and the filters. Only pairs whose meaning matches are taken: Vital's frame_spread, spectral morph,
  // per-oscillator distortion, detune_range/power and filter style have no counterpart here, and a name that looks
  // similar is not enough to write into a slot.
  const OSC_KEYS = {
    pan: 'pan', phase: 'phase', random_phase: 'phase_rand', transpose: 'transpose',
    unison_voices: 'unison', unison_blend: 'blend', stereo_spread: 'spread', on: 'enabled',
  };
  const OSC_SKIP = ['distortion_amount', 'distortion_type', 'distortion_phase', 'distortion_spread', 'spectral_morph_amount',
                    'spectral_morph_type', 'spectral_morph_spread', 'spectral_unison', 'frame_spread', 'detune_power',
                    'detune_range', 'midi_track', 'smooth_interpolation', 'stack_style', 'transpose_quantize', 'view_2d', 'destination'];
  for (let i = 1; i <= 3; i++) {
    for (const [vitalKey, mine] of Object.entries(OSC_KEYS)) {
      const v = s[`osc_${i}_${vitalKey}`];
      if (typeof v === 'number') put(`osc${i}.${mine}`, v);
    }
    // tune is in semitones and this engine's fine control is in cents, so convert rather than pretend they match
    if (typeof s[`osc_${i}_tune`] === 'number') { const fineDef = def(`osc${i}.fine`); if (fineDef) put(`osc${i}.fine`, s[`osc_${i}_tune`] * 100); }

    // Vital's wave_frame is a frame index (0..255) and this engine's morph is 0..1; older files may already be
    // normalised, so only a value above 1 is treated as an index.
    if (typeof s[`osc_${i}_wave_frame`] === 'number') put(`osc${i}.morph`, s[`osc_${i}_wave_frame`] > 1 ? s[`osc_${i}_wave_frame`] / 255 : s[`osc_${i}_wave_frame`]);
    for (const k of OSC_SKIP) {
      const v = s[`osc_${i}_${k}`];
      if (typeof v === 'number' && v !== 0) dropped[`osc${i}.${k}`] = 'this engine has no counterpart';
    }
  }
  const FILTER_KEYS = { cutoff: 'cutoff', resonance: 'resonance', drive: 'drive', keytrack: 'keytrack', mix: 'mix', on: 'enabled' };
  // The cutoff family is a MIDI note number (60 = middle C), not hertz, so it goes to hertz before the engine's converter.
  const FILTER_MIDI = { cutoff: 'cutoff' };
  for (let i = 1; i <= 2; i++) {
    for (const [vitalKey, mine] of Object.entries(FILTER_KEYS)) {
      const v = s[`filter_${i}_${vitalKey}`];
      if (typeof v !== 'number') continue;
      put(`filter${i}.${mine}`, vitalKey in FILTER_MIDI ? vitalMidiToHz(v) : v);
    }
    for (const k of ['blend', 'blend_transpose', 'formant_x', 'formant_y', 'formant_resonance', 'formant_transpose', 'filter_input', 'style', 'model']) {
      const v = s[`filter_${i}_${k}`];
      if (typeof v === 'number' && v !== 0) dropped[`filter${i}.${k}`] = 'this engine has no counterpart';
    }
  }
  // Effect rates and times are exponential in base 2: chorus_frequency -6..3 is 0.0156..8 Hz, delay_frequency -2..9 is
  // 0.25..512 seconds, reverb_decay_time -6..6 is 0.0156..64 seconds.
  for (const [name, id] of [['chorus_frequency', 'chorus.rate'], ['delay_frequency', 'delay.time']]) {
    const v = s[name];
    if (typeof v !== 'number') continue;
    put(id, vitalToReal(v, 'exponential'));
  }
  if (typeof s.reverb_decay_time === 'number') dropped['reverb_decay_time'] = 'this engine has size and damping, not a decay time';

  if (typeof s.distortion_drive === 'number') put('fxdist.drive', s.distortion_drive);
  if (typeof s.distortion_mix === 'number') put('fxdist.mix', s.distortion_mix);
  if (typeof s.distortion_filter_cutoff === 'number') put('fxdist.tone', s.distortion_filter_cutoff);
  return { params, mapped, dropped };
}
