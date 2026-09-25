# prebuilt/

The runtime, built. Two files:

    sp_runtime.mjs    19,698 bytes
    sp_runtime.wasm   1,749,060 bytes   runtime version 4.0.0

They are here so that a dev tree needs nothing from the network to get running. The page and its
worker both load these as `runtime/sp_runtime.{mjs,wasm}` (app/src/main.js, web/live-worker.js), and
`scripts/serve.mjs` answers them out of `build/runtime/` — so these are the source, not the served
copy. `tools/install-runtime.sh` in the docs repo copies them there, along with the random tables and
the sample facts they also need. Nothing reads this directory directly.

    sha256  99fffb9cbe53420da8e682c82c9f51052ebf3048dd87c30cb8d334b59a9fc2ee  sp_runtime.mjs
    sha256  a66d74e032d81ecffafa8596d7bb048332cda1e9708997699e98a7ca878d2b6e  sp_runtime.wasm

## Where they came from, and why they are not built here

These are the official build, fetched from <https://sonic-pi.net/runtime/> on 2026-09-25 — the same
bytes `https://sonic-pi.net/code.html` loads. Checked against this checkout before being kept:

* `node runtime/bin/live-check.mjs` — the tree's own harness, driving these bytes: **608 pass, 0 fail**;
* the `samples.json` this tree builds from `etc/samples` is byte for byte the one the deployed site
  serves (`9169ee26ac09a7cf730c…`), so the tree and the deployed build agree on the sample set.

`runtime/` builds these with `scripts/build-runtime.sh --wasm`, which needs **Emscripten** (about
1.5 GB, and it has to be fetched over the same network that makes this awkward). That is the honest
way to produce them — and the **only** way to produce them once the runtime's own Ruby changes,
because the runtime's Ruby is compiled to bytecode and linked into the wasm
(`scripts/build-runtime.sh`: `mrbc -B sp_runtime_irep`). Editing `runtime/lib/sonic_pi/*.rb` and
re-running anything but a wasm build changes nothing at all.

So: these two are a convenience for developing the page, and a stand-in for a build this machine
cannot make yet. **Treat them as stale the moment the runtime's Ruby changes.**

## Licence

Sonic Pi's runtime is AGPL-3.0-or-later, the same as the rest of `app/web` (the repository's
LICENSE.md has the detail).
