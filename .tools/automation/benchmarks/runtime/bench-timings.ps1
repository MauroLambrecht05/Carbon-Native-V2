# Captures per-stage timings from carbon-mini for cold-start profiling.
# Sets CARBON_MINI_TIMING=1 so the binary emits parseable lines on stderr,
# launches it n times, kills it after a short delay, and aggregates the
# measurements per phase (p50, p95, min, max).
#
# Phases emitted by carbon-mini (in order):
#   args_resolved              CLI args parsed, project dir resolved
#   window_built               tao::WindowBuilder::build returned (window hidden)
#   softbuffer_ready           softbuffer Context+Surface created
#   font_preloaded             default font loaded into TextEngine
#   js_runtime_ready           rquickjs Runtime + Context constructed
#   host_imports_registered    __cm_create_node etc. wired into JS globals
#   bundle_read                bundle.qbc.zst (or .js) read from disk
#   bundle_decompressed        lz4 decompress done (only if bytecode toggle on)
#   bundle_evaluated           rquickjs ran the bundle; scene tree built
#   first_paint_before_show    just before ShowWindowAsync / set_visible
#   first_paint_visible        ShowWindowAsync returned (Win32) /
#                              set_visible returned (other platforms).
#                              THE PRIMARY METRIC.
#
# Plus per-paint internals (emit each Event::RedrawRequested, hidden behind
# the same env gate). On Win32 first-paint these fire AFTER first_paint_visible
# because we defer the actual paint to the WM_PAINT after ShowWindowAsync:
#   paint_pixmap_alloc, paint_pixmap_filled, paint_nodes_painted,
#   paint_rgba_converted
#
# Usage:
#   .\bench-timings.ps1 -Exe ...\carbon-mini.exe -ProjectDir ...\examples\mini-counter -N 10

param(
  [Parameter(Mandatory)] [string]$Exe,
  [Parameter(Mandatory)] [string]$ProjectDir,
  [int]$N = 10,
  [int]$KillAfterMs = 1500
)

$results = @()  # array of hashtables: phase -> ms

for ($i = 1; $i -le $N; $i++) {
  $stderrFile = [IO.Path]::GetTempFileName()
  $env:CARBON_MINI_TIMING = "1"
  $proc = Start-Process -PassThru -NoNewWindow -FilePath $Exe `
    -ArgumentList @($ProjectDir) -RedirectStandardError $stderrFile
  Start-Sleep -Milliseconds $KillAfterMs
  try { Stop-Process -Id $proc.Id -Force -EA SilentlyContinue } catch {}
  Start-Sleep -Milliseconds 200

  $iter = @{}
  Get-Content $stderrFile -EA SilentlyContinue | ForEach-Object {
    if ($_ -match 'phase=(\w+) elapsed_ms=([\d.]+)') {
      $iter[$Matches[1]] = [double]$Matches[2]
    }
  }
  Remove-Item $stderrFile -EA SilentlyContinue

  if ($iter.Count -gt 0) {
    $results += ,$iter
    $window = if ($iter.ContainsKey('first_paint_visible')) { "{0:N1}ms" -f $iter['first_paint_visible'] } else { "n/a" }
    Write-Host "[#$i] window-shown @ $window"
  } else {
    Write-Host "[#$i] no timing output captured"
  }
}

if ($results.Count -eq 0) { Write-Host "no data"; exit 1 }

# Collect all phase names in order of first appearance.
$phaseOrder = New-Object System.Collections.ArrayList
foreach ($r in $results) {
  foreach ($k in $r.Keys) {
    if (-not $phaseOrder.Contains($k)) { [void]$phaseOrder.Add($k) }
  }
}

function Percentile($arr, $p) {
  $sorted = $arr | Sort-Object
  $idx = [math]::Floor(($p/100.0) * ($sorted.Count - 1))
  return $sorted[$idx]
}

Write-Host ""
Write-Host ("{0,-30} {1,8} {2,8} {3,8} {4,8}" -f "phase", "p50", "p95", "min", "max")
Write-Host ("{0,-30} {1,8} {2,8} {3,8} {4,8}" -f "-----", "---", "---", "---", "---")

$prev = 0.0
foreach ($phase in $phaseOrder) {
  $vals = @()
  foreach ($r in $results) {
    if ($r.ContainsKey($phase)) { $vals += $r[$phase] }
  }
  if ($vals.Count -eq 0) { continue }
  $p50 = Percentile $vals 50
  $p95 = Percentile $vals 95
  $min = ($vals | Measure-Object -Minimum).Minimum
  $max = ($vals | Measure-Object -Maximum).Maximum
  Write-Host ("{0,-30} {1,8:N2} {2,8:N2} {3,8:N2} {4,8:N2}" -f $phase, $p50, $p95, $min, $max)
}

# Per-stage deltas (how long this phase added vs the previous one), p50.
Write-Host ""
Write-Host ("{0,-30} {1,8}" -f "delta (p50, ms in phase)", "+ms")
Write-Host ("{0,-30} {1,8}" -f "------------------------", "---")
$prev = 0.0
foreach ($phase in $phaseOrder) {
  $vals = @()
  foreach ($r in $results) {
    if ($r.ContainsKey($phase)) { $vals += $r[$phase] }
  }
  if ($vals.Count -eq 0) { continue }
  $p50 = Percentile $vals 50
  $delta = $p50 - $prev
  Write-Host ("{0,-30} {1,8:N2}" -f $phase, $delta)
  $prev = $p50
}
