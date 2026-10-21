# The pattern layer (bolt-on): what is installed, and how to take it out

This directory is the whole of it. Nothing upstream is patched, no wasm is rebuilt, and the runtime's Ruby sources are
untouched: every patch below is applied **inside the session**, as ordinary programs, and dies with it.

## Files

| File | What it is |
|---|---|
| `shim.rb` | The four things this runtime lacks and the library needs: `Thread.current`, `Rational#ceil/#floor/#%`, and `String#strip`. Ends with a capability check that raises once, naming what did not take, rather than letting the library fail later with a `NoMethodError` that explains nothing. |
| `library.rb` | The desktop `pattern-lib.rb`, byte-identical (`cmp` against `extensions/pattern/pattern-lib.rb`). Kept unmodified so it can be diffed against the desktop version. |
| `prelude.rb` | The web scheduler: `ppattern`, `pplay`, `pstop` on the language class, with state in `$pampa_pattern_*`. Two timing rules in it were measured, not guessed — see its header. |
| `loader.js` | The only loader: sends the chunks in order, reports `n/total`, probes for readiness, and can disable itself. Built into the served artifact. |
| `README.md` | This file. |

## Where it ends up

```
node scripts/build-pattern.mjs           # writes web/synth/pattern-prelude.js
node scripts/build-pattern.mjs --check   # fails if that file is stale
```

`web/synth/pattern-prelude.js` is the only new file in the served root. It exists because the browser can only fetch what is
under `app/web/web/`; it contains the chunks as strings and the loader. The build also splits `library.rb` into top-level
units, because the runtime's mruby compiler traps inside prism at roughly forty kilobytes of program and the library is
ninety-three.

## The states a caller must respect

```
idle → loading n/total → ready
                        ↘ failed  (the reason names the chunk and file)
ready → disabled (pstop sent, verbs now answer with a clear error)
```

**Pattern code must not run before `ready`.** The layer reports it rather than letting the user's Run fail with `undefined
method 'pplay'`. `load()` is idempotent; two callers share one promise.

## Uninstalling

```
1. stop using loader.js (drop its import, or leave the switch off)
2. if the layer is live now: call disable() — it sends pstop and redefines the verbs to raise
3. reload the page
```

After the reload the session is new: the patches to `Rational`/`String`, the placeholder `Thread`, the three verbs and every
track are gone. There is nothing left in the repository's runtime sources to revert, which is the difference between this
arrangement and patching the runtime.

## What it does not do yet

- A pattern's cycle does not advance between loops (no `iter`/`pswing`/`parrange` yet): each bar plays the same events.
- Only `play`-style verbs are exercised through the pipeline; `sample`, `midi_*` and OSC are untested here.
- The layer is not wired into the synth window yet: no loading indicator, no queue for a Run that arrives early. Those are
  the next steps, and the pipeline must be green before they start.
