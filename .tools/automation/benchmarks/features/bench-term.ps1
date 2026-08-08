<#
.SYNOPSIS
    Benchmark the carbon-term runtime.
    Measures: cold start, re-render latency (useInput → repaint), complex layout.

.DESCRIPTION
    Three benchmarks are run and results are saved to docs/TERM_BENCH.md.

    1. Cold start  — time from process spawn to first ANSI output on stdout
                     (detects "[carbon-term-timing] phase=first_paint" on stderr).
                     n=5 runs, median reported.

    2. Re-render latency — instruments the runtime's CARBON_TERM_TIMING env var
                     to measure from input-dispatch to next paint cycle.
                     Measured via the "[carbon-term-timing] phase=…" stderr lines.

    3. Complex layout — 100 nested Box nodes, 500 Text nodes.
                     The runtime builds the scene from a pre-compiled JS bundle
                     and we time from bundle-eval to first_paint.

.NOTES
    Requires: carbon-term.exe already built (cargo build --release in runtimes/term/).
    Requires: examples/term-counter dist/bundle.js already built (bun run build).
#>

param(
    [int]$ColdStartRuns   = 5,
    [int]$TimeoutMs       = 5000,
    [string]$OutputFile   = "$PSScriptRoot\..\docs\TERM_BENCH.md"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot\.."

$runtimeExe  = Join-Path $root "runtimes\term\target\release\carbon-term.exe"
$exampleDir  = Join-Path $root "examples\term-counter"
$bundlePath  = Join-Path $exampleDir "dist\bundle.js"

if (-not (Test-Path $runtimeExe)) {
    Write-Error "carbon-term.exe not found at $runtimeExe — run: cargo build --release in runtimes\term"
}
if (-not (Test-Path $bundlePath)) {
    Write-Error "dist\bundle.js not found at $bundlePath — run: bun run build in examples\term-counter"
}

Write-Host "[bench-term] Runtime:   $runtimeExe"
Write-Host "[bench-term] Bundle:    $bundlePath"
Write-Host ""

# ─── Helper: run carbon-term with CARBON_TERM_TIMING=1 + CARBON_TERM_QUIET=1,
#     kill after TimeoutMs, return the stderr lines.
function Invoke-TermRuntime {
    param(
        [string]$BundleDir,
        [int]$KillAfterMs = $TimeoutMs
    )
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName               = $runtimeExe
    $psi.Arguments              = "`"$BundleDir`""
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.Environment["CARBON_TERM_TIMING"] = "1"
    $psi.Environment["CARBON_TERM_QUIET"]  = "1"   # suppress JS console.log noise

    $proc = [System.Diagnostics.Process]::Start($psi)
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    Start-Sleep -Milliseconds $KillAfterMs
    if (-not $proc.HasExited) { try { $proc.Kill() } catch {} }
    $proc.WaitForExit(2000) | Out-Null
    $stderr = $stderrTask.GetAwaiter().GetResult()
    return $stderr -split "`n" | Where-Object { $_ -match '\[carbon-term-timing\]' }
}

# ─── Parse timing line: "[carbon-term-timing] phase=X elapsed_ms=Y.ZZ"
function Get-ElapsedMs {
    param([string[]]$Lines, [string]$Phase)
    $line = $Lines | Where-Object { $_ -match "phase=$Phase\s" } | Select-Object -Last 1
    if ($line -match 'elapsed_ms=([\d.]+)') { return [double]$matches[1] }
    return $null
}

# ══════════════════════════════════════════════════════════════════════════════
# Benchmark 1: Cold start
# ══════════════════════════════════════════════════════════════════════════════
Write-Host "[bench-term] === Benchmark 1: Cold start (n=$ColdStartRuns) ==="
$coldStarts = @()

for ($i = 1; $i -le $ColdStartRuns; $i++) {
    $lines = Invoke-TermRuntime -BundleDir $exampleDir -KillAfterMs $TimeoutMs
    $ms = Get-ElapsedMs -Lines $lines -Phase "first_paint"
    if ($null -ne $ms) {
        $coldStarts += $ms
        Write-Host "  run $i : $ms ms"
    } else {
        Write-Host "  run $i : TIMEOUT or parse error (stderr lines: $($lines.Count))"
    }
    Start-Sleep -Milliseconds 200  # brief cooldown between runs
}

$coldStartMedian = if ($coldStarts.Count -gt 0) {
    $sorted = $coldStarts | Sort-Object
    $mid = [Math]::Floor($sorted.Count / 2)
    if ($sorted.Count % 2 -eq 0) { ($sorted[$mid-1] + $sorted[$mid]) / 2.0 }
    else { $sorted[$mid] }
} else { "N/A" }

$coldStartMin = if ($coldStarts.Count -gt 0) { ($coldStarts | Measure-Object -Minimum).Minimum } else { "N/A" }
$coldStartMax = if ($coldStarts.Count -gt 0) { ($coldStarts | Measure-Object -Maximum).Maximum } else { "N/A" }

Write-Host "  Median: $coldStartMedian ms  Min: $coldStartMin ms  Max: $coldStartMax ms"
Write-Host ""

# ══════════════════════════════════════════════════════════════════════════════
# Benchmark 2: Re-render latency (useInput → repaint)
# ══════════════════════════════════════════════════════════════════════════════
# The runtime logs "phase=first_paint" and "phase=ready". The latency from
# ready → next paint (which happens when useInput fires a state update) is
# approximated by looking at the delta between args_resolved and first_paint.
# Full end-to-end latency from key event to repaint requires instrumentation
# inside the bundle itself; we report what's observable via CARBON_TERM_TIMING.
Write-Host "[bench-term] === Benchmark 2: Re-render latency (startup phases) ==="

$rerenderSamples = @()
for ($i = 1; $i -le 3; $i++) {
    $lines = Invoke-TermRuntime -BundleDir $exampleDir -KillAfterMs $TimeoutMs
    $ready     = Get-ElapsedMs -Lines $lines -Phase "ready"
    $firstPaint = Get-ElapsedMs -Lines $lines -Phase "first_paint"
    if ($null -ne $firstPaint -and $null -ne $ready) {
        $delta = $ready - $firstPaint
        $rerenderSamples += $delta
        Write-Host "  run $i : first_paint=$firstPaint ms  ready=$ready ms  delta=$delta ms"
    } else {
        # Phase names differ from what's logged; log raw timing lines for inspection.
        Write-Host "  run $i : timing phases available:"
        $lines | ForEach-Object { Write-Host "    $_" }
    }
}

$rerenderMedian = if ($rerenderSamples.Count -gt 0) {
    $s = $rerenderSamples | Sort-Object
    $m = [Math]::Floor($s.Count / 2)
    if ($s.Count % 2 -eq 0) { ($s[$m-1] + $s[$m]) / 2.0 } else { $s[$m] }
} else { "N/A (see raw timing above)" }
Write-Host "  Estimated re-render overhead median: $rerenderMedian ms"
Write-Host ""

# ══════════════════════════════════════════════════════════════════════════════
# Benchmark 3: Complex layout perf — build inline JS, compile, time bundle-eval
# ══════════════════════════════════════════════════════════════════════════════
Write-Host "[bench-term] === Benchmark 3: Complex layout (100 boxes, 500 text nodes) ==="

# Create a temporary directory with an inline bundle (no vite build needed).
$tmpDir  = Join-Path $env:TEMP "carbon-bench-complex-$(Get-Random)"
$tmpDist = Join-Path $tmpDir "dist"
New-Item -ItemType Directory -Force -Path $tmpDist | Out-Null

# Generate a self-contained JS bundle that exercises complex layout.
$complexJs = @'
(function(){
  // Minimal stubs matching what the runtime provides.
  // (The real runtime registers __ct_* on globalThis before eval.)
  function cn(id,tag,props){ if(typeof __ct_create_node==="function") __ct_create_node(id,tag,props); }
  function ins(p,c){ if(typeof __ct_insert_node==="function") __ct_insert_node(p,c,-1); }
  function sr(id){ if(typeof __ct_set_root==="function") __ct_set_root(id); }
  function rp(){ if(typeof __ct_request_paint==="function") __ct_request_paint(); }

  var t0 = Date.now();
  var nextId = 1000;
  var ROOT = nextId++;
  cn(ROOT, "Box", '{"flexDirection":"column","padding":1}');
  sr(ROOT);

  // 100 nested Box nodes each containing 5 Text children = 500 text nodes total.
  for (var b = 0; b < 100; b++) {
    var boxId = nextId++;
    cn(boxId, "Box", '{"flexDirection":"row","padding":0}');
    ins(ROOT, boxId);
    for (var t = 0; t < 5; t++) {
      var textId = nextId++;
      cn(textId, "Text", '{"text":"Node ' + b + '-' + t + '"}');
      ins(boxId, textId);
    }
  }
  rp();
  var elapsed = Date.now() - t0;
  console.log("complex-layout-bench: scene_build_ms=" + elapsed);
})();
'@

Set-Content -Path (Join-Path $tmpDist "bundle.js") -Value $complexJs -Encoding UTF8

$complexSamples = @()
for ($i = 1; $i -le 3; $i++) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName               = $runtimeExe
    $psi.Arguments              = "`"$tmpDir`""
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.Environment["CARBON_TERM_TIMING"] = "1"
    $psi.Environment["CARBON_TERM_QUIET"]  = "1"

    $proc = [System.Diagnostics.Process]::Start($psi)
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    Start-Sleep -Milliseconds $TimeoutMs
    if (-not $proc.HasExited) { try { $proc.Kill() } catch {} }
    $proc.WaitForExit(2000) | Out-Null
    $stderr = $stderrTask.GetAwaiter().GetResult()

    $timingLines = $stderr -split "`n" | Where-Object { $_ -match '\[carbon-term-timing\]' }
    $fp = Get-ElapsedMs -Lines $timingLines -Phase "first_paint"
    $be = Get-ElapsedMs -Lines $timingLines -Phase "bundle_evaluated"

    if ($null -ne $fp -and $null -ne $be) {
        $renderMs = $fp - $be
        $complexSamples += $renderMs
        Write-Host "  run $i : bundle_eval=$be ms  first_paint=$fp ms  layout+render=$renderMs ms"
    } else {
        Write-Host "  run $i : could not parse timing (fp=$fp be=$be)"
    }
}

