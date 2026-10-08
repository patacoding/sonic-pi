// The instruments: one per MIDI channel, all on the app's engine context.
//
// Simplified on purpose. There is only ONE audio context -- the app engine's -- so there is nothing to move between
// contexts, no adoption step to race and nothing to poll. The synth is enabled explicitly (host.js), and enabling is
// what makes the engine exist in the first place.
import { SynthEngine } from "./vendor/soundgineer.js";

export const DEFAULT_PART = "main";
const say = (t, bad = false) => (bad ? console.error : console.info)(`Synth — ${t}`);

const parts = new Map();          // name -> { engine, node, program, patchName }
const held = new Map();           // name -> Set(notes we started and have not ended)
const PRESET_KEY = "sonicpi.synth.preset.v1";   // our own record: which preset each channel is playing

/** Which preset a channel was left on, so a reload (or a rebuilt engine) does not silently fall back to Init. */
function rememberedPreset(key) {
  try { return (JSON.parse(localStorage.getItem(PRESET_KEY) ?? "{}"))[key] ?? null; } catch { return null; }
}
function rememberPresetChoice(key, kind, name) {
  try {
    const all = JSON.parse(localStorage.getItem(PRESET_KEY) ?? "{}");
    all[key] = { kind, name };
    localStorage.setItem(PRESET_KEY, JSON.stringify(all));
  } catch { /* storage may be unavailable; the session still works */ }
}
/** Their list is the library; find the entry this channel was last on and hand it to the engine. */
function restorePreset(key, engine) {
  const want = rememberedPreset(key);
  if (!want?.name) return null;
  try {
    const all = JSON.parse(localStorage.getItem("soundgineer.presets.v1") ?? "[]");
    const hit = want.kind === "user"
      ? all.find((p) => p.name === want.name && (p.scope ?? "default") === key)
      : null;
    if (hit) { engine.loadPreset(hit); return want.name; }
  } catch { /* nothing to restore */ }
  return want.name;                     // a factory preset is named the same in every build
}
let cap = Number(globalThis.SP_SYNTH_MAX_PARTS ?? 8);
let ctx = null;
let inputNode = null;

export const list = () => [...parts.keys()];
export const has = (name) => parts.has(String(name));
export const engineOf = (name) => parts.get(String(name))?.engine ?? null;
export const outState = () => (inputNode ? "engine bus" : "off");
export const capOf = () => cap;

