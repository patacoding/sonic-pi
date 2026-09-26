#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds the shader pane's editing surface: web/gfx-editor/entry.js -> web/gfx-editor/editor.js.
// Part of the gfx layer, and a new file: upstream's own build (scripts/build-app.mjs) copies an
// explicit list of web/* into the site, so this bundles its own output rather than editing that
// list -- which is also why tools/offline-check.mjs walks the imports instead of trusting a list.
//
// Mirrors build-app.mjs's options for the reasons its comments give: ESM, es2022, chunks named
// for their contents, a sourcemap. Minified unless --watch.
//
// It builds into a staging directory and MOVES the result into place, rather than letting esbuild write
// web/gfx-editor/editor.js directly. Two readers can catch a half-written 380 kB bundle otherwise: the
// shader pane in a browser (a page fetched while this runs says the editor failed to load), and
// tools/gfx-pane-probe, which imports the bundle. Measured: raced against this build, that probe failed
// 12 of its 62 checks in one run and 1 of 62 in another; after the change below, seven raced rounds were
// clean (one earlier raced run still failed 2 of 62, for a reason that was never found -- so this closes
// the half-written-bundle window, it is not a claim that a probe may be run beside a build). The entry is moved LAST: a reader then sees either the old bundle with its old chunks or the new
// one with its new chunks, never an entry that names a chunk that is not there yet. Chunks are
// content-hashed, so an old reader's files stay put.
//
//   node scripts/build-gfx-editor.mjs            # once
//   node scripts/build-gfx-editor.mjs --watch    # rebuild on change
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "web/gfx-editor");
const OUT = SRC;   // editor.js beside its entry: entry.js is source, editor.js is the artifact
const STAGE = path.join(ROOT, "build/gfx-editor-stage");   // same filesystem, and outside the served tree

/** Move what esbuild just built into place: the chunks, then the entry, then the map. */
function install() {
  const built = fs.readdirSync(STAGE);
  const chunks = fs.existsSync(path.join(STAGE, "chunks")) ? fs.readdirSync(path.join(STAGE, "chunks")) : [];
  if (chunks.length) {
    fs.mkdirSync(path.join(OUT, "chunks"), { recursive: true });
    for (const c of chunks) fs.renameSync(path.join(STAGE, "chunks", c), path.join(OUT, "chunks", c));
  }
  for (const f of ["editor.js", "editor.js.map"]) {
    if (built.includes(f)) fs.renameSync(path.join(STAGE, f), path.join(OUT, f));
  }
  // a chunk nothing on disk names any more, and that nothing can still be reading (a reader's bundle is
  // seconds old, never minutes): the product copies chunks/ whole, so these would otherwise accumulate
  const text = fs.readFileSync(path.join(OUT, "editor.js"), "utf8");
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const c of fs.existsSync(path.join(OUT, "chunks")) ? fs.readdirSync(path.join(OUT, "chunks")) : []) {
    const p = path.join(OUT, "chunks", c);
    if (!text.includes(c) && fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p);
  }
  fs.rmSync(STAGE, { recursive: true, force: true });
}

const options = {
  entryPoints: [path.join(SRC, "entry.js")],
  outdir: STAGE,
  entryNames: "editor",
  bundle: true,
  format: "esm",
  target: "es2022",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  sourcemap: true,
  minify: !process.argv.includes("--watch"),
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  fs.rmSync(STAGE, { recursive: true, force: true });
  const ctx = await esbuild.context({ ...options, plugins: [{
    name: "install-on-end",
    setup: (build) => build.onEnd((result) => { if (!result.errors.length) install(); }),
  }] });
  await ctx.watch();
  console.log("watching web/gfx-editor");
} else {
  fs.rmSync(STAGE, { recursive: true, force: true });
  await esbuild.build(options);
  install();
  const size = fs.statSync(path.join(OUT, "editor.js")).size;
  console.log(`built web/gfx-editor/editor.js (${(size / 1024).toFixed(0)} kB)`);
}
