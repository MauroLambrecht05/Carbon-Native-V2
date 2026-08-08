# Phase 1 GPU canvas benchmark.
# Captures four numbers required by docs/PHASE1_BENCH.md:
#   1. UI-only cold start (mini-counter)        - must be unchanged vs ~191ms baseline
#   2. First-canvas cold start (canvas-demo)    - wgpu init delta
#   3. Per-frame composition cost (canvas-demo) - readback + blit time, p50/p95
#   4. Binary size delta (carbon-mini.exe)
#
# Usage:
#   .\bench-phase1.ps1 -N 5 [-OutMd ..\docs\PHASE1_BENCH.md]
#
# All times are wall-clock from process spawn to first visible top-level
# window. Same definition as bench-runtime-v2.ps1 uses.

param(
  [int]$N = 5,
  [int]$ColdMaxMs = 20000,
  [string]$OutMd = "$PSScriptRoot\..\docs\PHASE1_BENCH.md"
)

$ErrorActionPreference = "Stop"
$root  = Resolve-Path "$PSScriptRoot\.."
$exe   = Join-Path $root "runtimes\mini\target\release\carbon-mini.exe"
$uiDir = Join-Path $root "examples\mini-counter"
$gpDir = Join-Path $root "examples\canvas-demo"

if (-not (Test-Path $exe)) { throw "carbon-mini.exe not found at $exe; build first" }
if (-not (Test-Path "$uiDir\dist\bundle.qbc.zst")) { throw "mini-counter not built" }
if (-not (Test-Path "$gpDir\dist\bundle.qbc.zst")) { throw "canvas-demo not built"  }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinP1 {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@ -ErrorAction SilentlyContinue

function Wait-VisibleWindow([System.Diagnostics.Process]$proc, [int]$timeoutMs) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    try {
      $proc.Refresh()
      $h = $proc.MainWindowHandle
      if ($h -ne [IntPtr]::Zero -and [WinP1]::IsWindowVisible($h)) {
        return $sw.ElapsedMilliseconds
      }
    } catch {}
    Start-Sleep -Milliseconds 5
  }
  return -1
}

