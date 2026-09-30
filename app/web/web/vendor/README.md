# vendor/

Third-party files that ship inside the build. They are copied verbatim, with their licence, and the build
script copies this directory into the artifact -- nothing here is fetched at run time (an offline check
enforces that: `tools/offline-check.mjs`).

## webaudio-controls.js — Apache-2.0

Synth-panel parts as Web Components: `<webaudio-knob>`, `<webaudio-slider>`, `<webaudio-switch>`,
`<webaudio-param>`, `<webaudio-keyboard>`.

* source: https://github.com/g200kg/webaudio-controls (master)
* authors: Eiji Kitamura, Ryoya Kawai, Keisuke Ai, g200kg (Tatsuya Shinyagaito), 2013-2019
* licence: Apache License 2.0 -- `LICENSE-webaudio-controls.txt` beside this file. Apache-2.0 is compatible
  with this project's AGPL-3.0-or-later; the file keeps its own copyright and licence header.
* 72 KB, no dependencies, no build step, and **no external assets**: its default knob/slider/switch art is
  inline `data:image/svg+xml`, which is why it can live inside a self-contained artifact.
* the only absolute URLs in it are in its comments (the Apache licence, the author's pages, the SVG
  namespace) -- checked with the offline check, which reports "no file a browser loads FETCHES from a CDN".

Loaded lazily by `web/synth-ui.js`, the first time the synth editor is opened, so the app's normal payload
does not carry it.
