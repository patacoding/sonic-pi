// The data layer: which channel plays which preset, and the only place that writes.
//
// Rules (the whole design):
//   1. One patch of data per channel: { engine, presetName }. A channel is SILENT until a preset is chosen for it.
//   2. edit(part, fn) is the ONLY write path: it writes the part and mirrors the write to every other part holding the
//      SAME preset. Two channels on "Bass" behave like one patch; a channel on "Pad" is untouched.
//   3. MIDI never chooses or changes a preset (the host gates notes on `armed` at the MIDI boundary, not here).
//   4. The preset NAME is bookkeeping: persisted per channel, restored when the channel is created, and the editor's
//      own report is adopted only when it actually changes.
import { SynthEngine } from "./vendor/soundgineer.js";

const say = (t, bad = false) => (bad ? console.error : console.info)(`Synth — ${t}`);
const PARTS_KEY = "sonicpi.synth.preset.v1";
const LIBRARY_KEY = "soundgineer.presets.v1";

const parts = new Map();      // name -> { engine, node, presetName, editorPreset }
const held = new Map();       // name -> Set(notes we started and have not ended)
const cap = Number(globalThis.SP_SYNTH_MAX_PARTS ?? 8);
let ctx = null, inputNode = null, replicating = false;

export const list = () => [...parts.keys()];
export const count = () => parts.size;
export const capOf = () => cap;
export const engineOf = (name) => parts.get(String(name))?.engine ?? null;
export const nameOf = (name) => parts.get(String(name))?.presetName ?? null;
export const outState = () => (inputNode ? "engine bus" : "off");
export const armed = (name) => !!parts.get(String(name))?.presetName;

async function waitForEngine(timeoutMs = 12000) {
  const t0 = performance.now();
  for (;;) {
    const node = globalThis.sonicPi?.engine?.node?.input;
    if (node?.context) return node;
    if (performance.now() - t0 > timeoutMs) throw new Error("the app's engine is not up — press Run once");
    await new Promise((r) => setTimeout(r, 150));
  }
}
export async function attachToEngine(timeoutMs = 12000) {
  inputNode = await waitForEngine(timeoutMs);
  ctx = inputNode.context;
  try { await ctx.resume?.(); } catch { /* the gesture may not allow it yet */ }
  return inputNode;
}

function remembered() { try { return JSON.parse(localStorage.getItem(PARTS_KEY) ?? "{}") || {}; } catch { return {}; } }
function remember(part, name) { try { const all = remembered(); if (name) all[part] = name; else delete all[part]; localStorage.setItem(PARTS_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ } }
export function rememberedChannels() { return Object.entries(remembered()).map(([key, name]) => ({ key, name })); }

/** Bring back every channel we have a record for, so a reload does not need a click to look right. */
export async function restoreRemembered() {
  const done = [];
  for (const { key } of rememberedChannels()) {
    if (parts.has(key) || parts.size >= cap) continue;
    try { await ensurePart(key); done.push(key); } catch { /* over the cap, or no engine yet */ }
  }
  if (done.length) say(`restored ${done.join(", ")} from the last session`);
  return done;
}

/** THE ONLY WRITE PATH. */
export function edit(part, apply) {
  const key = String(part), p = parts.get(key);
  if (!p) return false;
  apply(p.engine);
  const name = p.presetName;
  if (!name || replicating) return true;
  replicating = true;
  try {
    for (const [k, other] of parts) if (k !== key && other.presetName === name) { try { apply(other.engine); } catch { /* mid-teardown */ } }
  } finally { replicating = false; }
  return true;
}

export async function ensurePart(name = "main") {
  const key = String(name);
  const existing = parts.get(key);
  if (existing) return existing;
  if (!ctx || !inputNode) await attachToEngine();
  if (parts.size >= cap) throw new Error(`no room for "${key}": the cap is ${cap}`);
  const engine = new SynthEngine();
  await engine.start({ ctx, connectToDestination: false });
  engine.primeTables?.();
  const node = engine.audioNode;
  if (node) node.connect(inputNode);
  const made = { engine, node, presetName: null, editorPreset: null };
  parts.set(key, made);

  const rawLoad = engine.loadPreset?.bind(engine);
  if (rawLoad) engine.loadPreset = (preset) => {
    const out = rawLoad(preset);
    if (preset?.name) { made.presetName = preset.name; made.editorPreset = `user:${preset.name}`; remember(key, preset.name); }
    return out;
  };
  const rawSet = engine.setParam?.bind(engine);
  if (rawSet) engine.setParam = (i, v, ...rest) => { const out = rawSet(i, v, ...rest); edit(key, (e) => e.setParam?.(i, v)); return out; };
  const rawSetById = engine.setParamById?.bind(engine);
  if (rawSetById) engine.setParamById = (id, v, ...rest) => { const out = rawSetById(id, v, ...rest); edit(key, (e) => e.setParamById?.(id, v)); return out; };

  const want = remembered()[key];
  if (want) {
    try {
      const lib = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? "[]") || [];
      const hit = lib.find((p) => p.name === want);
      if (hit) rawLoad?.(hit); else engine.__sgrPreset = `factory:${want}`;
      made.presetName = want;
      made.editorPreset = hit ? `user:${want}` : `factory:${want}`;
    } catch { made.presetName = want; }
  }
  say(`"${key}" is up (${parts.size}/${cap})${made.presetName ? ` on ${made.presetName}` : " — no preset yet, so it stays silent"}`);
  return made;
}

