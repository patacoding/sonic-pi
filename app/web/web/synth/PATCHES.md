# Patches to the vendored Soundgineer

Ledger of every change we make to upstream's source (plan §4.2, rule R6). Rules: new files by default; a change to
an upstream file is at most ten lines, additive only, tagged `SP-EXT`, and written the way we would submit it as a
pull request; never reorder or renumber the parameter table; protocol extensions stay backward compatible. All
hunks are found with one grep: `grep -rn 'SP-EXT' vendor/soundgineer/src`.

| # | File | What | Lines | Upstream status | Covered by |
|---|---|---|---|---|---|
| 1 | `vendor/soundgineer/src/audio/engine.ts` | `start()` accepts an injected `AudioContext` and, when one is injected, leaves output routing to the host (Sonic Pi connects the node into `engine.node.input`). Called with no argument, behaviour is unchanged. | 5 | pending (PR-able: general-purpose host support) | M1 probe: audible through the engine, `with_fx`, Recorder |
| 2 | `vendor/soundgineer/src/audio/engine.ts` | `get audioNode()` — hands the worklet node to the host instead of it reaching into private state. | 4 | pending (PR-able) | M1 probe: the node is connected and produces peaks |

Upstream commit this copy is pinned to: see `vendor/soundgineer/UPSTREAM-COMMIT.txt`.
