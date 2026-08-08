# Bench: time `carbon init <name> --run` from invocation to first paint
# of the resulting app's window.
#
# Stages folded into the wall-clock:
#   1. carbon init           ~3-5 ms scaffold (file writes)
#   2. bun install           cold (network + resolve) or warm (linker only)
#   3. carbon dev start      bun + babel + bytecode compile
#   4. carbon-mini.exe       cold runtime start (~200 ms)
#   5. window painted        IsWindowVisible == true
#
# Usage:
#   .\bench-init-run.ps1 -N 3
#   .\bench-init-run.ps1 -N 5 -ColdMaxMs 60000
#
# Notes:
#   - Cleans up <examples>/test-init-<N>/ before and after each iter.
#   - Uses a private variable name ($targetPid) to avoid the $pid PS automatic.
#   - Watches the carbon-mini process specifically (skip the parent bun/cli
#     which also has its own console window).

param(
  [int]$N = 3,
  [int]$ColdMaxMs = 60000
)

$ErrorActionPreference = "Stop"

$exe  = "C:\Users\mauro\Desktop\electrobun-bench\carbon-native\cli\rust\target\release\carbon.exe"
$base = "C:\Users\mauro\Desktop\electrobun-bench\carbon-native\examples"

if (-not (Test-Path $exe)) { throw "carbon binary not found: $exe" }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@ -ErrorAction SilentlyContinue

function Get-Tree([int]$root) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $byParent = @{}
  foreach ($p in $all) {
    $pp = [int]$p.ParentProcessId
    if (-not $byParent.ContainsKey($pp)) { $byParent[$pp] = @() }
    $byParent[$pp] += [int]$p.ProcessId
  }
  $out = New-Object System.Collections.Generic.List[int]
  $stack = New-Object System.Collections.Generic.Stack[int]
  $stack.Push($root)
  $out.Add($root)
  while ($stack.Count -gt 0) {
    $cur = $stack.Pop()
    if ($byParent.ContainsKey($cur)) {
      foreach ($c in $byParent[$cur]) {
        if (-not $out.Contains($c)) { $out.Add($c); $stack.Push($c) }
      }
    }
  }
  return $out
}

function Wait-Window([int]$root, [int]$timeoutMs, [string]$wantName) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
    $tree = Get-Tree $root
    foreach ($targetPid in $tree) {
      try {
        $p = Get-Process -Id $targetPid -ErrorAction Stop
        if ($wantName -and $p.ProcessName -ne $wantName) { continue }
        $h = $p.MainWindowHandle
        if ($h -ne [IntPtr]::Zero -and [Win]::IsWindowVisible($h)) {
          return @{ ms = $sw.ElapsedMilliseconds; pid = $targetPid; name = $p.ProcessName }
        }
      } catch {}
    }
    Start-Sleep -Milliseconds 10
  }
  return $null
}

function Stop-Tree([int]$root) {
  $tree = Get-Tree $root
  foreach ($targetPid in $tree) {
    try { Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue } catch {}
  }
}

function Cleanup-Dirs() {
  for ($k = 1; $k -le 10; $k++) {
    $dir = Join-Path $base "test-init-$k"
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue }
  }
}

Cleanup-Dirs

$results = New-Object System.Collections.Generic.List[long]
for ($i = 1; $i -le $N; $i++) {
  Get-Process -Name carbon-mini -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500

  Push-Location $base
  try {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Start-Process -FilePath $exe -ArgumentList @("init", "test-init-$i", "--run") -PassThru -WindowStyle Minimized
    $r = Wait-Window -root $proc.Id -timeoutMs $ColdMaxMs -wantName "carbon-mini"
    $sw.Stop()
    if ($r) {
      Write-Host ("iter {0}: window-visible={1} ms  (carbon-mini pid={2})" -f $i, $r.ms, $r.pid)
      $results.Add([long]$r.ms)
    } else {
      Write-Host ("iter {0}: TIMEOUT after {1} ms" -f $i, $sw.ElapsedMilliseconds)
    }
    Stop-Tree $proc.Id
  } finally {
    Pop-Location
  }
  Start-Sleep -Milliseconds 1000
}

Cleanup-Dirs

Write-Host ""
if ($results.Count -gt 0) {
  $sorted = $results | Sort-Object
  $n = $sorted.Count
  $p50 = $sorted[[math]::Floor(($n - 1) * 0.50)]
  $p95 = $sorted[[math]::Floor(($n - 1) * 0.95)]
  $min = $sorted[0]
  $max = $sorted[$n - 1]
  $mean = [int](($sorted | Measure-Object -Average).Average)
  Write-Host ("== carbon init --run, n={0} ==" -f $n)
  Write-Host ("  min   = {0} ms" -f $min)
  Write-Host ("  p50   = {0} ms" -f $p50)
  Write-Host ("  mean  = {0} ms" -f $mean)
  Write-Host ("  p95   = {0} ms" -f $p95)
  Write-Host ("  max   = {0} ms" -f $max)
  Write-Host ("  raw   = {0}" -f ($results -join ', '))
} else {
  Write-Host "No successful iterations."
  exit 1
}
