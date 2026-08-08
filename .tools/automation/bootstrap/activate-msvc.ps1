# Activates MSVC + Zig in the current PowerShell session.
# Dot-source: . .\activate-msvc.ps1
$script:savedEAP = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"

$vcvars = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found at $vcvars" }

# Run vcvars in a cmd shell, then dump env vars to a temp file we can read
$envDump = [System.IO.Path]::GetTempFileName()
$cmdLine = "`"$vcvars`" >NUL 2>&1 && set > `"$envDump`""
& cmd /c $cmdLine 2>$null | Out-Null

if (-not (Test-Path $envDump) -or (Get-Item $envDump).Length -eq 0) {
    throw "vcvars dump failed"
}

# Apply key env vars
$wantedKeys = @('PATH','INCLUDE','LIB','LIBPATH','VCINSTALLDIR','VCToolsInstallDir','WindowsSdkDir','WindowsSDKVersion','UCRTVersion','UniversalCRTSdkDir','VSCMD_ARG_HOST_ARCH','VSCMD_ARG_TGT_ARCH','VCIDEInstallDir','DevEnvDir','VS170COMNTOOLS','WindowsLibPath','ExtensionSdkDir','VSINSTALLDIR','Framework40Version','FrameworkDir','FrameworkVersion','UCRTContentRoot','VCToolsRedistDir','VCToolsVersion','WindowsSdkBinPath','WindowsSdkVerBinPath','__VSCMD_PREINIT_PATH')
Get-Content $envDump | ForEach-Object {
    $kv = $_ -split '=', 2
    if ($kv.Count -eq 2 -and $wantedKeys -contains $kv[0]) {
        Set-Item "env:$($kv[0])" $kv[1]
    }
}
Remove-Item $envDump -Force -ErrorAction SilentlyContinue

# Add Zig to PATH
$zigDir = "C:\Users\mauro\AppData\Local\zig\current"
if (Test-Path "$zigDir\zig.exe") {
    if ($env:PATH -notlike "*$zigDir*") {
        $env:PATH = "$zigDir;" + $env:PATH
    }
}

# Verify
$cl = (Get-Command cl.exe -ErrorAction SilentlyContinue).Source
$zig = (Get-Command zig.exe -ErrorAction SilentlyContinue).Source
Write-Host "[activate-msvc] cl  : $cl"
Write-Host "[activate-msvc] zig : $zig"

# Add Rust (cargo, rustc) to PATH
$cargoBin = "$env:USERPROFILE\.cargo\bin"
if (Test-Path "$cargoBin\cargo.exe") {
    if ($env:PATH -notlike "*$cargoBin*") {
        $env:PATH = "$cargoBin;" + $env:PATH
    }
    Write-Host "[activate-msvc] cargo, rustc now on PATH"
}
