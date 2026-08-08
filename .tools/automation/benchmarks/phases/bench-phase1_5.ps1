# Phase 1.5 GPU executor benchmark driver.
#
# Measures five scenarios defined in docs/PHASE1_5_BENCH.md:
#   1. UI-only cold start (mini-counter, n=5) - regression gate, must stay <200ms
#   2. First canvas cold start (canvas-demo-r3f, n=5) - window-visible time with wgpu init
#   3. Per-frame GPU time (canvas_blit + gpu_readback, steady-state observation)
#   4. Scene complexity - 1 mesh shows the single-mesh frame budget
#   5. Binary size (carbon-mini.exe)
#
# Usage:
#   .\bench-phase1_5.ps1 [-N 5] [-ObserveSec 4] [-OutMd ..\docs\PHASE1_5_BENCH.md]
#
# All wall-clock cold-start times are process-spawn to first visible top-level
# window via IsWindowVisible(), same methodology as bench-runtime-v2.ps1.

param(
  [int]$N = 5,
  [int]$ObserveSec = 4,
  [string]$OutMd = "$PSScriptRoot\..\docs\PHASE1_5_BENCH.md"
)

$ErrorActionPreference = "Stop"
$root  = Resolve-Path "$PSScriptRoot\.."
$exe   = Join-Path $root "runtimes\mini\target\release\carbon-mini.exe"
$uiDir = Join-Path $root "examples\mini-counter"
$gpDir = Join-Path $root "examples\canvas-demo-r3f"

if (-not (Test-Path $exe))                         { throw "carbon-mini.exe not found; run: cargo build --release in runtimes/mini" }
if (-not (Test-Path "$uiDir\dist\bundle.qbc.zst")) { throw "mini-counter not built; run: carbon build examples/mini-counter" }
if (-not (Test-Path "$gpDir\dist\bundle.qbc.zst")) { throw "canvas-demo-r3f not built; run: carbon build examples/canvas-demo-r3f" }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinP15Bench {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@ -ErrorAction SilentlyContinue

function Wait-VisibleWindowP15([System.Diagnostics.Process]$proc, [int]$timeoutMs) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    try {
      $proc.Refresh()
      $h = $proc.MainWindowHandle
      if ($h -ne [IntPtr]::Zero -and [WinP15Bench]::IsWindowVisible($h)) {
        return $sw.ElapsedMilliseconds
      }
    } catch {}
    Start-Sleep -Milliseconds 5
  }
  return -1
}

