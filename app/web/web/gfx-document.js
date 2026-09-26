// SPDX-License-Identifier: AGPL-3.0-or-later
// A shader document: the passes, the shared block, and what each channel draws from.
//
// This is Shadertoy's shape, which the user asked for, with one addition -- several of these
// documents, switched during a performance. Shadertoy is one page, one shader; here switching the
// look is a requirement of playing live, not a convenience, so a document is a value that can be
// held in a list, saved, loaded and swapped. Nothing in this file knows about GL or the DOM: it is
// the shape, and the rules about what may be in it.
//
//   { version, name, common, passes: { "Buffer A"…"Image": source }, channels: { <pass>: [4 refs] } }
//
// A pass whose source is blank is OFF: not compiled, not rendered. That is how Buffer C costs nothing
// when a piece does not use it. `Common` is not a pass -- it is text put in front of every pass, which
// is the whole of Shadertoy's sharing mechanism and why the web side needs no `#include`.
//
// ── What a channel may draw from ────────────────────────────────────────────────────────────────
//
//   { kind: "none" }                          nothing: bound to a 1x1 black texture, never a null
//   { kind: "buffer", buffer: "Buffer A" }    one of this document's own buffers
//   { kind: "image", name: "photo.jpg" }      a picture the player uploaded THIS SESSION
//   { kind: "audio", band: "fft" | "wave" }   the engine's own audio, as a 512x2 texture (renderer)
//
// A channel never refers to another document's buffer: documents are self-contained, as Shadertoy's
// are. And `kind: "image"` names a picture; it does not carry one.
//
// ── The rule this file exists to keep ───────────────────────────────────────────────────────────
//
// ONLY THE CODE IS SAVED. An audio channel carries nothing at all but the fact that it wants audio --
// the samples are the engine's, made this frame, so there is nothing to write down. A picture the
// player uploads lives in this session's memory and nowhere
// else: `serialize` writes the name a channel asks for and never the bytes, so nothing about the
// image reaches localStorage. A reload therefore finds a document that wants a picture it does not
// have -- `missingImages` is how the editor knows to say so, and the renderer draws a placeholder
// rather than a black hole or an exception. That is a deliberate trade (the player's own photos stay
// on the player's machine) and it is asserted in tools/gfx-ui-probe rather than trusted.

export const PASS_ORDER = ["Buffer A", "Buffer B", "Buffer C", "Buffer D", "Image"];
export const SHARED = "Common";
export const BUFFER_PASSES = PASS_ORDER.filter((p) => p !== "Image");
export const CHANNELS = 4;
export const VERSION = 1;

const blank = () => ({ kind: "none" });

/** A document with nothing in it but the given Image pass. */
export function emptyDocument(name = "Untitled", imageSource = "") {
  return {
    version: VERSION,
    name,
    common: "",
    passes: Object.fromEntries(PASS_ORDER.map((p) => [p, p === "Image" ? imageSource : ""])),
    channels: Object.fromEntries(PASS_ORDER.map((p) => [p, Array.from({ length: CHANNELS }, blank)])),
  };
}

const isRef = (r) => r && typeof r === "object" && ["none", "buffer", "image", "audio"].includes(r.kind);
export const AUDIO_BANDS = ["fft", "wave"];

/**
 * Whatever came out of storage, made into a document this code can trust: unknown passes dropped,
 * a channel that names a buffer that cannot be read from (itself is fine -- that is feedback) or a
 * missing kind replaced with nothing. Storage is the one place junk arrives from, and a document
 * that throws on load is worse than one that starts empty.
 */
export function normalizeDocument(raw) {
  if (!raw || typeof raw !== "object") return emptyDocument();
  const passes = {};
  for (const p of PASS_ORDER) passes[p] = typeof raw.passes?.[p] === "string" ? raw.passes[p] : "";
  const channels = {};
  for (const p of PASS_ORDER) {
    const given = Array.isArray(raw.channels?.[p]) ? raw.channels[p] : [];
    channels[p] = Array.from({ length: CHANNELS }, (_, i) => {
      const r = given[i];
      if (!isRef(r)) return blank();
      if (r.kind === "buffer" && !BUFFER_PASSES.includes(r.buffer)) return blank();
      if (r.kind === "image" && (typeof r.name !== "string" || !r.name)) return blank();
      if (r.kind === "audio" && !AUDIO_BANDS.includes(r.band)) return blank();
      return r.kind === "buffer" ? { kind: "buffer", buffer: r.buffer }
           : r.kind === "image" ? { kind: "image", name: r.name }
           : r.kind === "audio" ? { kind: "audio", band: r.band }
           : blank();
    });
  }
  return {
    version: VERSION,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 60) : "Untitled",
    common: typeof raw.common === "string" ? raw.common : "",
    passes,
    channels,
  };
}

