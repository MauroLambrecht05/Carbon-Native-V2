# scripts/benchmarks

The measurement harness. Results go in `results/`, one dated folder per session
— see `results/README.md` for that convention.

## Runtime benchmarks

| script | measures |
|---|---|
| `bench-runtime-v2.ps1` | **the main harness.** Cold/warm start, host+child RSS, peak RSS, idle CPU, child count. n-sample, emits `.json` + `.log`. Extend this one; don't break v1 compat. |
| `bench-runtime.ps1` | v1. Kept for backward comparison only. |
| `bench-startup.ps1` | startup isolation |
| `bench-timings.ps1` | in-process phase timings (pairs with `CARBON_MINI_TIMING=1`) |

## Dev-loop benchmarks

| script | measures |
|---|---|
| `bench-hmr.ps1` | HMR round-trip, save → repaint |
| `bench-init-run.ps1` | `carbon init` → first window |
| `bench-babel-cache.ts` | per-file Babel cache hit rate |
| `time-dev-iter.ps1` | full dev iteration wall time |

## Subsystem benchmarks

`bench-audio.ps1` · `bench-image.ps1` · `bench-term.ps1` ·
`bench-phase1.ps1` · `bench-phase1_5.ps1` · `bench-phase2.{ps1,ts}` · `bench-phase3.ps1`

## Microbenchmarks

| dir | measures |
|---|---|
| `microbench/` | JS-level harness for isolated primitives |
| `forkbun/` | bun fork/spawn cost — the number that justified a single-process runtime |

Both need `bun install` first (their `node_modules/` are not committed).

## Comparing against other frameworks

The Electron / Tauri / Electrobun apps the sweep measures against live in
`archive/baselines/`, which is local-only. See `archive/README.md`.
