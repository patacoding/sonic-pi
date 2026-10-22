# Diagnosing "the first Run after a page load skips the first loop"

What is already known, measured in the runtime (not in the app): the first event of a track **is** emitted, warm and cold, with
and without the `pdeclared` bracket around the Run. So the layer is not dropping it. The difference has to be between the Run and
the engine, and the only place that can be measured is the app itself.

Reload the page (this is the first-Run case, which is the one that misbehaves), open the console, and paste this **once**:

```js
(async () => {
  const s = window.sonicPiSession;
  if (!s) return console.log("no sonicPiSession on this page");
  const run = (code) => s.run(code);
  await run("$pampa_pattern_debug = true");
  await run("set :pampa_loop_bars, 1");
  await run("set :pampa_beats_per_bar, 4");
  const t0 = performance.now();
  await run('r = pplay(ppattern([57, 60, 62, 64]), use: :play, name: :diag); puts "start " + r[:start_beat].to_s');
  await new Promise((r) => setTimeout(r, 7000));
  const recs = s.recent(300);
  console.log("since Run (ms):", Math.round(performance.now() - t0));
  console.log("session status:", s.status());
  console.log("lines:", recs.filter((r) => r.kind === "output").map((r) => r.text).filter((t) => /start|\[ptrack\]/.test(t)));
  console.log("sounds:", recs.filter((r) => r.kind === "synth").map((r) => ({ n: r.args?.note, beat: r.beat, time: r.time && +r.time.toFixed(2) })));
})()
```

What the output tells us, and which way each answer points:

| What you see | What it means | Where the fix goes |
|---|---|---|
| A `[ptrack] … target=… woke_at=…` line for the first beat, and `sounds` contains note 57 at that beat | the layer produced it and the engine received it — the first **loop** was not skipped, something else sounded wrong | back to the music, not the code |
| The `[ptrack]` line is there but note 57 is **absent** from `sounds` | the event was delivered and the **engine** dropped it: the app's engine was not ready at that moment | the app's first-Run path (our SP-EXT hunk): wait for the engine before the first pattern Run |
| No `[ptrack]` line at all | the track never ran: the gate did not release, or the run was superseded | the Run gate (`pdeclared`, `whenReady`) |
| `target` is in the past relative to `woke_at` | the track started late (its start beat was already behind) | the start lead in `pplay` |

Paste the four lines and the first few `sounds` entries; that is enough to place it without another guess.
