// Several timbres at once: one Soundgineer instance per part.
//
// Why instances rather than a multi-part worklet: upstream's protocol has no part, channel or program field, one
// registered processor is one patch, and our two SP-EXT seams already let each instance share the app's
// AudioContext and leave routing to us -- so this needs no new upstream patch and the layer stays mergeable
// (docs/plan/soundgineer-multipart-argument.md).
//
// Each part owns its whole chain: three oscillators, filter, envelopes, LFOs, a 32-slot modulation matrix and the
// eight effects. The music names the part explicitly, every time -- `puts :synth, :bass, :note, 60` -- because
// there is no "current part" state to get out of step between live loops.
import { SynthEngine } from "./vendor/soundgineer.js";

export const DEFAULT_PART = "main";

const say = (t, bad = false) => (bad ? console.error : console.info)(`Synth — ${t}`);

const parts = new Map();      // name -> { engine, node, started }
let ctx = null;
let inputNode = null;
let cap = Number(globalThis.SP_SYNTH_MAX_PARTS ?? 8);   // provisional: M1.5 measures the real cost

/** The engine boots lazily on the first Run; wait for it rather than guessing. */
async function waitForEngine(timeoutMs = 20000) {
  const t0 = performance.now();
  for (;;) {
    const node = globalThis.sonicPi?.engine?.node?.input;
    if (node?.context) return node;
    if (performance.now() - t0 > timeoutMs) throw new Error("the app's engine never appeared -- has anything been Run yet?");
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** The context we are using: the app's engine's when it exists, otherwise one of our own so the UI works at once. */
let ownCtx = null;
export const usingOwnContext = () => !!ownCtx && !appCtx;
let appCtx = null;
export function adoptAppContext(ctx) {                 // called when the app's engine finally appears
  if (!ctx || ctx === appCtx) return false;
  // A node belongs to the context that made it: its output cannot be connected to a node of another context (that is
  // the "different audio context" error). So the instruments are REBUILT on the engine's context, not rewired -- and
  // the generation counter tells the window to hand the editor the new engines.
  const prior = [...parts.entries()].map(([n, p]) => [n, p.program, p.patchName]);
  for (const n of [...parts.keys()]) free(n);
  appCtx = ctx;
  inputNode = globalThis.sonicPi?.engine?.node?.input ?? null;
  try { ctx.resume?.(); } catch {}
  gen++;
  say(`the app's engine is up — instruments rebuilt on its context (generation ${generation})`);
  globalThis.__sgrRebuild = prior;                      // the window re-applies the same programs after remounting
  return true;
}
export const generation = () => gen;
let gen = 0;
function bump() { gen++; }
export const outState = () => (inputNode ? "engine bus" : ownCtx ? "speakers (our own context)" : "nowhere");
export async function contextNow() {
  try { return (await waitForEngine(300)).context; } catch { /* no app engine yet */ }
  if (!ownCtx) { ownCtx = new AudioContext({ latencyHint: "interactive" }); say("using our own AudioContext until the app's engine is up (the UI works now; sound waits for Run)"); }
  return ownCtx;
}

export async function ensurePart(name = DEFAULT_PART) {
  const key = String(name);
  const existing = parts.get(key);
  if (existing) return existing;
  if (parts.size >= cap) throw new Error(`no room for part "${key}": the cap is ${cap} (measured cost decides it)`);
  const useCtx = await contextNow();
  ctx = ctx ?? useCtx;
  const engine = new SynthEngine();
  await engine.start({ ctx, connectToDestination: false });   // we route; every part goes into the engine's bus
  const node = engine.audioNode;
  if (!node) throw new Error(`part "${key}" got no node`);
  if (inputNode && inputNode.context === useCtx) { node.connect(inputNode); }        // engine's bus: fx, scope, Recorder
  else { node.connect(useCtx.destination); }                                          // no engine yet: audible through the speakers

  engine.primeTables();
  const made = { engine, node, started: performance.now(), program: null, patchName: "Init" };
  bump();
  parts.set(key, made);
  say(`part "${key}" is up (${parts.size} part(s), cap ${cap})`);
  return made;
}

export const list = () => [...parts.keys()];

/** Which patch a part is playing, for the window's table and selector. */
export function rememberPatch(name, program, patchName) {
  const p = parts.get(String(name));
  if (p) { p.program = program; p.patchName = patchName; }
  return !!p;
}
export const has = (name) => parts.has(String(name));
export const engineOf = (name) => parts.get(String(name))?.engine ?? null;

// Sounding a note is immediate, always: this is an instrument, and WHEN a performance signal is sent is Sonic Pi's
// business (its own scheduler), not ours. See docs/plan/soundgineer-multipart-argument.md 5.8.
export async function noteOn(name, note, velocity = 1) { (await ensurePart(name)).engine.noteOn(note, velocity); }
export function noteOff(name, note) { parts.get(String(name))?.engine.noteOff(note); }
// A parameter may arrive for a channel that has not played yet (a program change or a CC before the first note), so
// it creates the part instead of dropping the message -- measured: a CC to an uncreated channel did nothing at all.
export function setParam(name, id, value) {
  const p = parts.get(String(name));
  if (p) { p.engine.setParamById(id, value); return true; }
  ensurePart(name).then((made) => made.engine.setParamById(id, value)).catch(() => {});
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
  say(`part "${name}" released`);
  return true;
}

/** What the probe and the window need, per part and in total. */
export const state = () => ({
  context: ctx ? { sampleRate: ctx.sampleRate, state: ctx.state } : null,
  ownContext: !appCtx,
  cap,
  parts: Object.fromEntries([...parts].map(([n, p]) => [n, {
    voices: p.engine.voiceCount ?? 0,
    peak: Math.max(p.engine.peakL ?? 0, p.engine.peakR ?? 0),
    params: p.engine.values?.length ?? null,
    program: p.program ?? null,
    patch: p.patchName ?? "Init",
  }])),
  count: parts.size,
});