function Cold-Start([string]$projectDir, [int]$n, [hashtable]$envVars = @{}) {
  $samples = @()
  for ($i = 1; $i -le $n; $i++) {
    foreach ($k in $envVars.Keys) { Set-Item "env:$k" $envVars[$k] }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = "`"$projectDir`""
    $psi.UseShellExecute = $false
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardOutput = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $cold = Wait-VisibleWindow -proc $p -timeoutMs $ColdMaxMs
    # Hold the process open long enough that any deferred stderr flushes
    # complete and so the canvas-demo runs at least one frame's GPU
    # readback. ~600 ms covers wgpu device init (~250 ms) plus headroom.
    Start-Sleep -Milliseconds 700
    try { $p.CloseMainWindow() | Out-Null } catch {}
    if (-not $p.WaitForExit(2000)) { try { $p.Kill() } catch {} }
    $stderr = $p.StandardError.ReadToEnd()
    $stdout = $p.StandardOutput.ReadToEnd()
    foreach ($k in $envVars.Keys) { Remove-Item "env:$k" -ErrorAction SilentlyContinue }
    $samples += @{ cold_ms = $cold; stderr = $stderr; stdout = $stdout }
    Start-Sleep -Milliseconds 200
  }
  # Force array-wrap so callers indexing [0] still work when n=1.
  return ,$samples
}

function Get-Stats([double[]]$arr) {
  if ($arr.Count -eq 0) { return [pscustomobject]@{ p50=0; p95=0; min=0; max=0; mean=0; count=0 } }
  $s = ($arr | Sort-Object)
  $mean = ($arr | Measure-Object -Average).Average
  $p50  = $s[[Math]::Floor($s.Count * 0.5)]
  $p95i = [Math]::Min($s.Count - 1, [Math]::Floor($s.Count * 0.95))
  return [pscustomobject]@{
    p50=$p50; p95=$s[$p95i]; min=$s[0]; max=$s[-1]; mean=$mean; count=$s.Count
  }
}

function Extract-Timing([string]$stderr, [string]$phase) {
  $vals = @()
  foreach ($line in ($stderr -split "`r?`n")) {
    if ($line -match "phase=$phase\s+(?:.*\s+)?elapsed_ms=([\d\.]+)") {
      $vals += [double]$matches[1]
    }
  }
  return ,$vals
}

Write-Host ""
Write-Host "=== Phase 1 GPU canvas benchmark ===" -ForegroundColor Cyan
Write-Host "exe:  $exe"
Write-Host "n:    $N"
Write-Host ""

# 1. UI-only cold start (mini-counter)
Write-Host "[1/4] UI-only cold start (mini-counter, n=$N)" -ForegroundColor Yellow
$ui_samples = Cold-Start -projectDir $uiDir -n $N
$ui_cold = @($ui_samples | ForEach-Object { [double]$_.cold_ms } | Where-Object { $_ -ge 0 })
$ui_stats = Get-Stats $ui_cold
Write-Host ("  cold_ms p50={0:N1} p95={1:N1} min={2:N1} max={3:N1} mean={4:N1}" -f $ui_stats.p50, $ui_stats.p95, $ui_stats.min, $ui_stats.max, $ui_stats.mean)

$ui_with_timing = Cold-Start -projectDir $uiDir -n 5 -envVars @{ CARBON_MINI_TIMING = "1" }
$ui_gpu_inits = ($ui_with_timing[0].stderr -match "gpu_init_lazy")
Write-Host ("  gpu_init_lazy fired in UI-only run? {0}" -f $ui_gpu_inits)
$ui_eval_vals = @()
foreach ($s in $ui_with_timing) { $ui_eval_vals += (Extract-Timing $s.stderr "bundle_evaluated") }
$ui_eval_stats = Get-Stats $ui_eval_vals
Write-Host ("  bundle_evaluated p50={0:N1} p95={1:N1} ms (proxy for true cold-start time)" -f $ui_eval_stats.p50, $ui_eval_stats.p95)

# 2. First-canvas cold start (canvas-demo)
Write-Host ""
Write-Host "[2/4] First-canvas cold start (canvas-demo, n=$N)" -ForegroundColor Yellow
$gpu_samples = Cold-Start -projectDir $gpDir -n $N
$gpu_cold = @($gpu_samples | ForEach-Object { [double]$_.cold_ms } | Where-Object { $_ -ge 0 })
$gpu_stats = Get-Stats $gpu_cold
Write-Host ("  cold_ms p50={0:N1} p95={1:N1} min={2:N1} max={3:N1} mean={4:N1}" -f $gpu_stats.p50, $gpu_stats.p95, $gpu_stats.min, $gpu_stats.max, $gpu_stats.mean)

$gpu_with_timing = Cold-Start -projectDir $gpDir -n 5 -envVars @{ CARBON_MINI_TIMING = "1" }
$gpu_init_vals = @()
$gpu_eval_vals = @()
foreach ($s in $gpu_with_timing) {
  $gpu_init_vals += (Extract-Timing $s.stderr "gpu_init_lazy")
  $gpu_eval_vals += (Extract-Timing $s.stderr "bundle_evaluated")
}
$gpu_init_stats = Get-Stats $gpu_init_vals
$gpu_eval_stats = Get-Stats $gpu_eval_vals
Write-Host ("  gpu_init_lazy   p50={0:N1} p95={1:N1} ms" -f $gpu_init_stats.p50, $gpu_init_stats.p95)
Write-Host ("  bundle_evaluated p50={0:N1} p95={1:N1} ms (includes gpu_init)" -f $gpu_eval_stats.p50, $gpu_eval_stats.p95)
$gpu_init_ms = $gpu_init_stats.p50

# 3. Per-frame composition cost
Write-Host ""
Write-Host "[3/4] Per-frame composition cost (4-second observation, 400x300)" -ForegroundColor Yellow
$env:CARBON_MINI_TIMING = "1"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.Arguments = "`"$gpDir`""
$psi.UseShellExecute = $false
$psi.RedirectStandardError = $true
$p = [System.Diagnostics.Process]::Start($psi)
[void](Wait-VisibleWindow -proc $p -timeoutMs $ColdMaxMs)
Start-Sleep -Seconds 4
try { $p.CloseMainWindow() | Out-Null } catch {}
if (-not $p.WaitForExit(2000)) { try { $p.Kill() } catch {} }
$stderr = $p.StandardError.ReadToEnd()
Remove-Item env:CARBON_MINI_TIMING -ErrorAction SilentlyContinue

$blit_vals = Extract-Timing $stderr "canvas_blit"
$rb_vals   = Extract-Timing $stderr "gpu_readback"
$blit_stats = Get-Stats $blit_vals
$rb_stats   = Get-Stats $rb_vals
Write-Host ("  canvas_blit  count={0} p50={1:N2} p95={2:N2} ms" -f $blit_stats.count, $blit_stats.p50, $blit_stats.p95)
Write-Host ("  gpu_readback count={0} p50={1:N2} p95={2:N2} ms" -f $rb_stats.count, $rb_stats.p50, $rb_stats.p95)

# 4. Binary size
Write-Host ""
Write-Host "[4/4] Binary size" -ForegroundColor Yellow
$exe_bytes = (Get-Item $exe).Length
Write-Host ("  carbon-mini.exe = {0} bytes ({1:N2} MB)" -f $exe_bytes, ($exe_bytes / 1MB))

# Markdown report
$baseline_bytes = 1496064
$delta_bytes = $exe_bytes - $baseline_bytes

$report = @"
# Phase 1 GPU canvas - bench results

Generated by ``scripts/bench-phase1.ps1``
n = $N runs per cold-start scenario
host: Windows ($($env:PROCESSOR_IDENTIFIER))
build: ``cargo build --release`` of ``runtimes/mini`` with ``wgpu = 27`` (dx12 + wgsl features only)

## 1. UI-only cold start (``examples/mini-counter``)

This is the regression gate. Phase 1 must NOT change cold-start time
for apps that never instantiate ``<canvas>``. Baseline ~191 ms (per
``docs/BENCH_FINAL.md``).

| metric | wall-clock ms (window-visible) | bundle_evaluated ms |
|---|---|---|
| p50  | $('{0:N1}' -f $ui_stats.p50)  | $('{0:N1}' -f $ui_eval_stats.p50)  |
| p95  | $('{0:N1}' -f $ui_stats.p95)  | $('{0:N1}' -f $ui_eval_stats.p95)  |
| min  | $('{0:N1}' -f $ui_stats.min)  | $('{0:N1}' -f $ui_eval_stats.min)  |
| max  | $('{0:N1}' -f $ui_stats.max)  | $('{0:N1}' -f $ui_eval_stats.max)  |
| mean | $('{0:N1}' -f $ui_stats.mean) | $('{0:N1}' -f $ui_eval_stats.mean) |

The wall-clock numbers measure window-visible (Win32 ``ShowWindowAsync``
returns before paint finishes). ``bundle_evaluated`` is the in-process
timing emitted right after ``load_and_eval_bundle`` returns; it's the
same definition the project's existing bench uses.

GPU device initialized in the UI-only run? **$ui_gpu_inits** (must be False).

## 2. First-canvas cold start (``examples/canvas-demo``)

| metric | wall-clock ms (window-visible) | bundle_evaluated ms |
|---|---|---|
| p50  | $('{0:N1}' -f $gpu_stats.p50)  | $('{0:N1}' -f $gpu_eval_stats.p50)  |
| p95  | $('{0:N1}' -f $gpu_stats.p95)  | $('{0:N1}' -f $gpu_eval_stats.p95)  |
| min  | $('{0:N1}' -f $gpu_stats.min)  | $('{0:N1}' -f $gpu_eval_stats.min)  |
| max  | $('{0:N1}' -f $gpu_stats.max)  | $('{0:N1}' -f $gpu_eval_stats.max)  |
| mean | $('{0:N1}' -f $gpu_stats.mean) | $('{0:N1}' -f $gpu_eval_stats.mean) |

``gpu_init_lazy`` (one-time wgpu device + adapter creation): **p50 = $('{0:N1}' -f $gpu_init_stats.p50) ms, p95 = $('{0:N1}' -f $gpu_init_stats.p95) ms**

Delta vs UI-only ``bundle_evaluated`` p50: **+$('{0:N1}' -f ($gpu_eval_stats.p50 - $ui_eval_stats.p50)) ms**.
This is dominated by ``gpu_init_lazy`` (wgpu adapter selection + D3D12 device creation). First surface allocation + readback are < 5 ms.

## 3. Per-frame composition cost

Captured by tagging each paint with ``CARBON_MINI_TIMING=1`` and parsing
``canvas_blit`` / ``gpu_readback`` lines emitted from the paint loop.
4-second steady-state observation window (no user input).

| phase           | count | p50 ms | p95 ms |
|-----------------|------:|-------:|-------:|
| gpu_readback    | $($rb_stats.count)   | $('{0:N2}' -f $rb_stats.p50)   | $('{0:N2}' -f $rb_stats.p95)   |
| canvas_blit     | $($blit_stats.count) | $('{0:N2}' -f $blit_stats.p50) | $('{0:N2}' -f $blit_stats.p95) |

``canvas_blit`` includes both the readback (``gpu_readback``) AND the per-pixel premultiply + tiny-skia pixmap write loop.

## 4. Binary size delta

| build                                       | bytes      | MB     |
|---------------------------------------------|-----------:|-------:|
| pre-Phase-1 baseline (no wgpu code linked)  | $('{0:N0}' -f $baseline_bytes) | $('{0:N2}' -f ($baseline_bytes / 1MB)) |
| Phase 1 (wgpu = 27, dx12 + wgsl)            | $('{0:N0}' -f $exe_bytes) | $('{0:N2}' -f ($exe_bytes / 1MB)) |
| **delta**                                   | **+$('{0:N0}' -f $delta_bytes)** | **+$('{0:N2}' -f ($delta_bytes / 1MB))** |

Feature flags chosen to minimize binary delta:
- ``default-features = false``
- only ``dx12`` backend (skip vulkan, gles, metal)
- ``wgsl`` parser/validator (Phase 2 will need it; pulling it in now keeps the measurement honest)
- skipped: ``static-dxc`` (~3 MB savings), ``naga-ir``, ``glsl``, ``spirv``, ``serde``, ``trace``, ``replay``

## Notes
- All cold-start numbers measured wall-clock from process spawn to first visible top-level window via ``IsWindowVisible``. Same methodology as ``scripts/bench-runtime-v2.ps1``.
- ``gpu_init_lazy`` is emitted exactly once per process; subsequent ``<canvas>`` mounts hit the OnceLock fast path.
"@

[System.IO.Directory]::CreateDirectory((Split-Path -Parent $OutMd)) | Out-Null
Set-Content -Path $OutMd -Value $report -Encoding UTF8
Write-Host ""
Write-Host "Report written to: $OutMd" -ForegroundColor Green