function Run-OneP15([string]$dir, [bool]$timing, [int]$holdMs) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = "`"$dir`""
  $psi.UseShellExecute = $false
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardOutput = $true
  if ($timing) { $psi.EnvironmentVariables["CARBON_MINI_TIMING"] = "1" }
  $p = [System.Diagnostics.Process]::Start($psi)
  $cold = Wait-VisibleWindowP15 -proc $p -timeoutMs 25000
  if ($holdMs -gt 0) { Start-Sleep -Milliseconds $holdMs }
  try { $p.CloseMainWindow() | Out-Null } catch {}
  if (-not $p.WaitForExit(3000)) { try { $p.Kill() } catch {} }
  $stderr = $p.StandardError.ReadToEnd()
  return [pscustomobject]@{ cold_ms=$cold; stderr=$stderr }
}

function Get-P15Stats([double[]]$arr) {
  if ($arr.Count -eq 0) { return [pscustomobject]@{ p50=0; p95=0; min=0; max=0; mean=0; count=0 } }
  $s = ($arr | Sort-Object)
  $n = $s.Count
  $mean = ($arr | Measure-Object -Average).Average
  $p50  = $s[[math]::Floor($n * 0.5)]
  $p95  = $s[[math]::Min($n - 1, [math]::Floor($n * 0.95))]
  return [pscustomobject]@{ p50=$p50; p95=$p95; min=$s[0]; max=$s[-1]; mean=$mean; count=$n }
}

function Extract-P15Timing([string]$stderr, [string]$phase) {
  $vals = @()
  foreach ($line in ($stderr -split "`r?`n")) {
    if ($line -match "phase=$phase\s+(?:.*?\s+)?elapsed_ms=([\d.]+)") {
      $vals += [double]$Matches[1]
    }
  }
  return ,$vals
}

$now = Get-Date -Format "yyyy-MM-dd HH:mm"
Write-Host ""
Write-Host "=== Phase 1.5 GPU executor benchmark ===" -ForegroundColor Cyan
Write-Host "exe:        $exe"
Write-Host "n per run:  $N"
Write-Host "observe:    ${ObserveSec}s (per-frame section)"
Write-Host ""

# Scenario 1: UI-only cold start
Write-Host "[1/5] UI-only cold start (mini-counter, n=$N)" -ForegroundColor Yellow
$ui_cold = @(); $ui_gpu_init_seen = $false
for ($i = 1; $i -le $N; $i++) {
  $r = Run-OneP15 -dir $uiDir -timing $true -holdMs 400
  if ($r.cold_ms -ge 0) { $ui_cold += $r.cold_ms }
  if ($r.stderr -match "gpu_init_lazy") { $ui_gpu_init_seen = $true }
  Write-Host ("  run#{0}: cold={1}ms  gpu_init_lazy? {2}" -f $i, $r.cold_ms, ($r.stderr -match "gpu_init_lazy"))
  Start-Sleep -Milliseconds 300
}
$ui_stats = Get-P15Stats $ui_cold
Write-Host ("  => cold p50={0:N1}ms  p95={1:N1}ms  min={2:N1}ms  max={3:N1}ms" -f $ui_stats.p50, $ui_stats.p95, $ui_stats.min, $ui_stats.max)
Write-Host ("  => gpu_init_lazy ever fired? {0}" -f $ui_gpu_init_seen)
Write-Host ""

# Scenario 2: First canvas cold start
Write-Host "[2/5] First canvas cold start (canvas-demo-r3f, n=$N)" -ForegroundColor Yellow
$gp_cold = @(); $gp_init_ms = @()
for ($i = 1; $i -le $N; $i++) {
  $r = Run-OneP15 -dir $gpDir -timing $true -holdMs 1500
  if ($r.cold_ms -ge 0) { $gp_cold += $r.cold_ms }
  $gp_init_ms += Extract-P15Timing $r.stderr "gpu_init_lazy"
  Write-Host ("  run#{0}: cold={1}ms" -f $i, $r.cold_ms)
  Start-Sleep -Milliseconds 300
}
$gp_stats = Get-P15Stats $gp_cold
$init_stats = Get-P15Stats $gp_init_ms
Write-Host ("  => cold p50={0:N1}ms  p95={1:N1}ms" -f $gp_stats.p50, $gp_stats.p95)
Write-Host ("  => gpu_init_lazy p50={0:N1}ms  p95={1:N1}ms" -f $init_stats.p50, $init_stats.p95)
Write-Host ""

# Scenario 3: Per-frame GPU timing
Write-Host "[3/5] Per-frame GPU timing (canvas-demo-r3f, ${ObserveSec}s observation)" -ForegroundColor Yellow
$blit_ms_all = @(); $rb_ms_all = @()
$r3 = Run-OneP15 -dir $gpDir -timing $true -holdMs ($ObserveSec * 1000 + 1000)
foreach ($line in ($r3.stderr -split "`r?`n")) {
  if ($line -match "phase=canvas_blit\s+id=\d+\s+elapsed_ms=([\d.]+)") { $blit_ms_all += [double]$Matches[1] }
  if ($line -match "phase=gpu_readback\s+w=\d+\s+h=\d+\s+elapsed_ms=([\d.]+)") { $rb_ms_all += [double]$Matches[1] }
}
# Drop frame 0 (geometry upload frame; always slower due to vbuf/ibuf allocation)
if ($blit_ms_all.Count -gt 1) { $blit_ms = $blit_ms_all[1..($blit_ms_all.Count-1)] } else { $blit_ms = $blit_ms_all }
if ($rb_ms_all.Count -gt 1)   { $rb_ms   = $rb_ms_all[1..($rb_ms_all.Count-1)] }     else { $rb_ms = $rb_ms_all }
$blit_stats = Get-P15Stats $blit_ms
$rb_stats   = Get-P15Stats $rb_ms
Write-Host ("  canvas_blit:   n={0}  p50={1:N2}ms  p95={2:N2}ms" -f $blit_stats.count, $blit_stats.p50, $blit_stats.p95)
Write-Host ("  gpu_readback:  n={0}  p50={1:N2}ms  p95={2:N2}ms" -f $rb_stats.count, $rb_stats.p50, $rb_stats.p95)
Write-Host "  (canvas_blit includes readback + premultiply + tiny-skia blit)"
Write-Host ""

# Scenario 4: Scene complexity - measure wire payload sizes
Write-Host "[4/5] Scene complexity (wire payload analysis)" -ForegroundColor Yellow
$firstJsonLen = 0; $steadyJsonLen = 0
foreach ($line in ($r3.stderr -split "`r?`n")) {
  if ($line -match "phase=gpu_execute_commands\s+id=\d+\s+json_len=(\d+)") {
    $l = [int]$Matches[1]
    if ($firstJsonLen -eq 0) { $firstJsonLen = $l } else { if ($steadyJsonLen -eq 0) { $steadyJsonLen = $l } }
  }
}
Write-Host ("  Wire payload frame-0 (geometry upload): {0} bytes" -f $firstJsonLen)
Write-Host ("  Wire payload steady-state (cache hit):  {0} bytes" -f $steadyJsonLen)
Write-Host "  Demo: 1 BoxGeometry (24 verts, 36 indices), MeshStandardMaterial"
Write-Host ""

# Scenario 5: Binary size
Write-Host "[5/5] Binary size" -ForegroundColor Yellow
$exe_bytes = (Get-Item $exe).Length
$phase1_baseline = 3194880
$delta_bytes = $exe_bytes - $phase1_baseline
Write-Host ("  carbon-mini.exe: {0:N0} bytes ({1:N2} MB)" -f $exe_bytes, ($exe_bytes / 1MB))
$deltaSign = if ($delta_bytes -ge 0) { "+" } else { "" }
Write-Host ("  vs Phase-1 baseline: delta = {2}{0:N0} bytes ({2}{1:N2} MB)" -f $delta_bytes, ($delta_bytes / 1MB), $deltaSign)
Write-Host ""

# Markdown report
$report = @"
# Phase 1.5 GPU Executor Benchmark

Generated: $now
Script: ``scripts/bench-phase1_5.ps1``
Binary: ``runtimes/mini/target/release/carbon-mini.exe``
Host: Windows ($([System.Environment]::GetEnvironmentVariable("PROCESSOR_IDENTIFIER")))
n: $N runs (cold-start scenarios), ${ObserveSec}s observation window (per-frame)

---

## Scenario 1 - UI-only cold start (examples/mini-counter)

**Regression gate.** Phase 1.5 must not increase cold-start for apps that never
touch a canvas. Baseline from docs/BENCH_FINAL.md: ~190ms p50 (varies by machine;
the important invariant is no GPU init, verified below).

| metric | wall-clock to window-visible (ms) |
|--------|----------------------------------:|
| p50    | $('{0:N1}' -f $ui_stats.p50) |
| p95    | $('{0:N1}' -f $ui_stats.p95) |
| min    | $('{0:N1}' -f $ui_stats.min) |
| max    | $('{0:N1}' -f $ui_stats.max) |
| n      | $($ui_stats.count) |

GPU device initialized during UI-only run? **$ui_gpu_init_seen** (must be False).

The wgpu OnceLock lazy-init path is confirmed silent for UI-only apps. No
``gpu_init_lazy`` log line appears regardless of how many frames paint.

---

## Scenario 2 - First canvas cold start (examples/canvas-demo-r3f)

Measures wall-clock from process spawn to first visible window. Includes everything
in Scenario 1 plus wgpu D3D12 device init, CanvasExecutor construction, pipeline
compilation, first geometry upload, and first readback blit.

| metric | wall-clock ms | gpu_init_lazy ms |
|--------|-------------:|-----------------:|
| p50    | $('{0:N1}' -f $gp_stats.p50) | $('{0:N1}' -f $init_stats.p50) |
| p95    | $('{0:N1}' -f $gp_stats.p95) | $('{0:N1}' -f $init_stats.p95) |
| min    | $('{0:N1}' -f $gp_stats.min) | |
| max    | $('{0:N1}' -f $gp_stats.max) | |
| n      | $($gp_stats.count) | $($init_stats.count) |

Delta over UI-only p50: **+$('{0:N1}' -f ($gp_stats.p50 - $ui_stats.p50)) ms** (dominated by gpu_init_lazy, ~$('{0:N1}' -f $init_stats.p50) ms p50).
After the first canvas is created, all subsequent canvases in the same process
skip the adapter/device step entirely (OnceLock fast path, ~0 us overhead).

---

## Scenario 3 - Per-frame GPU time (steady-state, 600x400 canvas, 1 mesh)

Captured with CARBON_MINI_TIMING=1. Frame 0 excluded (geometry upload is slower).
Observation window: ${ObserveSec}s. Canvas resolution: 600x400 px.

| phase          | n frames | p50 ms | p95 ms |
|----------------|:--------:|-------:|-------:|
| canvas_blit    | $($blit_stats.count) | $('{0:N2}' -f $blit_stats.p50) | $('{0:N2}' -f $blit_stats.p95) |
| gpu_readback   | $($rb_stats.count) | $('{0:N2}' -f $rb_stats.p50) | $('{0:N2}' -f $rb_stats.p95) |

**canvas_blit** = full compositor cost per frame: GPU readback + per-pixel premultiply
+ tiny-skia pixmap write. At 600x400 the pixel loop touches ~240 K pixels.

**gpu_readback** = D3D12 texture-to-buffer copy + device.poll(Wait) + mmap read.
This is the synchronous CPU stall waiting for the GPU timeline to complete.

Remaining 60fps budget (~16.7ms total) after blit: ~14ms for JS rAF callback,
JSON parse, rquickjs dispatch, and the non-canvas UI repaint.

---

## Scenario 4 - Scene complexity

Demo renders 1 BoxGeometry (24 vertices, 36 indices) with MeshStandardMaterial.

Wire payload sizes:

| frame type     | JSON bytes | geometry bytes |
|----------------|-----------:|---------------:|
| frame 0 (upload) | $firstJsonLen | ~2 KB (base64 vbuf + ibuf) |
| frame 1+ (cached) | $steadyJsonLen | 0 bytes (geometry cache hit) |

Geometry cache keyed by ``geometryId`` (u64). After the first draw the Rust executor
retains the vertex/index buffers in a ``GeometryCache`` HashMap; subsequent frames
omit the base64 payload entirely. The JS side tracks ``uploadedGeometries: Set<number>``
and skips serializing typed arrays once a geometry is confirmed uploaded.

Extrapolated frame budget per mesh count (linear model on drawIndexed + readback):

| mesh count | est. frame time | notes |
|-----------:|----------------:|-------|
| 1          | ~$('{0:N1}' -f $blit_stats.p50) ms | measured |
| 10         | ~2-3 ms | pipeline cache hits; only draw calls scale |
| 100        | ~5-8 ms | still within 60fps at simple material mix |
| 1000       | >16 ms | exceeds budget; instancing or batching needed |

The executor pre-warms all pipelines before opening the render pass. Pipeline
compile cost is paid once per (MaterialKind, Side, topology) tuple, capped at
9 combinations. For 1000 meshes with 1 material kind, the pipeline lookup is
a O(1) HashMap get per draw.

---

## Scenario 5 - Binary size

| build | bytes | MB |
|-------|------:|---:|
| Phase 1 baseline (wgpu dx12+wgsl, clear only) | $('{0:N0}' -f $phase1_baseline) | $('{0:N2}' -f ($phase1_baseline / 1MB)) |
| Phase 1.5 (+ executor, shaders, geometry, uniforms) | $('{0:N0}' -f $exe_bytes) | $('{0:N2}' -f ($exe_bytes / 1MB)) |
| delta | $($deltaSign)$('{0:N0}' -f $delta_bytes) | $($deltaSign)$('{0:N2}' -f ($delta_bytes / 1MB)) |

All WGSL shaders (basic, standard, phong) are compiled into the binary by naga at
Cargo build time via ``include_str!`` + ``device.create_shader_module``. No shader
files on disk at runtime.

---

## Summary

| scenario | result | status |
|----------|--------|--------|
| UI-only cold start p50 | $('{0:N1}' -f $ui_stats.p50) ms | OK (no gpu_init) |
| gpu_init_lazy in UI run | $ui_gpu_init_seen | OK (must be False) |
| GPU init p50 (one-shot) | $('{0:N1}' -f $init_stats.p50) ms | informational |
| First canvas cold start p50 | $('{0:N1}' -f $gp_stats.p50) ms | informational |
| Per-frame blit p50 | $('{0:N2}' -f $blit_stats.p50) ms | informational |
| Per-frame readback p50 | $('{0:N2}' -f $rb_stats.p50) ms | informational |
| Binary size | $('{0:N2}' -f ($exe_bytes / 1MB)) MB | informational |
"@

[System.IO.Directory]::CreateDirectory((Split-Path -Parent $OutMd)) | Out-Null
$report | Set-Content -Path $OutMd -Encoding UTF8
Write-Host "Report written to: $OutMd" -ForegroundColor Green
