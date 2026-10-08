// The instruments: one per MIDI channel, all on the app's engine context.
//
// Simplified on purpose. There is only ONE audio context -- the app engine's -- so there is nothing to move between
// contexts, no adoption step to race and nothing to poll. The synth is enabled explicitly (host.js), and enabling is
// what makes the engine exist in the first place.
import { SynthEngine } from "./vendor/soundgineer.js";

export const DEFAULT_PART = "main";
const say = (t, bad = false) => (bad ? console.error : console.info)(`Synth — ${t}`);

const parts = new Map();          // name -> { engine, node, program, patchName }
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
  await engine.start({ ctx, connectToDestination: false });     // we route it, it must not hit the speakers
  const node = engine.audioNode;
  if (!node) throw new Error(`"${key}" got no node`);
  node.connect(inputNode);                                      // the engine's bus: with_fx, scope, Recorder
  engine.primeTables();
  const made = { engine, node, program: null, patchName: "Init" };
  parts.set(key, made);
  say(`"${key}" is up (${parts.size}/${cap})`);
  return made;
}

export function rememberPatch(name, program, patchName) {
  const p = parts.get(String(name));
  if (p) { p.program = program; p.patchName = patchName; }
  return !!p;
}

export async function noteOn(name, note, velocity = 1) { (await ensurePart(name)).engine.noteOn(note, velocity); }
export function noteOff(name, note) { parts.get(String(name))?.engine.noteOff(note); }
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
export function free(name) {
  const p = parts.get(String(name));
  if (!p) return false;
  try { p.engine.allNotesOff?.(); p.node.disconnect(); } catch {}
  parts.delete(String(name));
  return true;
}

export const state = () => ({
  context: ctx ? { sampleRate: ctx.sampleRate, state: ctx.state } : null,
  cap,
  out: outState(),
  parts: Object.fromEntries([...parts].map(([n, p]) => [n, {
    voices: p.engine.voiceCount ?? 0,
    peak: Math.max(p.engine.peakL ?? 0, p.engine.peakR ?? 0),
    params: p.engine.values?.length ?? null,
    program: p.program ?? null,
    patch: p.patchName ?? "Init",
  }])),
  count: parts.size,
});
