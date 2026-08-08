# Times "edit a host command, see effect" for both stacks.
#
# Carbon path: edit shell.ts -> bun build src/shell.ts -> dist/shell.js
#   (the carbon-runtime file watcher detects the change and re-evaluates rquickjs in <10ms)
# Tauri path: edit src-tauri/src/main.rs -> cargo build (incremental dev profile)
#
# We measure the build/transpile time only (the dominant cost). Hot-reload eval and
# process restart are constant tens of ms; cargo / bun build is where the seconds live.
# Each test runs 3 incremental edits (different one-line changes) to expose the steady-state.

param(
  [int]$Iterations = 3
)

function Time-It([scriptblock]$script) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & $script | Out-Null
  $sw.Stop()
  return [int]$sw.ElapsedMilliseconds
}

# === Carbon: edit shell.ts, run bun build ===
$carbonDir = "C:\Users\mauro\Desktop\electrobun-bench\carbon-native\examples\notes"
$carbonShell = Join-Path $carbonDir "src\shell.ts"
$carbonOrig = Get-Content $carbonShell -Raw

Write-Host "=== Carbon: edit shell.ts -> bun build ==="
$carbonResults = @()
for ($i = 1; $i -le $Iterations; $i++) {
  $patched = $carbonOrig -replace 'console\.log\("\[shell\] carbon notes shell loaded.*?"\);',
    "console.log(`"[shell] carbon notes shell loaded edit-$i`");"
  Set-Content -Path $carbonShell -Value $patched -Encoding utf8
  $ms = Time-It {
    Push-Location $carbonDir
    cmd /c "bun build src\shell.ts --target=browser --format=esm --outdir dist > nul 2>&1"
    Pop-Location
  }
  Write-Host ("  iter {0}: {1} ms" -f $i, $ms)
  $carbonResults += $ms
}
# restore original
Set-Content -Path $carbonShell -Value $carbonOrig -Encoding utf8
& bun build src\shell.ts --target=browser --format=esm --outdir dist > $null 2>&1 # restore dist
$carbonMin = ($carbonResults | Measure-Object -Minimum).Minimum
$carbonMed = ($carbonResults | Sort-Object)[[int]($carbonResults.Count / 2)]
Write-Host ("  carbon: median={0}ms  min={1}ms" -f $carbonMed, $carbonMin)

# === Tauri: edit main.rs, run cargo build (debug, incremental) ===
# Baseline app lives in the local-only archive (see archive/README.md). It ships
# sources only, so `cargo build` there is a cold build the first time.
$tauriDir = Join-Path $PSScriptRoot "..\..\archive\baselines\tauri-notes\src-tauri"
$tauriMain = Join-Path $tauriDir "src\main.rs"
$tauriOrig = Get-Content $tauriMain -Raw

Write-Host ""
Write-Host "=== Tauri: edit main.rs -> cargo build ==="
# Warm up: run one debug build so deps are compiled (steady-state incremental measurement)
Push-Location $tauriDir
Write-Host "  warming up debug profile (compiling deps once)..."
$warmMs = Time-It { cmd /c "cargo build > nul 2>&1" }
Write-Host ("  warmup compile: {0} ms (deps cached after this)" -f $warmMs)
Pop-Location

$tauriResults = @()
for ($i = 1; $i -le $Iterations; $i++) {
  $patched = $tauriOrig -replace 'runtime: "Tauri 2 \(Rust\)".to_string\(\),',
    "runtime: `"Tauri 2 (Rust) edit-$i`".to_string(),"
  Set-Content -Path $tauriMain -Value $patched -Encoding utf8
  $ms = Time-It {
    Push-Location $tauriDir
    cmd /c "cargo build > nul 2>&1"
    Pop-Location
  }
  Write-Host ("  iter {0}: {1} ms" -f $i, $ms)
  $tauriResults += $ms
}
# restore original
Set-Content -Path $tauriMain -Value $tauriOrig -Encoding utf8
$tauriMin = ($tauriResults | Measure-Object -Minimum).Minimum
$tauriMed = ($tauriResults | Sort-Object)[[int]($tauriResults.Count / 2)]
Write-Host ("  tauri: median={0}ms  min={1}ms" -f $tauriMed, $tauriMin)

Write-Host ""
Write-Host "=== Summary ==="
Write-Host ("carbon-native (edit shell.ts -> bun build): median {0}ms" -f $carbonMed)
Write-Host ("tauri (edit main.rs -> cargo build incremental): median {0}ms" -f $tauriMed)
$ratio = [math]::Round($tauriMed / [math]::Max($carbonMed,1), 1)
Write-Host ("carbon is {0}× faster on incremental host-code edits" -f $ratio)

[pscustomobject]@{
  carbon = @{ results = $carbonResults; median_ms = $carbonMed; min_ms = $carbonMin }
  tauri  = @{ warmup_ms = $warmMs; results = $tauriResults; median_ms = $tauriMed; min_ms = $tauriMin }
  ratio  = $ratio
} | ConvertTo-Json -Depth 5
