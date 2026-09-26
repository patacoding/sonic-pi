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
//
// A channel never refers to another document's buffer: documents are self-contained, as Shadertoy's
// are. And `kind: "image"` names a picture; it does not carry one.
//
// ── The rule this file exists to keep ───────────────────────────────────────────────────────────
//
// ONLY THE CODE IS SAVED. A picture the player uploads lives in this session's memory and nowhere
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

const isRef = (r) => r && typeof r === "object" && ["none", "buffer", "image"].includes(r.kind);

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
      return r.kind === "buffer" ? { kind: "buffer", buffer: r.buffer }
           : r.kind === "image" ? { kind: "image", name: r.name }
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
