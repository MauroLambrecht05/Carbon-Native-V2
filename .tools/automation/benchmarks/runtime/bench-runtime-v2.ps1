# Cross-stack runtime benchmark v2.
# Adds: warm start, idle CPU%, peak RSS, 30-sec active sample.
# Usage:
#   .\bench-runtime-v2.ps1 -Name carbon-mini -Exe ..\runtimes\mini\target\release\carbon-mini.exe -N 5
param(
  [Parameter(Mandatory)] [string]$Name,
  [Parameter(Mandatory)] [string]$Exe,
  [string[]]$ExeArgs = @(),
  [int]$N = 5,
  [int]$IdleMs = 3000,
  [int]$ColdMaxMs = 20000,
  [string]$Cwd = "",
  [int]$ObserveMs = 30000,    # observation window in ms (cpu/peak rss)
  [string]$OutJson = ""
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@ -ErrorAction SilentlyContinue

function Get-DescendantPids([int]$rootPid) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name
  $byParent = @{}
  foreach ($p in $all) {
    if (-not $byParent.ContainsKey([int]$p.ParentProcessId)) { $byParent[[int]$p.ParentProcessId] = @() }
    $byParent[[int]$p.ParentProcessId] += $p
  }
  $result = New-Object System.Collections.Generic.List[psobject]
  $stack = New-Object System.Collections.Generic.Stack[int]
  $stack.Push($rootPid)
  $seen = @{}
  while ($stack.Count -gt 0) {
    $cur = $stack.Pop()
    if ($seen.ContainsKey($cur)) { continue }
    $seen[$cur] = $true
    if ($byParent.ContainsKey($cur)) {
      foreach ($child in $byParent[$cur]) {
        $result.Add($child)
        $stack.Push([int]$child.ProcessId)
      }
    }
  }
  return $result
}

function Wait-WindowReady([int]$rootPid, [int]$timeoutMs) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    $tree = Get-DescendantPids -rootPid $rootPid
    $treePids = @($rootPid) + ($tree | ForEach-Object { [int]$_.ProcessId })
    foreach ($id in $treePids) {
      try {
        $p = Get-Process -Id $id -ErrorAction Stop
        $h = $p.MainWindowHandle
        if ($h -ne [IntPtr]::Zero) {
          if ([Win]::IsWindowVisible($h)) {
            return $sw.ElapsedMilliseconds
          }
        }
      } catch {}
    }
    Start-Sleep -Milliseconds 5
  }
  return -1
}

function Snapshot-Tree([int]$rootPid) {
  $tree = Get-DescendantPids -rootPid $rootPid
  $hostRSS = 0; $childRSS = 0; $hostPriv = 0; $childPriv = 0
  $childCount = 0; $hostCpu = 0.0; $childCpu = 0.0
  try {
    $h = Get-Process -Id $rootPid -ErrorAction Stop
    $hostRSS  = $h.WorkingSet64
    $hostPriv = $h.PrivateMemorySize64
    $hostCpu  = $h.TotalProcessorTime.TotalSeconds
  } catch {}
  foreach ($c in $tree) {
    try {
      $cp = Get-Process -Id ([int]$c.ProcessId) -ErrorAction Stop
      $childRSS  += $cp.WorkingSet64
      $childPriv += $cp.PrivateMemorySize64
      $childCpu  += $cp.TotalProcessorTime.TotalSeconds
      $childCount++
    } catch {}
  }
  return [pscustomobject]@{
    host_rss=$hostRSS; child_rss=$childRSS; total_rss=($hostRSS+$childRSS)
    host_priv=$hostPriv; child_priv=$childPriv; total_priv=($hostPriv+$childPriv)
    cpu_seconds=($hostCpu+$childCpu)
    child_count=$childCount
  }
}

function Start-App {
  param([string]$exe, [string[]]$exeArgs, [string]$cwd)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $argLine = ($exeArgs | ForEach-Object {
    if ($_ -match '\s') { '"' + $_.Replace('"', '\"') + '"' } else { $_ }
  }) -join ' '
  $psi.Arguments = $argLine
  if ($cwd) { $psi.WorkingDirectory = $cwd }
  $psi.UseShellExecute = $false
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $proc = [System.Diagnostics.Process]::Start($psi)
  $coldMs = Wait-WindowReady -rootPid $proc.Id -timeoutMs $ColdMaxMs
  $sw.Stop()
  return @{ proc = $proc; cold_ms = $coldMs }
}

function Stop-App([System.Diagnostics.Process]$proc) {
  $tree = Get-DescendantPids -rootPid $proc.Id
  try { $proc.CloseMainWindow() | Out-Null } catch {}
  Start-Sleep -Milliseconds 200
  try {
    foreach ($c in $tree) { try { Stop-Process -Id ([int]$c.ProcessId) -Force -ErrorAction SilentlyContinue } catch {} }
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  } catch {}
  Start-Sleep -Milliseconds 300
}

