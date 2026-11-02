# The desktop's scheduling mechanism, and what the web layer mirrors

Read from `extensions/pattern/*.rb` (async 632, runtime 654, position 163, scheduler 109, delivery 439, pattern-lib 1854 lines).
This is the reference the web implementation is checked against; where it differs, it says so.

## 1. Time base — two numbers, both from Link

- **beats**: `link_get_beat_at_clock_time` — one global clock, consistent across threads, not reset by a reload.
- **seconds per beat**: `link_tempo` — the UI's bpm. Never hard-coded 60, never `use_bpm`.

The web uses the same two through the runtime (`__p.link_beat_at_time`, `link_bpm`), and its `sched_ahead` here is **0.05 s**
(measured), not the desktop's 0.5 — the window is narrower, so the handover must be musical, not the tick.

## 2. One thread per track, position computed rather than negotiated

    gb         = global beat, re-read every pass          (never an accumulated sleep: self-correcting, no drift)
    loop_idx   = floor(gb / loop_beats)
    abs        = loop_idx * loop_beats + onset * cycle_beats
    wait       = abs - gb   ->  sleep wait                (Sonic Pi beats)

Each pass takes **one** wall-clock reading paired with that `gb`, and every event's timetag in the pass derives from it
(measured on the desktop: per-event `Time.now` gave up to 160 ms of error).

The web does the same shape (`pp_base += pp_loop`, `hold = link_beat_at_time(target) - sched_ahead`, then set the thread's logical
time to the target), with one fix of its own: `p.time` is set to the **target**, because `audio_time = start + p.time + sched_ahead`.

## 3. Retirement is the track's own decision

    break unless __pplayers[spec[:name]].equal?(spec)                          # a newer pplay of the same name replaced it
    break if job_id && latest_job_by_source[src] != job_id                    # its line is gone from the buffer's newest run

That is all "commenting a pplay out stops it" is: the track compares the Run it was declared in with the newest Run **of its own
source**, and leaves. No sweep, no extra job.

The web has no `__current_job_id`, so the app puts one line in front of a pattern program (`$pampa_group`, `$pampa_run[group]`)
and the layer prunes in a line after it — **inside the same job**. Two extra jobs around a program was the unstable version
(they race with Stop); self-retirement with a surrogate counter was the regression (it misfired on the first cycle). The inline
version is what ships.

## 4. Anchoring and the bar

- `__panchor_wall(cycle_seconds, mode)`: **`Time.now + 0.4 s`**, and only for `mode == :bar` the engine's bar line. This is why a
  first play waits ~0.4 s, not a bar.
- `__preconcile_at_bar`: a replaced track reconciles at the bar; the old one plays to that point, the new one starts there.

The web mirrors both: `align: true` = now + max(0.4 beat, sched_ahead); a superseded track is cut at the boundary the new one owns.

## 5. Delivery

- An event's value goes to the verb's **first positional** (`default_map_for` reads `VERB_SIGNATURES`).
- A **Hash** value is per-event parameters: its keys become keyword arguments; a key given twice is an error.
- **REST is a position and not a sound** — skipped at delivery, never sent to a verb (web: `Mini::REST`, measured: `sample("~")`
  answered "Unknown sample filter type").
- `synth:` is applied with `use_synth` **inside the track thread** (a thread-local; measured: `use_synth` in the buffer does not
  reach a child thread on the web).

## 6. Limits that are the engine's, not the layer's

- A **512-slot** schedule; beyond it events are dropped and counted (measured on the desktop: 512 exactly, then +8 per 8).
- A **>1000 ms late** event is silently dropped; the engine's `lates`/`max_late_ms` are the honest measure of "is there enough
  lead", not a comfortable-looking epsilon.
- The web host exposes no such metrics, which is why the web pipeline measures gaps and drift instead (16 cases, then 18).

## 7. Where the web still differs, on purpose

| | desktop | web |
|---|---|---|
| job identity | `__current_job_id` | none in-language; a run counter per buffer in the program's first line |
| scheduling window | `sched_ahead` = 0.5 s | 0.05 s (measured), so handover is musical (a lead), not the tick |
| engine metrics | `lates`, `dropped`, `peakDepth` | none exposed; the pipeline measures gaps, drift and heap instead |
| `map:` / `sync:` / `max_pending:` | documented, **not implemented** | not implemented either — the user guide now says so |
| `cycles:` | deleted | removed along with it |
