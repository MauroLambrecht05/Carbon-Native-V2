param(
    [int]$Iterations = 10,
    [int]$SettleMs = 3000
)

$launcher = "C:\Users\mauro\Desktop\electrobun-bench\app\build\dev-win-x64\hello-world-dev\bin\launcher.exe"
if (-not (Test-Path $launcher)) {
    Write-Error "Launcher not found: $launcher"
    exit 1
}

$results = @()

for ($i = 1; $i -le $Iterations; $i++) {
    # Ensure no stale processes
    Get-Process -Name "launcher","bun","hello-world" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $launcher -PassThru -WindowStyle Minimized
    $spawnTime = $sw.ElapsedMilliseconds

    # Wait for bun child process to appear
    $bunProc = $null
    $waitStart = [System.Diagnostics.Stopwatch]::StartNew()
    while ($waitStart.ElapsedMilliseconds -lt 10000) {
        $bunProc = Get-Process -Name "bun" -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt $p.StartTime.AddSeconds(-1) } | Select-Object -First 1
        if ($bunProc) { break }
        Start-Sleep -Milliseconds 20
    }
    $bunReadyTime = $waitStart.ElapsedMilliseconds

    if (-not $bunProc) {
        Write-Output "Iter $i : bun process never appeared"
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        continue
    }

    # Let the app settle (webview load, etc.)
    Start-Sleep -Milliseconds $SettleMs

    # Measure memory of launcher + bun + any child
    $procs = @($p)
    if ($bunProc) { $procs += $bunProc }
    $webviewProcs = Get-Process -Name "msedgewebview2" -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt $p.StartTime.AddSeconds(-1) }
    $procs += $webviewProcs

    $totalRss = 0
    $totalPaged = 0
    $procBreakdown = @{}
    foreach ($proc in $procs) {
        try {
            $proc.Refresh()
            $rss = $proc.WorkingSet64
            $totalRss += $rss
            $totalPaged += $proc.PagedMemorySize64
            $procBreakdown[$proc.ProcessName] = ($procBreakdown[$proc.ProcessName] + $rss)
        } catch {}
    }

    $results += [PSCustomObject]@{
        Iter = $i
        SpawnMs = $spawnTime
        BunReadyMs = $bunReadyTime
        TotalRssMB = [math]::Round($totalRss/1MB, 2)
        LauncherRssMB = [math]::Round($procBreakdown['launcher']/1MB, 2)
        BunRssMB = [math]::Round($procBreakdown['bun']/1MB, 2)
        WebviewRssMB = [math]::Round($procBreakdown['msedgewebview2']/1MB, 2)
        WebviewCount = $webviewProcs.Count
    }

    # Cleanup
    foreach ($proc in $procs) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    Start-Sleep -Milliseconds 500
}

Write-Output "=== RAW RESULTS ==="
$results | Format-Table -AutoSize

Write-Output "=== STATISTICS ==="
function Stats($vals) {
    $sorted = $vals | Sort-Object
    $n = $sorted.Count
    if ($n -eq 0) { return @{mean=0;p50=0;p95=0;p99=0;min=0;max=0} }
    return @{
        n = $n
        mean = [math]::Round(($sorted | Measure-Object -Average).Average, 2)
        p50 = $sorted[[math]::Floor($n*0.50)]
        p95 = $sorted[[math]::Min($n-1, [math]::Floor($n*0.95))]
        p99 = $sorted[[math]::Min($n-1, [math]::Floor($n*0.99))]
        min = $sorted[0]
        max = $sorted[$n-1]
    }
}

foreach ($col in @('SpawnMs','BunReadyMs','TotalRssMB','LauncherRssMB','BunRssMB','WebviewRssMB')) {
    $vals = $results.$col | Where-Object { $_ -ne $null }
    $s = Stats $vals
    Write-Output ("{0,-16}: n={1} mean={2} min={3} p50={4} p95={5} p99={6} max={7}" -f $col, $s.n, $s.mean, $s.min, $s.p50, $s.p95, $s.p99, $s.max)
}

# Save JSON for later aggregation
$results | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 "C:\Users\mauro\Desktop\electrobun-bench\scripts\startup-results.json"
Write-Output "Results saved to startup-results.json"
