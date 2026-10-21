# Upstream touches, and why

The pattern layer is a bolt-on: its code lives in `app/web/pattern/` and in the session, never in the runtime's Ruby sources,
and no wasm is rebuilt. Two lines of upstream are touched, both recorded here.

| File | What | Why it has to be upstream |
|---|---|---|
| `web/sonic_pi.js` (`WorkerSession`, a `recent` field) | Keeps the last 300 records the session emitted. | A separate view of the session needs to read what it emitted; the records were already delivered to the app's panes and then dropped. |
| `web/sonic_pi.js` (`WorkerSession`, constructor) | Sets `globalThis.sonicPiSession = { run, stop, stopJob, status, recent }`. | A second editor page cannot reach a session it was not constructed with. It exposes methods that already exist and changes no behaviour. |

Both are marked `SP-EXT(pattern)` in place.

## What was deliberately NOT done

- Shadertoy/gfx needs no such handle: it is its own editor (`web/gfx-editor/`) and listens to the **engine**, which it does not
  run code in.
- Soundgineer needs none either: it is our own window on our own engine, and it does not execute Sonic Pi programs.
- The pattern layer is the first feature that must **run code in the live session**, which is why it is the first to need a
  handle at all.

## Still to do

`pattern-boot.js`'s loader asks its `run(code)` adapter for `{ output, errors }`; the handle returns a **job id**. The lab page
needs a small adapter that polls `sonicPiSession.recent()` for that job's records (with a timeout) and turns them into the
`{ output, errors }` the loader expects. Until that exists the layer can be loaded by the harness but not driven from the lab
page, and this file says so rather than implying otherwise.
