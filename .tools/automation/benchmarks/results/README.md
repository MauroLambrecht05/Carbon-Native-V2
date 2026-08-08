# Benchmark results

One folder per measurement session, named `YYYY-MM-DD-<what-was-measured>`.

**Never overwrite a previous folder.** A result is a record of what the code did
on a given day on given hardware; editing it in place destroys the only thing
that makes a trend line meaningful. New run → new folder.

## Layout of a session folder

```
2026-04-26-10-stack-sweep/
├── INDEX.md      what was measured vs. projected vs. cited, and the hardware
├── RESULTS.md    the headline comparison table
├── <stack>.md    one per stack measured
└── raw/          harness output — *.json (parsed) + *.log (stdout)
```

`INDEX.md` is the important one: it classifies every number as MEASURED /
PRIOR / PROJECTED / CITED / N/A. Keep that discipline — a benchmark that
doesn't distinguish a measurement from an extrapolation isn't a benchmark.

## Sessions

| folder | what | hardware |
|---|---|---|
| `2026-04-26-10-stack-sweep/` | 10 stacks × 38 metrics — carbon-mini v1/v2, carbon-native, carbon-verso v1/v2, voltframe v03 + qjs, Tauri, Electron, Electrobun | Ryzen 7 5825U / 35.86 GB / Win 11 Pro 25H2 |
| `2026-05-10-carbon-mini-discord/` | carbon-mini under a real workload — React 18 Discord-style client, ~500 scene nodes/frame | same |

## Reproducing

Harness lives one level up in `scripts/benchmarks/`. The competitor apps the
sweep measures against are in `archive/baselines/` (local only — see
`archive/README.md`).

```powershell
.\scripts\benchmarks\bench-runtime-v2.ps1 -Name carbon-mini `
  -Exe .\runtimes\mini\target\release\carbon-mini.exe -N 5
```
