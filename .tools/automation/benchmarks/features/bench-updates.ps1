param()
$appDir = "C:\Users\mauro\Desktop\electrobun-bench\app"
$exe = Join-Path $appDir "node_modules\electrobun\bin\electrobun.exe"
$bsdiff = Join-Path $appDir "node_modules\electrobun\dist-win-x64\bsdiff.exe"
$outDir = "C:\Users\mauro\Desktop\electrobun-bench\updates"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Set-Location $appDir

# Helper: run stable build, grab the tar.zst
function BuildAndGrab($label) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $exe build --env=stable 2>&1 | Out-Null
    $sw.Stop()
    $src = Get-ChildItem -Path ".\build\stable-win-x64" -Filter "*-Setup.tar.zst" | Select-Object -First 1
    $dst = Join-Path $outDir "$label.tar.zst"
    Copy-Item $src.FullName $dst -Force
    $sz = (Get-Item $dst).Length
    Write-Host "BUILD [$label]: time=$($sw.ElapsedMilliseconds)ms size=$sz bytes ($([math]::Round($sz/1MB,2)) MB)"
    return $dst
}

# Baseline (uses current src state, which has the bench harness)
$v1 = BuildAndGrab "v1_baseline"

# Scenario 1: trivial 1-line change in Bun code
Add-Content "src\bun\index.ts" "`n// patch-test 1 $(Get-Random)"
$v2 = BuildAndGrab "v2_trivial_edit"

# Scenario 2: small function added in Bun code (~10 lines)
Add-Content "src\bun\index.ts" @"

function unusedNewFunction_$(Get-Random)() {
    const a = 1;
    const b = 2;
    const c = a + b;
    const d = c * 2;
    const e = d - 1;
    return { a, b, c, d, e };
}
"@
$v3 = BuildAndGrab "v3_func_added"

# Scenario 3: significant webview JS change (~200 lines)
$jsBloat = "`n"
for ($i = 0; $i -lt 200; $i++) { $jsBloat += "const __bloat_$i = 'line $i $(Get-Random)';`n" }
Add-Content "src\mainview\index.ts" $jsBloat
$v4 = BuildAndGrab "v4_js_bulk"

# Scenario 4: HTML asset change
$htmlContent = Get-Content "src\mainview\index.html" -Raw
$htmlContent = $htmlContent -replace "<title>IPC Bench</title>","<title>IPC Bench $(Get-Random)</title>"
Set-Content "src\mainview\index.html" $htmlContent
$v5 = BuildAndGrab "v5_html_change"

Write-Output ""
Write-Output "=== PATCH SIZES (bsdiff between versions) ==="
$scenarios = @(
    @{from=$v1; to=$v2; name="baseline -> 1-line edit"}
    @{from=$v2; to=$v3; name="1-line edit -> +10-line function"}
    @{from=$v3; to=$v4; name="+10-line func -> +200 lines webview JS"}
    @{from=$v4; to=$v5; name="+200 lines webview JS -> HTML title edit"}
    @{from=$v1; to=$v5; name="baseline -> final (cumulative)"}
)

foreach ($s in $scenarios) {
    $patchPath = Join-Path $outDir "patch_$(Split-Path -Leaf $s.to).bsdiff"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $bsdiff $s.from $s.to $patchPath 2>&1 | Out-Null
    $sw.Stop()
    $psize = (Get-Item $patchPath).Length
    $fromSize = (Get-Item $s.from).Length
    $toSize = (Get-Item $s.to).Length
    $ratio = [math]::Round(($psize / $toSize) * 100, 4)
    Write-Output ("{0,-48}: patch={1,-10:N0} B ({2,-6:N2} KB) vs full={3,-10:N0} ({4:N2} MB) = {5:N4}% bsdiff_time={6} ms" -f $s.name, $psize, ($psize/1KB), $toSize, ($toSize/1MB), $ratio, $sw.ElapsedMilliseconds)
}

Write-Output ""
Write-Output "=== Raw tar.zst sizes ==="
Get-ChildItem $outDir -Filter "*.tar.zst" | Sort-Object Name | Format-Table Name,Length,@{N='MB';E={[math]::Round($_.Length/1MB,2)}} -AutoSize
