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
//   node scripts/build-gfx-editor.mjs            # once
//   node scripts/build-gfx-editor.mjs --watch    # rebuild on change
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "web/gfx-editor");
const OUT = SRC;   // editor.js beside its entry: entry.js is source, editor.js is the artifact

const options = {
  entryPoints: [path.join(SRC, "entry.js")],
  outdir: OUT,
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
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching web/gfx-editor");
} else {
  await esbuild.build(options);
  const size = fs.statSync(path.join(OUT, "editor.js")).size;
  console.log(`built web/gfx-editor/editor.js (${(size / 1024).toFixed(0)} kB)`);
}
