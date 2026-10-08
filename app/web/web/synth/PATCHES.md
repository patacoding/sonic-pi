# Patches to the vendored Soundgineer

Ledger of every change we make to upstream's source (plan §4.2, rule R6). Rules: new files by default; a change to
an upstream file is at most ten lines, additive only, tagged `SP-EXT`, and written the way we would submit it as a
pull request; never reorder or renumber the parameter table; protocol extensions stay backward compatible. All
hunks are found with one grep: `grep -rn 'SP-EXT' vendor/soundgineer/src`.

| # | File | What | Lines | Upstream status | Covered by |
|---|---|---|---|---|---|
| 1 | `vendor/soundgineer/src/audio/engine.ts` | `start()` accepts an injected `AudioContext` and, when one is injected, leaves output routing to the host (Sonic Pi connects the node into `engine.node.input`). Called with no argument, behaviour is unchanged. | 5 | pending (PR-able: general-purpose host support) | M1 probe: audible through the engine, `with_fx`, Recorder |
| 2 | `vendor/soundgineer/src/audio/engine.ts` | `get audioNode()` — hands the worklet node to the host instead of it reaching into private state. | 4 | pending (PR-able) | M1 probe: the node is connected and produces peaks |

## Withdrawn

An attempt to give notes a delay in frames inside the worklet (a "waiting room" so a note could be held until a
target frame) was **reverted**: scheduling belongs to Sonic Pi. Sonic Pi decides when a performance signal is sent
-- that is what its internal scheduler is for -- and this instrument is not inside Sonic Pi: it receives note-on,
note-off and parameter changes and sounds them. Holding notes here would be moving Sonic Pi's responsibility into
the instrument, and it produced two failures in a row (a note that fired immediately, then one that never fired) for
a requirement nobody had asked for.

Upstream commit this copy is pinned to: see `vendor/soundgineer/UPSTREAM-COMMIT.txt`.