function Measure-Iter([string]$exe, [string[]]$exeArgs, [string]$cwd, [int]$iter) {
  # Cold launch
  $a = Start-App -exe $exe -exeArgs $exeArgs -cwd $cwd
  $coldMs = $a.cold_ms
  if ($coldMs -lt 0) {
    Stop-App $a.proc
    return $null
  }

  # Settle
  Start-Sleep -Milliseconds $IdleMs

  # Idle sample 1
  $s1 = Snapshot-Tree -rootPid $a.proc.Id
  $cpuSecBaseline = $s1.cpu_seconds

  # Observation window — sample every 500ms, accumulate CPU + peak RSS + peak Priv
  $peakRss = $s1.total_rss
  $peakPriv = $s1.total_priv
  $samples = New-Object System.Collections.Generic.List[psobject]
  $obsSw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($obsSw.ElapsedMilliseconds -lt $ObserveMs) {
    Start-Sleep -Milliseconds 500
    $s = Snapshot-Tree -rootPid $a.proc.Id
    if ($s.total_rss -gt $peakRss)   { $peakRss  = $s.total_rss }
    if ($s.total_priv -gt $peakPriv) { $peakPriv = $s.total_priv }
    $samples.Add($s)
  }
  $obsSw.Stop()
  $cpuSecEnd = if ($samples.Count -gt 0) { $samples[$samples.Count - 1].cpu_seconds } else { $cpuSecBaseline }
  $totalCpu = $cpuSecEnd - $cpuSecBaseline
  $cores = [Environment]::ProcessorCount
  $idleCpuPct = if ($cores -gt 0 -and $obsSw.ElapsedMilliseconds -gt 0) {
    100.0 * $totalCpu / ($cores * ($obsSw.ElapsedMilliseconds / 1000.0))
  } else { 0.0 }

  # Final sample
  $sFinal = Snapshot-Tree -rootPid $a.proc.Id

  # Tear down
  Stop-App $a.proc

  # Warm launch — same binary, immediately after kill
  Start-Sleep -Milliseconds 500
  $aw = Start-App -exe $exe -exeArgs $exeArgs -cwd $cwd
  $warmMs = $aw.cold_ms
  Start-Sleep -Milliseconds 500
  Stop-App $aw.proc

  return [pscustomobject]@{
    iter           = $iter
    cold_ms        = $coldMs
    warm_ms        = $warmMs
    host_rss_mb    = [math]::Round($s1.host_rss / 1MB, 2)
    child_rss_mb   = [math]::Round($s1.child_rss / 1MB, 2)
    total_rss_mb   = [math]::Round($s1.total_rss / 1MB, 2)
    final_rss_mb   = [math]::Round($sFinal.total_rss / 1MB, 2)
    peak_rss_mb    = [math]::Round($peakRss / 1MB, 2)
    peak_priv_mb   = [math]::Round($peakPriv / 1MB, 2)
    child_count    = $s1.child_count
    idle_cpu_pct   = [math]::Round($idleCpuPct, 3)
  }
}

function Percentile([double[]]$arr, [double]$p) {
  $sorted = $arr | Sort-Object
  $n = $sorted.Count
  if ($n -eq 0) { return 0 }
  $idx = [math]::Floor(($p / 100.0) * ($n - 1))
  return $sorted[$idx]
}

$results = New-Object System.Collections.Generic.List[psobject]
for ($i = 0; $i -lt $N; $i++) {
  $r = Measure-Iter -exe $Exe -exeArgs $ExeArgs -cwd $Cwd -iter ($i+1)
  if ($null -eq $r) {
    Write-Host ("[{0}#{1}] FAILED - window not ready in {2}ms" -f $Name, ($i+1), $ColdMaxMs)
    continue
  }
  Write-Host ("[{0}#{1}] cold={2}ms warm={3}ms host={4}MB child={5}MB total={6}MB peak={7}MB cpu={8}%  ({9} children)" -f `
    $Name, $r.iter, $r.cold_ms, $r.warm_ms, $r.host_rss_mb, $r.child_rss_mb, $r.total_rss_mb, $r.peak_rss_mb, $r.idle_cpu_pct, $r.child_count)
  $results.Add($r)
  Start-Sleep -Milliseconds 1000
}

if ($results.Count -eq 0) {
  Write-Host "No successful iterations."
  exit 1
}

$colds  = @($results | ForEach-Object { [double]$_.cold_ms })
$warms  = @($results | ForEach-Object { [double]$_.warm_ms })
$hosts  = @($results | ForEach-Object { [double]$_.host_rss_mb })
$totals = @($results | ForEach-Object { [double]$_.total_rss_mb })
$peaks  = @($results | ForEach-Object { [double]$_.peak_rss_mb })
$cpus   = @($results | ForEach-Object { [double]$_.idle_cpu_pct })

$summary = [pscustomobject]@{
  name            = $Name
  exe             = $Exe
  args            = ($ExeArgs -join ' ')
  n               = $results.Count
  cold_p50_ms     = (Percentile $colds 50)
  cold_p95_ms     = (Percentile $colds 95)
  warm_p50_ms     = (Percentile $warms 50)
  warm_p95_ms     = (Percentile $warms 95)
  host_rss_p50    = (Percentile $hosts 50)
  total_rss_p50   = (Percentile $totals 50)
  total_rss_p95   = (Percentile $totals 95)
  peak_rss_p50    = (Percentile $peaks 50)
  peak_rss_p95    = (Percentile $peaks 95)
  idle_cpu_p50    = (Percentile $cpus 50)
  child_count     = ($results[0].child_count)
  observe_ms      = $ObserveMs
  raw             = $results
}

Write-Host ""
Write-Host ("== {0} ==  cold p50={1}ms  warm p50={2}ms  host={3}MB  total={4}MB  peak={5}MB  cpu={6}%" -f `
  $Name, $summary.cold_p50_ms, $summary.warm_p50_ms, $summary.host_rss_p50, $summary.total_rss_p50, $summary.peak_rss_p50, $summary.idle_cpu_p50)
$json = $summary | ConvertTo-Json -Depth 5
$json
if ($OutJson) { $json | Out-File -Encoding utf8 -FilePath $OutJson }