$complexMedian = if ($complexSamples.Count -gt 0) {
    $s = $complexSamples | Sort-Object
    $m = [Math]::Floor($s.Count / 2)
    if ($s.Count % 2 -eq 0) { ($s[$m-1] + $s[$m]) / 2.0 } else { $s[$m] }
} else { "N/A" }

Write-Host "  Complex layout render median: $complexMedian ms"
Write-Host ""

# Cleanup temp dir
Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue

# ══════════════════════════════════════════════════════════════════════════════
# Write docs/TERM_BENCH.md
# ══════════════════════════════════════════════════════════════════════════════
$date      = Get-Date -Format "yyyy-MM-dd HH:mm"
$platform  = [System.Environment]::OSVersion.VersionString
$cpuName   = (Get-WmiObject -Class Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1).Name
if (-not $cpuName) { $cpuName = "unknown" }

$md = @"
# carbon-term Benchmark Results

**Date:** $date
**Platform:** $platform
**CPU:** $cpuName
**Runtime:** ``$runtimeExe``
**Bundle:** ``$bundlePath``

---

## Benchmark 1: Cold Start

Time from process spawn to first ANSI frame on stdout, measured via
``[carbon-term-timing] phase=first_paint`` on stderr (``CARBON_TERM_TIMING=1``).

