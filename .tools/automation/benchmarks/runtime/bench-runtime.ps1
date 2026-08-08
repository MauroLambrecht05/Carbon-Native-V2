# Cross-stack runtime benchmark.
#   - Launches an app exe with optional args.
#   - Measures wall-clock until first top-level visible window owned by the PID tree.
#   - After 3s of idle, samples WorkingSet64 of host PID + descendants (child processes).
#   - Repeats N times. Outputs per-iteration JSON + p50/p95.
# Usage:
#   .\bench-runtime.ps1 -Name "carbon" -Exe "..\carbon-native\runtime\target\release\carbon-runtime.exe" -Args @("..\carbon-native\examples\hello") -N 5
param(
  [Parameter(Mandatory)] [string]$Name,
  [Parameter(Mandatory)] [string]$Exe,
  [string[]]$Args = @(),
  [int]$N = 5,
  [int]$IdleMs = 3000,
  [int]$ColdMaxMs = 15000,
  [string]$Cwd = ""
)

# Win32: enumerate top-level visible windows and find one whose process is in $pidSet
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Win {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowLongW(IntPtr hWnd, int nIndex);
  public const int GWL_STYLE = -16;
  public const uint WS_VISIBLE = 0x10000000;
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
  # Ready = any process in the tree has MainWindowHandle != 0 AND IsWindowVisible.
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

function Measure-Once {
  param([string]$exe, [string[]]$exeArgs, [string]$cwd)

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $argLine = ($exeArgs | ForEach-Object {
    if ($_ -match '\s') { '"' + $_.Replace('"', '\"') + '"' } else { $_ }
  }) -join ' '
  $psi.Arguments = $argLine
  if ($cwd) { $psi.WorkingDirectory = $cwd }
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $false
  $psi.RedirectStandardError = $false

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $proc = [System.Diagnostics.Process]::Start($psi)
  $coldMs = Wait-WindowReady -rootPid $proc.Id -timeoutMs $ColdMaxMs
  $sw.Stop()

  Start-Sleep -Milliseconds $IdleMs

  $hostRSS = 0
  $childRSS = 0
  $childCount = 0
  $hostName = ""
  try {
    $h = Get-Process -Id $proc.Id -ErrorAction Stop
    $hostRSS = $h.WorkingSet64
    $hostName = $h.ProcessName
  } catch {}
  $tree = Get-DescendantPids -rootPid $proc.Id
  foreach ($c in $tree) {
    try {
      $cp = Get-Process -Id ([int]$c.ProcessId) -ErrorAction Stop
      $childRSS += $cp.WorkingSet64
      $childCount++
    } catch {}
  }

  # Tear down — close window then kill if necessary
  try { $proc.CloseMainWindow() | Out-Null } catch {}
  Start-Sleep -Milliseconds 200
  try {
    foreach ($c in $tree) { try { Stop-Process -Id ([int]$c.ProcessId) -Force -ErrorAction SilentlyContinue } catch {} }
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  } catch {}

  return [pscustomobject]@{
    cold_ms     = $coldMs
    host_name   = $hostName
    host_rss_mb = [math]::Round($hostRSS / 1MB, 2)
    child_rss_mb= [math]::Round($childRSS / 1MB, 2)
    child_count = $childCount
    total_rss_mb= [math]::Round(($hostRSS + $childRSS) / 1MB, 2)
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
  $r = Measure-Once -exe $Exe -exeArgs $Args -cwd $Cwd
  Write-Host ("[{0}#{1}] cold={2}ms  host={3} {4}MB  children={5} {6}MB  total={7}MB" -f $Name, ($i+1), $r.cold_ms, $r.host_name, $r.host_rss_mb, $r.child_count, $r.child_rss_mb, $r.total_rss_mb)
  $results.Add($r)
  Start-Sleep -Milliseconds 1000
}

$colds  = @($results | ForEach-Object { [double]$_.cold_ms })
$hosts  = @($results | ForEach-Object { [double]$_.host_rss_mb })
$childs = @($results | ForEach-Object { [double]$_.child_rss_mb })
$totals = @($results | ForEach-Object { [double]$_.total_rss_mb })

$summary = [pscustomobject]@{
  name = $Name
  n = $N
  cold_p50_ms   = (Percentile $colds 50)
  cold_p95_ms   = (Percentile $colds 95)
  host_rss_p50  = (Percentile $hosts 50)
  host_rss_p95  = (Percentile $hosts 95)
  child_rss_p50 = (Percentile $childs 50)
  child_rss_p95 = (Percentile $childs 95)
  total_rss_p50 = (Percentile $totals 50)
  total_rss_p95 = (Percentile $totals 95)
  child_count   = ($results[0].child_count)
  raw           = $results
}

Write-Host ""
Write-Host ("== {0} ==  cold p50={1}ms  host p50={2}MB  child p50={3}MB  total p50={4}MB" -f $Name, $summary.cold_p50_ms, $summary.host_rss_p50, $summary.child_rss_p50, $summary.total_rss_p50)
$summary | ConvertTo-Json -Depth 5
