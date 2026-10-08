// Build the vendored Soundgineer into our layer's shape.
//
// Two outputs, because the two halves live in different worlds:
//   web/synth/vendor/soundgineer.js          an ES module we import on the page (main-thread engine + shared code)
//   web/synth/vendor/soundgineer-worklet.js  a plain script for audioWorklet.addModule (no imports allowed there)
//
// The one Vite-ism in upstream's code -- `import processorUrl from '../worklet/processor.ts?worker&url'` -- is
// resolved by the tiny plugin below to the URL of the second output, so upstream's engine.ts needs no edit for
// this (patch rules: new files and the smallest possible hunks, see web/synth/PATCHES.md).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "vendor/soundgineer/src");
const OUT = path.join(ROOT, "web/synth/vendor");
const WORKLET_NAME = "soundgineer-worklet.js";

fs.mkdirSync(OUT, { recursive: true });

/** Resolve upstream's `?worker&url` import to the built worklet's URL. */
const workerUrl = {
  name: "soundgineer-worker-url",
  setup(b) {
    b.onResolve({ filter: /\?worker&url$/ }, () => ({ path: "worker-url", namespace: "sg-worker" }));
    b.onLoad({ filter: /.*/, namespace: "sg-worker" }, () => ({
      // resolve against THIS module's own URL, not the page's: the page lives at /web/code.html but the bundle is
      // /web/synth/vendor/soundgineer.js, and addModule() resolves a bare relative path against the document
      // (which is how the first attempt 404'd)
      contents: `export default new URL("./${WORKLET_NAME}", import.meta.url).href;`,
      loader: "js",
    }));
  },
};

const shared = { bundle: true, target: "es2022", logLevel: "warning", sourcemap: false };

// the worklet: self-contained, no imports at runtime
await build({ ...shared, entryPoints: [path.join(SRC, "worklet/processor.ts")], outfile: path.join(OUT, WORKLET_NAME), format: "iife" });
// the page side: what we import
await build({ ...shared, entryPoints: [path.join(SRC, "audio/engine.ts")], outfile: path.join(OUT, "soundgineer.js"), format: "esm", plugins: [workerUrl] });
// their own editor UI (buildApp(engine, container)) and the stylesheet it expects, so the window can host the real
// interface instead of a placeholder. The CSS is scoped at load time by our window -- see window.js -- because it is
// written for their whole page and we are not allowed to restyle anything of Sonic Pi's.
await build({ ...shared, entryPoints: [path.join(SRC, "ui/app.ts")], outfile: path.join(OUT, "soundgineer-ui.js"), format: "esm" });
await build({ ...shared, entryPoints: [path.join(SRC, "style.css")], outfile: path.join(OUT, "soundgineer-ui.css") });

// the parameter table, so our adapter can address parameters by id without guessing
await build({ ...shared, entryPoints: [path.join(SRC, "shared/params.ts")], outfile: path.join(OUT, "soundgineer-params.js"), format: "esm" });

for (const f of [WORKLET_NAME, "soundgineer.js", "soundgineer-params.js", "soundgineer-ui.js", "soundgineer-ui.css"]) {
  const p = path.join(OUT, f);
  const kb = (fs.statSync(p).size / 1024).toFixed(1);
  const imports = /\bimport\s*[({"]/.test(fs.readFileSync(p, "utf8")) && f !== WORKLET_NAME;
  console.log(`  ${f.padEnd(28)} ${kb.padStart(7)} KB${f === WORKLET_NAME ? "  (no imports)" : ""}`);
}
// The layer must stay self-contained: no runtime fetch, no remote script, no worker started from a URL. A future
// upstream change that introduces one is caught here, rather than on a CDN by a player who hears nothing.
const banned = /\b(fetch\s*\(|XMLHttpRequest|importScripts\s*\()/;
for (const f of [WORKLET_NAME, "soundgineer.js", "soundgineer-params.js"]) {
  const text = fs.readFileSync(path.join(OUT, f), "utf8");
  if (banned.test(text)) {
    console.error("  " + f + " reaches for the network at runtime -- our artifact must not");
    process.exit(1);
  }
  const remote = [...text.matchAll(/https?:\/\/([^"'\s)]+)/g)].map((m) => m[1]).filter((h) => !/^www\.w3\.org/.test(h));
  if (remote.length) console.log("  note: " + f + " mentions " + [...new Set(remote)].slice(0, 2).join(", ") + " (not a fetch)");
}

const wl = fs.readFileSync(path.join(OUT, WORKLET_NAME), "utf8");
if (/^\s*import\s/m.test(wl)) { console.error("the worklet bundle contains an import -- addModule would fail"); process.exit(1); }
