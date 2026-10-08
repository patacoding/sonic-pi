// The data layer.
//
// ONE TRUTH: the patch data below. The engines are RENDERERS of it -- one engine per channel, so each channel keeps its
// own voices and its own MIDI note ownership, while every engine that renders a given patch carries that patch's values.
// Edits change the DATA first and are then rendered to every channel on that patch; nothing is copied engine-to-engine,
// so an engine can always be re-derived from the data and can never drift.
import { SynthEngine } from "./vendor/soundgineer.js";
import { PARAMS } from "./vendor/soundgineer-params.js";   // index -> param id, for the writes their knobs make

const say = (t, bad = false) => (bad ? console.error : console.info)(`Synth — ${t}`);
const PARTS_KEY = "sonicpi.synth.preset.v1";     // our record: channel -> patch name
const LIBRARY_KEY = "soundgineer.presets.v1";    // their library (read-only to us)

const patches = new Map();    // patchName -> { params: Map<paramId, normalizedValue> }   <- the truth
const channels = new Map();   // channelName -> { patchName, engine, node, rawSet, rawSetById, editorPreset }
const held = new Map();       // channelName -> Set(notes we started), so we can always end them
const cap = Number(globalThis.SP_SYNTH_MAX_PARTS ?? 8);
let ctx = null, inputNode = null;

export const list = () => [...channels.keys()];
export const count = () => channels.size;
export const capOf = () => cap;
export const engineOf = (name) => channels.get(String(name))?.engine ?? null;
export const nameOf = (name) => channels.get(String(name))?.patchName ?? null;
export const outState = () => (inputNode ? "engine bus" : "off");
export const armed = (name) => !!channels.get(String(name))?.patchName;
export const patchOf = (name) => { const ch = channels.get(String(name)); return ch ? patches.get(ch.patchName) ?? null : null; };

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
function remember(channel, patchName) { try { const all = remembered(); if (patchName) all[channel] = patchName; else delete all[channel]; localStorage.setItem(PARTS_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ } }
export function rememberedChannels() { return Object.entries(remembered()).map(([key, name]) => ({ key, name })); }

/** The patch data for a name, created from their library (or empty for a factory preset we cannot read). */
function patchData(patchName) {
  const key = String(patchName);
  let patch = patches.get(key);
  if (patch) return patch;
  let params = new Map();
  try {
    const lib = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? "[]") || [];
    const hit = lib.find((p) => p.name === key);
    if (hit?.params) params = new Map(Object.entries(hit.params));
  } catch { /* no library: the patch starts empty and the engine keeps its defaults */ }
  patch = { name: key, params };
  patches.set(key, patch);
  return patch;
}

/** Render the WHOLE patch into one channel's engine (creation, assignment, restore). Engine <- data, never engine <- engine. */
function renderAll(channel) {
  if (!channel?.engine) return;
  const patch = patches.get(channel.patchName);
  if (!patch) return;
  for (const [id, value] of patch.params) { try { channel.rawSetById?.(id, value); } catch { /* unknown id */ } }
}

/** Render ONE parameter to every channel that renders this patch. Called after the data has changed. */
function renderParam(patchName, id, value) {
  for (const ch of channels.values()) {
    if (ch.patchName !== patchName || !ch.engine) continue;
    try { ch.rawSetById?.(id, value); } catch { /* unknown id on that engine */ }
  }
}

/** THE ONLY WRITE PATH: the data changes first, then the renderers are told. */
export function edit(part, applyById) {
  const ch = channels.get(String(part));
  if (!ch || !ch.engine || !ch.patchName) return false;
  const patch = patches.get(ch.patchName);
  if (!patch) return false;
  const changed = applyById(patch);                 // { id, value } returned by the caller
  if (changed) renderParam(ch.patchName, changed.id, changed.value);
  return true;
}

/** Our own parameter write, in normalized units, going through the same path as their knobs. */
export function setParam(part, id, value) {
  return edit(part, (patch) => { patch.params.set(id, value); return { id, value }; });
}

async function createChannel(key) {
  if (channels.size >= cap) throw new Error(`no room for "${key}": the cap is ${cap}`);
  const ch = { patchName: null, engine: null, node: null, rawSet: null, rawSetById: null, editorPreset: null };
  channels.set(key, ch);
  return ch;
}

/** Give a channel its own engine, wired so that their knob writes land in the DATA first (see edit()). */
async function createEngine(ch) {
  const engine = new SynthEngine();
  await engine.start({ ctx, connectToDestination: false });
  engine.primeTables?.();
  const node = engine.audioNode;
  if (node) node.connect(inputNode);
  ch.engine = engine; ch.node = node;
  // THEIR loadPreset writes this.values directly and never calls setParam, so no param listener is notified:
  // the engine holds the preset (the sound and getParam are right) but every knob and graph keeps the values it
  // was drawn with. That is the player's "parameters never update" -- not a channel-switching problem.
  const rawLoad = engine.loadPreset?.bind(engine);
  if (rawLoad) engine.loadPreset = (preset) => {
    const out = rawLoad(preset);
    try {
      for (const [index, group] of engine.paramListeners ?? []) {
        for (const fn of group) { try { fn(engine.values[index]); } catch { /* a widget mid-teardown */ } }
      }
    } catch { /* their listener table may change shape */ }
    return out;
  };

  ch.rawSet = engine.setParam?.bind(engine) ?? null;
  ch.rawSetById = engine.setParamById?.bind(engine) ?? null;
  // their knobs call setParam(index, normalized): record it in the data, then render it to the other channels
  if (ch.rawSet) engine.setParam = (i, v, ...rest) => {
    const out = ch.rawSet(i, v, ...rest);
    const id = PARAMS?.[i]?.id ?? null;                            // their knobs write by index; the data is keyed by id
    if (id && ch.patchName) { const patch = patches.get(ch.patchName); if (patch) { patch.params.set(id, v); renderParam(ch.patchName, id, v); } }
    return out;
  };
  if (ch.rawSetById) engine.setParamById = (id, v, ...rest) => {
    const out = ch.rawSetById(id, v, ...rest);
    if (ch.patchName) { const patch = patches.get(ch.patchName); if (patch) { patch.params.set(id, v); renderParam(ch.patchName, id, v); } }
    return out;
  };
  // their editor reports the preset it loaded via engine.__sgrPreset; adoptFromEditor() picks that up
  return engine;
}

