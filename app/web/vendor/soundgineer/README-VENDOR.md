# Soundgineer (vendored)

Upstream: https://github.com/noisyloop/soundgineer — our fork: https://gitee.com/pampa666/soundgineer
Licence: MIT (see LICENSE). Zero runtime dependencies.

This is a **pinned copy** of the engine's source. See `UPSTREAM-COMMIT.txt` for the exact upstream commit.

Our changes to it are deliberately tiny and tagged `SP-EXT:` so they can be found with one grep, kept small
enough to send upstream as pull requests, and dropped if upstream lands an equivalent hook. The ledger of every
such hunk lives in `sonic-pi/app/web/web/synth/PATCHES.md`. Upgrades are done on the `sp-integration` branch of
our fork (`git fetch upstream && git rebase upstream/main`), then the probe suite decides whether the pin moves.
