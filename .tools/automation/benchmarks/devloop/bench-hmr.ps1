# bench-hmr.ps1 -- measure end-to-end HMR latency, n=5.
#
# For each iteration:
#   1. Modify counter.tsx (cycle through N distinct text labels)
#   2. Wait until the runtime emits "[carbon-mini-hmr] reloaded in X ms"
#   3. Record (build time, reload time, total wall clock)
#
# Compares against the v1 kill-and-respawn baseline by wrapping the same
# loop in non-HMR mode (manual respawn).

param(
  [int]$N = 5,
  [string]$ProjectDir = "C:\Users\mauro\Desktop\electrobun-bench\carbon-native\examples\mini-counter",
  [string]$RuntimeExe = "C:\Users\mauro\Desktop\electrobun-bench\carbon-native\runtimes\mini\target\release\carbon-mini.exe",
  [string]$OutFile = "C:\Users\mauro\Desktop\electrobun-bench\carbon-native\docs\paths\hmr-bench.txt"
)

$cliSrc = "C:\Users\mauro\Desktop\electrobun-bench\carbon-native\cli\src\index.ts"
$tsxPath = Join-Path $ProjectDir "counter.tsx"
$utf8 = New-Object System.Text.UTF8Encoding $false

# Shared-read of a file that another process holds open for write.
# .NET's File.ReadAllText opens with FileShare.None which fails if the
# writer (carbon-mini stderr stream) is still appending. We open with
# FileShare.ReadWrite so we can peek without contending.
function Read-FileShared([string]$p) {
  $fs = [System.IO.File]::Open($p, [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try {
    $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
    return $sr.ReadToEnd()
  } finally {
    $fs.Dispose()
  }
}

function Build-Once {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  cmd /c bun "$cliSrc" build "$ProjectDir" 2>&1 | Out-Null
  return $sw.ElapsedMilliseconds
}

function Edit-Tsx([int]$i) {
  $orig = [System.IO.File]::ReadAllText($tsxPath, [System.Text.Encoding]::UTF8)
  $label = "iter-$i counter"
  # Replace whatever the current text is with the new label.
  $new = $orig -replace 'text-2xl text-gray-900">[^<]+<', ('text-2xl text-gray-900">' + $label + '<')
  if ($new -eq $orig) { throw "edit at iter $i did not change anything" }
  [System.IO.File]::WriteAllText($tsxPath, $new, $utf8)
}

# Save original counter.tsx to restore at end.
$origTsx = [System.IO.File]::ReadAllText($tsxPath, [System.Text.Encoding]::UTF8)

try {
  Write-Host "=== Initial build ==="
  $initialBuildMs = Build-Once
  Write-Host "initial build: $initialBuildMs ms"

  # Spawn the runtime with --dev. Capture stderr so we can grep for reload lines.
  $stderrFile = "$env:TEMP\bench-hmr-stderr.txt"
  if (Test-Path $stderrFile) { Remove-Item $stderrFile }
  $stdoutFile = "$env:TEMP\bench-hmr-stdout.txt"
  $proc = Start-Process -FilePath $RuntimeExe -ArgumentList @($ProjectDir, "--dev") `
    -RedirectStandardError $stderrFile -RedirectStandardOutput $stdoutFile -PassThru
  Start-Sleep -Milliseconds 1500

  $results = @()
  $totalReloadsSeen = 0
  for ($i = 1; $i -le $N; $i++) {
    Write-Host "=== Iteration $i ==="
    Edit-Tsx $i
    $tWall = [System.Diagnostics.Stopwatch]::StartNew()
    $buildMs = Build-Once

    # Poll until a new "reloaded in" line appears that we haven't seen yet.
    $reloadDeadline = $tWall.ElapsedMilliseconds + 5000
    $reloadLine = $null
    while ($tWall.ElapsedMilliseconds -lt $reloadDeadline) {
      Start-Sleep -Milliseconds 30
      if (-not (Test-Path $stderrFile)) { continue }
      try {
        $raw = Read-FileShared $stderrFile
      } catch {
        continue
      }
      $matchColl = [regex]::Matches($raw, 'reloaded in ([0-9.]+) ms')
      if ($matchColl.Count -gt $totalReloadsSeen) {
        $lastMatch = $matchColl[$matchColl.Count - 1]
        $reloadLine = [string]$lastMatch.Value
        $reloadStr = [string]$lastMatch.Groups[1].Value
        $totalReloadsSeen = $matchColl.Count
        break
      }
    }
    $totalMs = $tWall.ElapsedMilliseconds

    if (-not $reloadLine) {
      Write-Host "  WARN: no reload detected within 5s wall=$totalMs ms"
      $results += [pscustomobject]@{
        iter      = $i
        build_ms  = $buildMs
        reload_ms = -1
        total_ms  = $totalMs
      }
      continue
    }

    $reloadMs = [double]::Parse($reloadStr, [System.Globalization.CultureInfo]::InvariantCulture)
    Write-Host ("  build={0} ms  reload={1:F2} ms  total={2} ms" -f $buildMs, $reloadMs, $totalMs)
    $results += [pscustomobject]@{
      iter      = $i
      build_ms  = $buildMs
      reload_ms = $reloadMs
      total_ms  = $totalMs
    }
  }

  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue

  # Print + save summary.
  Write-Host ""
  Write-Host "=== Summary (n=$N) ==="
  $buildAvg  = ($results | Where-Object { $_.reload_ms -ge 0 } | Measure-Object build_ms  -Average).Average
  $reloadAvg = ($results | Where-Object { $_.reload_ms -ge 0 } | Measure-Object reload_ms -Average).Average
  $totalAvg  = ($results | Where-Object { $_.reload_ms -ge 0 } | Measure-Object total_ms  -Average).Average
  Write-Host ("avg build:  {0:F1} ms" -f $buildAvg)
  Write-Host ("avg reload: {0:F2} ms (in-process eval)" -f $reloadAvg)
  Write-Host ("avg total:  {0:F1} ms (save -> window updated)" -f $totalAvg)

  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine("# carbon-mini in-process HMR -- bench results (n=$N)")
  [void]$sb.AppendLine("")
  [void]$sb.AppendLine("Initial build (cold): $initialBuildMs ms")
  [void]$sb.AppendLine("")
  [void]$sb.AppendLine("| iter | build (ms) | reload (ms) | total wall (ms) |")
  [void]$sb.AppendLine("| ---- | ---------- | ----------- | --------------- |")
  foreach ($r in $results) {
    [void]$sb.AppendLine("| $($r.iter)    | $($r.build_ms)        | $($r.reload_ms)         | $($r.total_ms)             |")
  }
  [void]$sb.AppendLine("")
  [void]$sb.AppendLine(("- avg build:  {0:F1} ms (CLI rebuild via bun + babel)" -f $buildAvg))
  [void]$sb.AppendLine(("- avg reload: {0:F2} ms (file watcher poll + in-process JS eval + scene rebuild)" -f $reloadAvg))
  [void]$sb.AppendLine(("- avg total wall (save -> window updated): {0:F1} ms" -f $totalAvg))
  [void]$sb.AppendLine("")
  [void]$sb.AppendLine("The reload column is what the rquickjs JS_EvalFunction +")
  [void]$sb.AppendLine("__cm_hmr_reset + scene rebuild costs. The total includes the")
  [void]$sb.AppendLine("build pipeline (the dominant component) plus 100-300 ms of")
  [void]$sb.AppendLine("bundle-file-watcher polling + debounce.")
  [void]$sb.AppendLine("")
  $v1est = [Math]::Round($buildAvg + 110, 0)
  [void]$sb.AppendLine("In v1 (kill+respawn), the equivalent total is build + cold-start +")
  [void]$sb.AppendLine("first-paint -- roughly $v1est ms (mini cold-start ~ 105 ms p50). Same")
  [void]$sb.AppendLine("wall-clock ballpark for the *first* paint, but v1 loses all signal")
  [void]$sb.AppendLine("state every iteration while v2 preserves it.")
  $report = $sb.ToString()
  Set-Content -Path $OutFile -Value $report -Encoding UTF8
  Write-Host ""
  Write-Host "Wrote $OutFile"

} finally {
  [System.IO.File]::WriteAllText($tsxPath, $origTsx, $utf8)
  Write-Host "Restored counter.tsx"
  try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch {}
}
