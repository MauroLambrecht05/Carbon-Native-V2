# bench-audio.ps1 — carbon-audio benchmark
# Compares cold start WITH and WITHOUT audio, and measures binary size delta.
param([int]$N = 5)

$MINI_EXE = "C:\Users\mauro\Desktop\electrobun-bench\carbon-native\runtimes\mini\target\release\carbon-mini.exe"
$COUNTER   = "C:\Users\mauro\Desktop\electrobun-bench\carbon-native\examples\mini-counter"
$AUDIO     = "C:\Users\mauro\Desktop\electrobun-bench\carbon-native\examples\audio-demo"
$BASE      = "C:\Users\mauro\Desktop\electrobun-bench\carbon-native\scripts"

. "$BASE\bench-runtime-v2.ps1" -ErrorAction SilentlyContinue

Write-Host "=== carbon-audio benchmark (n=$N) ==="

# --- 1. Cold start WITHOUT audio (mini-counter) ---
Write-Host "`n[1] Cold start - NO audio (mini-counter, n=$N)"
$noAudio = @()
for ($i = 0; $i -lt $N; $i++) {
    $r = Measure-Iter -exe $MINI_EXE -exeArgs @($COUNTER) -cwd "" -iter ($i+1)
    if ($r) { $noAudio += $r.cold_ms; Write-Host "  iter $($i+1): $($r.cold_ms) ms" }
    Start-Sleep -Milliseconds 500
}
$noAudioP50 = if ($noAudio.Count) { ($noAudio | Sort-Object)[[math]::Floor($noAudio.Count/2)] } else { 0 }

# --- 2. Cold start WITH audio (audio-demo) ---
Write-Host "`n[2] Cold start - WITH audio (audio-demo, n=$N)"
$withAudio = @()
for ($i = 0; $i -lt $N; $i++) {
    $r = Measure-Iter -exe $MINI_EXE -exeArgs @($AUDIO) -cwd "" -iter ($i+1)
    if ($r) { $withAudio += $r.cold_ms; Write-Host "  iter $($i+1): $($r.cold_ms) ms" }
    Start-Sleep -Milliseconds 500
}
$withAudioP50 = if ($withAudio.Count) { ($withAudio | Sort-Object)[[math]::Floor($withAudio.Count/2)] } else { 0 }

# --- 3. Binary size ---
$size = (Get-Item $MINI_EXE).Length / 1MB
Write-Host "`n[3] Binary size: $([math]::Round($size,2)) MB"

# --- Summary ---
Write-Host "`n== SUMMARY =="
Write-Host "  Cold start (no audio)  p50 = $noAudioP50 ms"
Write-Host "  Cold start (audio=on)  p50 = $withAudioP50 ms"
Write-Host "  Init delta             = $($withAudioP50 - $noAudioP50) ms"
Write-Host "  Binary size            = $([math]::Round($size,2)) MB"