export async function ensurePart(name = "main") {
  const key = String(name);
  let ch = channels.get(key);
  if (!ch) ch = await createChannel(key);
  // An engine exists for EVERY channel, preset or not: the editor is built around an engine, so without one a channel
  // with no preset could never be given one (a dead end the player hit). Silence is enforced where it belongs -- at the
  // MIDI boundary, which ignores a channel that has no preset chosen.
  if (!ch.engine) { await attachToEngineIfNeeded(); await createEngine(ch); renderAll(ch); }
  return ch;
}

async function attachToEngineIfNeeded() { if (!ctx || !inputNode) await attachToEngine(); }

/** Point a channel at a patch: its own engine, rendered from the data. */
export async function setPreset(name, patchName) {
  const key = String(name);
  const ch = channels.get(key) ?? (await createChannel(key));
  await attachToEngineIfNeeded();
  ch.patchName = patchName ?? null;
  ch.editorPreset = ch.patchName ? `user:${ch.patchName}` : null;
  if (!ch.patchName) { ch.engine = null; remember(key, null); return null; }
  patchData(ch.patchName);
  if (!ch.engine) await createEngine(ch);
  renderAll(ch);
  remember(key, ch.patchName);
  say(`"${key}" plays "${ch.patchName}" on its own engine`);
  return ch.engine;
}
export const setPresetName = setPreset;

export function rememberPreset(part, patchName) {
  const key = String(part), ch = channels.get(key);
  if (!ch) return false;
  ch.patchName = patchName ?? null;
  remember(key, ch.patchName);
  return true;
}
export const rememberPresetChoice = (part, _kind, name) => rememberPreset(part, name);

export async function restoreRemembered() {
  const done = [];
  for (const { key, name } of rememberedChannels()) {
    if (channels.get(key)?.engine || channels.size >= cap) continue;
    try { await setPreset(key, name); done.push(key); } catch { /* over the cap, or no engine yet */ }
  }
  if (done.length) say(`restored ${done.join(", ")} from the last session`);
  return done;
}

export function adoptFromEditor(part) {
  const key = String(part), ch = channels.get(key);
  if (!ch?.engine) return;
  const v = ch.engine.__sgrPreset;
  if (typeof v !== "string" || !v || ch.editorPreset === v) return;
  ch.editorPreset = v;
  const name = v.startsWith("factory:") ? v.slice("factory:".length) : v.split(":").slice(1).join(":");
  if (name && ch.patchName !== name) { ch.patchName = name; patchData(name); renderAll(ch); remember(key, name); }
}

export async function noteOn(part, note, velocity = 1) {
  const key = String(part);
  const ch = await ensurePart(key);               // no gate here: the gate is the MIDI boundary's business
  if (!ch.engine) return false;                   // unarmed: nothing to play
  if (!held.has(key)) held.set(key, new Set());
  held.get(key).add(note);
  ch.engine.noteOn(note, velocity);               // this channel's own engine: its voices, its note ownership
  return true;
}
export function noteOff(part, note) {
  const key = String(part);
  held.get(key)?.delete(note);
  channels.get(key)?.engine?.noteOff(note);
}
export function allNotesOff(part) {
  if (part == null) { for (const ch of channels.values()) ch.engine?.allNotesOff?.(); return; }
  channels.get(String(part))?.engine?.allNotesOff?.();
}
export function silence(part) {
  const key = String(part), ch = channels.get(key);
  if (!ch?.engine) return false;
  for (const n of held.get(key) ?? []) { try { ch.engine.noteOff(n); } catch { /* already gone */ } }
  held.get(key)?.clear();
  try { ch.engine.allNotesOff?.(); } catch { /* nothing to release */ }
  return true;
}
export function free(part) {
  const key = String(part), ch = channels.get(key);
  if (!ch) return false;
  try { ch.engine?.allNotesOff?.(); ch.node?.disconnect?.(); } catch { /* already disconnected */ }
  channels.delete(key); held.delete(key);
  return true;
}
export function detach() { for (const k of [...channels.keys()]) free(k); patches.clear(); inputNode = null; ctx = null; }

export const state = () => ({
  context: ctx ? { sampleRate: ctx.sampleRate, state: ctx.state } : null,
  cap, out: outState(), count: channels.size, patches: patches.size,
  parts: Object.fromEntries([...channels].map(([k, ch]) => {
    adoptFromEditor(k);
    const sharedWith = ch.patchName ? [...channels].filter(([, o]) => o.patchName === ch.patchName).map(([n]) => n) : [];
    return [k, {
      voices: ch.engine?.voiceCount ?? 0,
      peak: Math.max(ch.engine?.peakL ?? 0, ch.engine?.peakR ?? 0),
      preset: ch.patchName ?? null,
      armed: !!ch.patchName,
      sharedWith,
    }];
  })),
});
