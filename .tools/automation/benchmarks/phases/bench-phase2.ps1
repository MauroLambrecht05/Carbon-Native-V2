# Phase 2 — carbon-three-renderer benchmark (PS wrapper).
#
# Thin shell over `bun run scripts/bench-phase2.ts`. Lives in PowerShell
# because the rest of the repo's bench harnesses do; the actual work is
# all JS-side and lives in the .ts companion.
#
# Usage:
#   .\bench-phase2.ps1                 # run with defaults
#   .\bench-phase2.ps1 -OpenReport     # open the markdown report when done
param(
  [switch]$OpenReport
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$ts   = Join-Path $root "scripts\bench-phase2.ts"
$out  = Join-Path $root "docs\PHASE2_BENCH.md"

if (-not (Test-Path $ts)) { throw "bench script not found: $ts" }

Write-Host "[bench-phase2] running JS-side bench…" -ForegroundColor Cyan
& bun run $ts
if ($LASTEXITCODE -ne 0) { throw "bench-phase2.ts exited $LASTEXITCODE" }

Write-Host "[bench-phase2] done — report at $out" -ForegroundColor Green
if ($OpenReport) {
  Start-Process $out
}