/** The passes that will actually be compiled and drawn, in the order they are drawn. */
export const activePasses = (doc) => PASS_ORDER.filter((p) => (doc.passes[p] ?? "").trim() !== "");

/** Is this pass one that draws into a texture rather than to the screen? */
export const isBuffer = (pass) => BUFFER_PASSES.includes(pass);

/** Every picture this document wants, so the editor can tell the player which are not here. */
export function wantedImages(doc) {
  const want = new Set();
  for (const p of PASS_ORDER) for (const r of doc.channels[p] ?? []) if (r?.kind === "image") want.add(r.name);
  return [...want];
}

/** Wanted but not in this session -- the ones drawn as a placeholder, and named in the editor. */
export const missingImages = (doc, present) => wantedImages(doc).filter((n) => !present.has(n));

/**
 * The document as storage takes it. THE PICTURES ARE NOT IN HERE -- only the names a channel asks
 * for. This is the function that keeps the promise that only code is saved, so it is worth keeping
 * obvious: there is nowhere in its output for image bytes to be.
 */
export const serialize = (doc) => JSON.stringify(normalizeDocument(doc));

/** And back, with the same distrust of what was stored. */
export const deserialize = (text) => {
  try { return normalizeDocument(JSON.parse(text)); } catch { return null; }
};

// ── A set of them ─────────────────────────────────────────────────────────────────────────────────
// Why there is more than one document at all: switching the look mid-performance is a requirement of
// playing live, and Shadertoy cannot do it because it is one page with one shader in it. So the saved
// thing is a set -- the documents, and which one was on screen -- and the editor's tabs are the set.
//
//   { version, current, documents: [document, ...] }
//
// Names are how a document is asked for (`puts :gfx, :document, "rings"`), so they are made unique on
// the way in: two documents with one name would make that directive a coin toss.

export const SET_VERSION = 1;

export function emptySet(doc) {
  const first = normalizeDocument(doc ?? emptyDocument());
  return { version: SET_VERSION, current: first.name, documents: [first] };
}

/** A name not already taken, made from `want`: "rings", then "rings 2", "rings 3"… */
export function uniqueName(documents, want) {
  const taken = new Set(documents.map((d) => d.name));
  const base = (typeof want === "string" && want.trim() ? want.trim().slice(0, 60) : "Untitled");
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) { const name = `${base} ${n}`; if (!taken.has(name)) return name; }
}

/**
 * Whatever came out of storage, made into a set this code can trust. An unreadable set is one empty
 * document rather than an exception, and a `current` that names nothing becomes the first document --
 * a set whose current document cannot be found is a set with no picture at all.
 */
export function normalizeSet(raw, fallbackName = "Untitled") {
  const given = Array.isArray(raw?.documents) ? raw.documents : [];
  const documents = [];
  for (const d of given) {
    const doc = normalizeDocument(d);
    // two documents with one name would make `puts :gfx, :document, "name"` a coin toss
    doc.name = uniqueName(documents, doc.name);
    documents.push(doc);
  }
  if (!documents.length) return emptySet(emptyDocument(fallbackName));
  const current = documents.some((d) => d.name === raw?.current) ? raw.current : documents[0].name;
  return { version: SET_VERSION, current, documents };
}

/**
 * The set as storage takes it. As with one document, THE PICTURES ARE NOT IN HERE: a channel's picture
 * is a name and only a name, all the way down.
 */
export const serializeSet = (set) => JSON.stringify(normalizeSet(set));

/** And back. Null for anything unreadable, so the caller can tell "nothing saved" from "saved empty". */
export const deserializeSet = (text) => {
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.documents)) return null;
    return normalizeSet(raw);
  } catch { return null; }
};
