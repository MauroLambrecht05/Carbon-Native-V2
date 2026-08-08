# Phase 3 benchmark driver.
#
# Builds the carbon-fast-math bench_runner in release mode, runs it, and
# captures the BENCH summary lines into a JSON file plus a Markdown table
# committed to docs/PHASE3_BENCH.md.
#
# Usage:
#   .\bench-phase3.ps1
#   .\bench-phase3.ps1 -OutMd docs/PHASE3_BENCH.md  -OutJson bench-phase3.json
#
# This script intentionally does NOT depend on bench-runtime-v2.ps1 -- the
# bench is in-process JS, not a process-launch measurement, so it has its
# own simple harness in Rust (median of 5 samples per scenario).

param(
  [string]$OutMd = "docs/PHASE3_BENCH.md",
  [string]$OutJson = "docs/PHASE3_BENCH.json"
)

$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot ".."
$crate = Join-Path $root "packages/carbon-fast-math"

Write-Host "[bench-phase3] building carbon-fast-math bench_runner (release)..."
# Cargo writes "Finished" to stderr even on success. PowerShell's native-
# command error trapping treats any stderr output as a non-terminating
# error under $ErrorActionPreference='Stop'. Temporarily relax that for
# the build step so we don't false-fail.
Push-Location $crate
$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  cmd /c "cargo build --release --bin bench_runner 2>&1" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "cargo build failed (exit $LASTEXITCODE)"
  }
} finally {
  Pop-Location
  $ErrorActionPreference = $prev
}

$exe = Join-Path $crate "target/release/bench_runner.exe"
if (-not (Test-Path $exe)) { throw "bench_runner.exe not found at $exe" }

Write-Host "[bench-phase3] running bench_runner (this takes ~1-2 minutes)..."
# bench_runner emits the BENCH summary lines on stdout and human-readable
# progress on stderr. Same as cargo, the stderr output trips PowerShell's
# error-action handling, so use cmd /c with redirection.
$tempStdout = "$env:TEMP\bench-phase3-stdout.txt"
$tempStderr = "$env:TEMP\bench-phase3-stderr.txt"
$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  cmd /c "`"$exe`" > `"$tempStdout`" 2> `"$tempStderr`""
  if ($LASTEXITCODE -ne 0) {
    Get-Content $tempStderr | Select-Object -Last 30 | ForEach-Object { Write-Host $_ }
    throw "bench_runner exited with $LASTEXITCODE"
  }
} finally {
  $ErrorActionPreference = $prev
}
# Echo the human-readable progress to the console.
Get-Content $tempStderr | ForEach-Object { Write-Host $_ }
$out = Get-Content $tempStdout

# Parse the BENCH lines emitted on stdout. They look like:
#   BENCH vector3_add_chain iters=1000000 js_ms=21.31 rust_ms=2.07 ...
$rows = @()
foreach ($line in $out) {
  if ($line -match '^BENCH\s+(?<name>\w+)\s+iters=(?<n>\d+)\s+js_ms=(?<jms>[\d.]+)\s+rust_ms=(?<rms>[\d.]+)\s+js_ns_per_op=(?<jnpo>[\d.]+)\s+rust_ns_per_op=(?<rnpo>[\d.]+)\s+speedup=(?<sp>[\d.]+)') {
    $rows += [pscustomobject]@{
      name = $Matches.name
      iterations = [int]$Matches.n
      js_ms = [double]$Matches.jms
      rust_ms = [double]$Matches.rms
      js_ns_per_op = [double]$Matches.jnpo
      rust_ns_per_op = [double]$Matches.rnpo
      speedup = [double]$Matches.sp
    }
  }
}

if ($rows.Count -eq 0) {
  throw "no BENCH lines parsed -- bench_runner may have failed mid-run"
}

# Resolve out paths relative to repo root if not absolute.
function Resolve-Out([string]$p) {
  if ([System.IO.Path]::IsPathRooted($p)) { return $p }
  return (Join-Path $root $p)
}
$OutMd = Resolve-Out $OutMd
$OutJson = Resolve-Out $OutJson

# Write JSON
$rows | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -Path $OutJson
Write-Host "[bench-phase3] wrote $OutJson"

# Build Markdown
$now = Get-Date -Format "yyyy-MM-dd"
$lines = @()
$lines += "# Phase 3 benchmarks -- carbon-fast-math vs JS three.js-like ($now)"
$lines += ""
$lines += "Each scenario runs 1,000,000 ops x 5 samples (median reported). All"
$lines += "timings are inside the SAME rquickjs context -- only the math"
$lines += "implementation differs. JS baseline mirrors three.js's source for"
$lines += "the exercised methods bit-for-bit."
$lines += ""
$lines += "Bench source: ``packages/carbon-fast-math/src/bin/bench_runner.rs``"
$lines += "Driver: ``scripts/bench-phase3.ps1``"
$lines += ""
$lines += "| Scenario | iters | JS (ms) | Rust (ms) | JS ns/op | Rust ns/op | speedup |"
$lines += "|---|---:|---:|---:|---:|---:|---:|"
foreach ($r in $rows) {
  $lines += ("| {0} | {1:N0} | {2:N2} | {3:N2} | {4:N2} | {5:N2} | **{6:N2}x** |" -f `
    $r.name, $r.iterations, $r.js_ms, $r.rust_ms, $r.js_ns_per_op, $r.rust_ns_per_op, $r.speedup)
}
$lines += ""
$lines += "## Notes"
$lines += ""
$lines += "- Speedups vary widely by scenario. Heavy-compute methods like"
$lines += "  ``Matrix4.multiply`` (16 mul + 12 add per row x 4 rows) win biggest"
$lines += "  because the per-op JS-side overhead becomes dominated by actual math."
$lines += "- Light methods like ``Vector3.add`` (3 floats x 1 add each) show"
$lines += "  smaller wins because the rquickjs ``This<Class<...>>`` + ``borrow_mut``"
$lines += "  marshaling cost is comparable to the JS work itself."
$lines += "- ``Vector3.dot`` shows ~1x speedup because the JS implementation is a"
$lines += "  trivial 3-mul + 2-add expression with no dispatch overhead, and the"
$lines += "  rquickjs FFI hop adds about as much cost as the math."
$lines += "- The 'realistic scene' workload's bottleneck is the JS-side min/max"
$lines += "  bookkeeping loop, not the matrix math -- explaining its modest gain."
$lines += "  Future work: ship a ``Box3.expandByPoint`` fast path that swallows"
$lines += "  the entire min/max comparison into Rust."

$lines -join "`n" | Set-Content -Encoding UTF8 -Path $OutMd
Write-Host "[bench-phase3] wrote $OutMd"
Write-Host ""
Write-Host "Done. Speedups:"
foreach ($r in $rows) {
  $stars = "*" * [int]([math]::Min($r.speedup, 20))
  Write-Host ("  {0,-26} {1,6:N2}x  {2}" -f $r.name, $r.speedup, $stars)
}