/** Adopt the editor's report only when it has changed (polling it used to overwrite a deliberately set name). */
export function adoptFromEditor(part) {
  const key = String(part), p = parts.get(key);
  if (!p) return;
  const v = p.engine?.__sgrPreset;
  if (typeof v !== "string" || !v || p.editorPreset === v) return;
  p.editorPreset = v;
  const name = v.startsWith("factory:") ? v.slice("factory:".length) : v.split(":").slice(1).join(":");
  if (name) { p.presetName = name; remember(key, name); }
}
export function rememberPreset(part, presetName) {
  const key = String(part), p = parts.get(key);
  if (!p) return false;
  p.presetName = presetName ?? null;
  remember(key, p.presetName);
  return true;
}
export const rememberPresetChoice = (part, _kind, name) => rememberPreset(part, name);

export async function noteOn(part, note, velocity = 1) {
  const key = String(part);
  const made = await ensurePart(key);          // no gate here: the gate is the MIDI boundary's business
  if (!held.has(key)) held.set(key, new Set());
  held.get(key).add(note);
  made.engine.noteOn(note, velocity);
  return true;
}
export function noteOff(part, note) { held.get(String(part))?.delete(note); parts.get(String(part))?.engine.noteOff(note); }
export function setParam(part, id, value) { return edit(part, (e) => e.setParamById?.(id, value)); }
export function allNotesOff(part) {
  if (part == null) { for (const p of parts.values()) p.engine.allNotesOff?.(); return; }
  parts.get(String(part))?.engine.allNotesOff?.();
}
export function silence(part) {
  const key = String(part), p = parts.get(key);
  if (!p) return false;
  for (const n of held.get(key) ?? []) { try { p.engine.noteOff(n); } catch { /* already gone */ } }
  held.get(key)?.clear();
  try { p.engine.allNotesOff?.(); } catch { /* nothing to release */ }
  return true;
}
export function free(part) {
  const key = String(part), p = parts.get(key);
  if (!p) return false;
  try { p.engine.allNotesOff?.(); p.node?.disconnect?.(); } catch { /* already disconnected */ }
  parts.delete(key); held.delete(key);
  return true;
}
export function detach() { for (const k of [...parts.keys()]) free(k); inputNode = null; ctx = null; }

export const state = () => ({
  context: ctx ? { sampleRate: ctx.sampleRate, state: ctx.state } : null,
  cap, out: outState(), count: parts.size,
  parts: Object.fromEntries([...parts].map(([k, p]) => {
    adoptFromEditor(k);
    return [k, { voices: p.engine.voiceCount ?? 0, peak: Math.max(p.engine.peakL ?? 0, p.engine.peakR ?? 0), preset: p.presetName ?? null, armed: !!p.presetName }];
  })),
});