| Metric | Value |
|--------|-------|
| Runs   | $ColdStartRuns |
| Median | $coldStartMedian ms |
| Min    | $coldStartMin ms |
| Max    | $coldStartMax ms |

Raw samples (ms): $($coldStarts -join ', ')

---

## Benchmark 2: Re-render Latency

The runtime's timing probes measure internal phases (args_resolved →
host_imports_registered → bundle_evaluated → first_paint → ready).
Full end-to-end latency from a key event to the next repaint depends on the
JS event loop tick and Taffy relayout; the table below shows the
``ready - first_paint`` delta as a proxy for post-first-frame overhead.

| Metric | Value |
|--------|-------|
| Estimated overhead (median) | $rerenderMedian ms |

> Note: For precise useInput→repaint latency, instrument the JS bundle with
> ``performance.now()`` around the ``useInput`` callback and ``__ct_request_paint``.

---

## Benchmark 3: Complex Layout

100 nested Box nodes each containing 5 Text children (500 text nodes total).
Measures Taffy layout computation + ANSI painter time per frame.

| Metric | Value |
|--------|-------|
| Nodes  | 600 (100 Box + 500 Text + 1 root) |
| Median render (layout→first_paint) | $complexMedian ms |

Raw samples (ms): $($complexSamples -join ', ')

---

## Notes

- All timings include Rust process startup + QuickJS initialisation.
- The runtime uses ``crossterm`` alt-screen + raw mode; ANSI output goes to
  stdout in a single ``write_all`` per frame (one syscall).
- ``CARBON_TERM_QUIET=1`` suppresses JS ``console.log`` so stderr only contains
  timing lines.
- HMR reload timing is not included here; the ``--dev`` watcher polls at 100 ms
  and the reload itself is a full re-eval of the bundle.

## Known Gaps

- Ink API coverage: ``useFocus`` (multi-component focus manager), ``useStdin``
  (raw byte stream), ``ink-spinner``, ``ink-select-input``, ``ink-text-input``
  are stubbed — see ``packages/carbon-vite-plugin-ink-shim/src/index.js``.
- ``setTimeout``/``setInterval`` are no-op stubs; timer callbacks never fire.
- Mouse events are not surfaced (opt-in crossterm feature, not enabled).
"@

$md | Set-Content -Path $OutputFile -Encoding UTF8
Write-Host "[bench-term] Results written to: $OutputFile"
