# Diagnosing "the first Run after a page load skips the first loop"

The session — and with it `window.sonicPiSession` — **does not exist until the first Run creates it**. That is why a snippet pasted
on a fresh page answers "no sonicPiSession": it is earlier than the thing it is asked to inspect. So the protocol is two steps, and
the first step is the failing Run itself.

## Step 1 — put this in the buffer and press the app's Run

```ruby
$pampa_pattern_debug = true
set :pampa_loop_bars, 1
set :pampa_beats_per_bar, 4
pplay ppattern([57, 60, 62, 64]), use: :play, name: :diag
```

This is the first Run after the page load, which is the one that misbehaves. Let it play ~6 seconds.

## Step 2 — paste this in the console and copy what it prints

```js
(() => {
  const s = window.sonicPiSession;
  if (!s) return console.log("still no session: the Run did not create one (tell me that)");
  const recs = s.recent(400);
  console.log("status:", s.status());
  console.log("lines:", recs.filter((r) => r.kind === "output").map((r) => r.text).filter((t) => /start|\[ptrack\]/.test(t)));
  console.log("sounds:", recs.filter((r) => r.kind === "synth").map((r) => ({ n: r.args?.note, beat: r.beat, time: r.time && +r.time.toFixed(2) })));
})()
```

## Reading it

| What you see | What it means | Where the fix goes |
|---|---|---|
| A `[ptrack] … target=… woke_at=…` line for the first beat, and note 57 in `sounds` at that beat | the layer produced it and the engine received it: the first loop was not skipped | back to the music, not the code |
| The `[ptrack]` line is there but note 57 is **absent** from `sounds` | delivered, and the **engine** dropped it — the engine was not taking sounds yet at that moment | the first-Run path: hold the first pattern Run until the engine is ready |
| No `[ptrack]` line | the track never ran: gate or supersede | the Run gate (`pdeclared`, `whenReady`) |
| `woke_at` behind `target` | the track's start beat was already behind it | the start lead in `pplay` |

Paste `status`, `lines` and the first few `sounds` entries. That places it without another guess.

## What is already ruled out

Measured in the runtime, not in the app: the first event of a track **is** emitted, warm and cold, with and without the
`pdeclared` bracket around the Run, and it is present in the record stream (in the bracketed case it lands in the `pdeclared :end`
run's stream, which is why my first count missed it). The scheduling rules, the REST skip and the timetag are pinned by the
pipeline: 17/17.