/** The app's engine boots on its first Run; wait for it instead of inventing a second context. */
async function waitForEngine(timeoutMs) {
  const t0 = performance.now();
  for (;;) {
    const node = globalThis.sonicPi?.engine?.node?.input;
    if (node?.context) return node;
    if (performance.now() - t0 > timeoutMs) throw new Error("the app's engine is not up — press Run once");
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Point this module at the engine. Called by enable(); without it every part-creation would wait, and fail loudly. */
export async function attachToEngine(timeoutMs = 12000) {
  inputNode = await waitForEngine(timeoutMs);
  ctx = inputNode.context;
  try { await ctx.resume?.(); } catch {}
  return inputNode;
}

export function detach() {
  for (const n of [...parts.keys()]) free(n);
  inputNode = null; ctx = null;
}

export async function ensurePart(name = DEFAULT_PART) {
  const key = String(name);
  const existing = parts.get(key);
  if (existing) return existing;
  if (parts.size >= cap) throw new Error(`no room for "${key}": the cap is ${cap}`);
  if (!ctx || !inputNode) await attachToEngine();
  const engine = new SynthEngine();
  // SP-EXT: tell the editor which channel this engine belongs to, so its saved presets stay its own (the upstream
  // preset browser assumes one engine per page).
  engine.__sgrScope = key;
  await engine.start({ ctx, connectToDestination: false });     // we route it, it must not hit the speakers
  const node = engine.audioNode;
  if (!node) throw new Error(`"${key}" got no node`);
  node.connect(inputNode);                                      // the engine's bus: with_fx, scope, Recorder
  engine.primeTables();
  const made = { engine, node, program: null, patchName: "Init" };
  parts.set(key, made);
  try { const nm = restorePreset(key, engine); if (nm) made.presetName = nm; } catch { /* first run: nothing to restore */ }
  // Their preset browser applies presets through engine.loadPreset(). A note sounding when it does can outlive the
  // change and keep playing with no way for the player to stop it, so the part is silenced first -- with silence(),
  // not allNotesOff() alone, which is measured not to clear a voice in this build. This wraps OUR engine object.
  const loadPreset = engine.loadPreset?.bind(engine);
  if (loadPreset) engine.loadPreset = (preset) => {
    try { silence(key); } catch {}
    const out = loadPreset(preset);
    // the player picks presets in the editor itself, which our channel table would otherwise never hear about
    try {
      const cur = parts.get(key);
      if (cur) { cur.presetName = preset?.name ?? null; cur.presetScope = preset?.scope ?? null; }
      rememberPresetChoice(key, preset?.scope ? "user" : "factory", preset?.name ?? null);
    } catch {}
    return out;
  };
  say(`"${key}" is up (${parts.size}/${cap})`);
  return made;
}

export function rememberPreset(name, presetName, scope = null) {
  const p = parts.get(String(name));
  if (p) { p.presetName = presetName; p.presetScope = scope; }
  return !!p;
}

export function rememberPatch(name, program, patchName) {
  const p = parts.get(String(name));
  if (p) { p.program = program; p.patchName = patchName; }
  return !!p;
}

export async function noteOn(name, note, velocity = 1) {
  const key = String(name);
  const p = await ensurePart(key);
  if (!held.has(key)) held.set(key, new Set());
  held.get(key).add(note);                       // we remember what we started, so we can always end it
  p.engine.noteOn(note, velocity);
}
export function noteOff(name, note) {
  const key = String(name);
  held.get(key)?.delete(note);
  parts.get(key)?.engine.noteOff(note);
}
export function setParam(name, id, value) {
  const p = parts.get(String(name));
  if (p) { p.engine.setParamById(id, value); return true; }
  ensurePart(name).then((made) => made.engine.setParamById(id, value)).catch(() => {});   // a CC may arrive first
  return true;
}
export function allNotesOff(name) {
  if (name == null) { for (const p of parts.values()) p.engine.allNotesOff?.(); }
  else parts.get(String(name))?.engine.allNotesOff?.();
}

/**
 * Silence a part whatever the cause. allNotesOff() releases voices, but a stuck voice, an orphaned one after a preset
 * change, or a self-oscillating effect can keep making sound regardless -- so this also drops the master gain to zero
 * for an instant and puts it back. The output path is the one thing guaranteed to be upstream of every cause.
 */
export function silence(name, ms = 160) {
  const key = String(name);
  const p = parts.get(key);
  if (!p) return false;
  // End every note WE know is sounding, one by one. This is the part that actually stops the note: allNotesOff() is
  // measured not to clear a voice in this build, and lowering the gain alone only hides it -- the sound returns when
  // the gain is restored, which is exactly the "it never stops" the player reported.
  for (const n of held.get(key) ?? []) { try { p.engine.noteOff(n); } catch {} }
  held.get(key)?.clear();
  try { p.engine.allNotesOff?.(); } catch {}
  try {
    const restore = () => { const v = p.program != null ? patchVolume(p.program) : 0.7; p.engine.setParamById("master.volume", v); };
    p.engine.setParamById("master.volume", 0);
    setTimeout(restore, ms);
  } catch {}
  return true;
}
function patchVolume(program) { return 0.7; }        // Init's own level: the patches all ship 0.7 for master.volume
export function free(name) {
  const p = parts.get(String(name));
  if (!p) return false;
  try { p.engine.allNotesOff?.(); p.node.disconnect(); } catch {}
  held.delete(String(name));
  parts.delete(String(name));
  return true;
}

/** Pull the editor's own notion of the current preset, so a save it performs is reflected without it telling us. */
function syncFromEditor(key, p) {
  try {
    const v = p?.engine?.__sgrPreset;
    if (typeof v !== "string" || !v) return;
    const [kind, ...rest] = v.split(":");
    const name = kind === "factory" ? rest.join(":") : rest.slice(1).join(":");
    if (!name || p.presetName === name) return;
    p.presetName = name;
    p.presetScope = kind === "factory" ? null : rest[0];
    rememberPresetChoice(key, kind, name);
  } catch { /* the engine may be mid-teardown */ }
}

export const state = () => ({
  context: ctx ? { sampleRate: ctx.sampleRate, state: ctx.state } : null,
  cap,
  out: outState(),
  parts: Object.fromEntries([...parts].map(([n, p]) => [n, {
    voices: (syncFromEditor(n, p), p.engine.voiceCount ?? 0),
    peak: Math.max(p.engine.peakL ?? 0, p.engine.peakR ?? 0),
    params: p.engine.values?.length ?? null,
    program: p.program ?? null,
    patch: p.patchName ?? "Init",
    preset: p.presetName ?? null,
    // a part making sound with no voices at all is a stuck/orphaned voice: worth seeing, not guessing about
    stuck: (p.engine.voiceCount ?? 0) === 0 && Math.max(p.engine.peakL ?? 0, p.engine.peakR ?? 0) > 0.01,
  }])),
  count: parts.size,
});
