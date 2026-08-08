# Windows Code Signing (Authenticode) via signtool.exe
# Usage: .\sign-windows.ps1 -File "path\to\app.exe"
# Reads certificate path and password from environment: CARBON_CERT_PATH, CARBON_CERT_PASSWORD
# Or custom sign_command from carbon.toml [signer.windows]

param(
    [Parameter(Mandatory = $true)]
    [string]$File
)

function Find-SignTool {
    $sdkPaths = @(
        "C:\Program Files (x86)\Windows Kits\10\bin\x64",
        "C:\Program Files (x86)\Windows Kits\11\bin\x64",
        "C:\Program Files\Windows Kits\10\bin\x64",
        "C:\Program Files\Windows Kits\11\bin\x64"
    )

    foreach ($path in $sdkPaths) {
        if (Test-Path "$path\signtool.exe") {
            return "$path\signtool.exe"
        }
    }

    # Try system PATH
    try {
        $result = Get-Command signtool.exe -ErrorAction SilentlyContinue
        if ($result) { return $result.Source }
    } catch {}

    return $null
}

function Sign-FileWithSignTool {
    param(
        [string]$FilePath,
        [string]$CertPath,
        [string]$CertPassword,
        [string]$TimestampServer
    )

    $signtool = Find-SignTool
    if (-not $signtool) {
        Write-Error "signtool.exe not found. Install Windows SDK."
        return $false
    }

    Write-Host "🔐 Signing $([System.IO.Path]::GetFileName($FilePath))..."
    Write-Host "  Certificate: $CertPath" -ForegroundColor Gray
    Write-Host "  Timestamp: $TimestampServer" -ForegroundColor Gray

    try {
        & $signtool sign /f $CertPath /p $CertPassword /fd SHA256 /tr $TimestampServer /td SHA256 $FilePath

        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ Signed successfully" -ForegroundColor Green
            return $true
        } else {
            Write-Error "Signing failed with code $LASTEXITCODE"
            return $false
        }
    } catch {
        Write-Error "Signing error: $_"
        return $false
    }
}

function Verify-Signature {
    param([string]$FilePath)

    $signtool = Find-SignTool
    if (-not $signtool) { return $false }

    Write-Host "✓ Verifying signature..."

    try {
        & $signtool verify /pa $FilePath

        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ Signature verified" -ForegroundColor Green
            return $true
        } else {
            Write-Error "Signature verification failed"
            return $false
        }
    } catch {
        Write-Error "Verification error: $_"
        return $false
    }
}

# Main
Write-Host "🪟 Windows Code Signing (Authenticode)" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan

if (-not (Test-Path $File)) {
    Write-Error "File not found: $File"
    exit 1
}

# Try custom sign_command from carbon.toml first
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$carbonToml = Join-Path $projectRoot "carbon.toml"

if (Test-Path $carbonToml) {
    $tomlContent = Get-Content $carbonToml -Raw
    if ($tomlContent -match '\[signer\.windows\]([\s\S]*?)(?=\[|$)') {
        $signerSection = $matches[1]
        if ($signerSection -match 'sign_command\s*=\s*"([^"]*)"') {
            $signCommand = $matches[1] -replace '\$FILE', $File
            Write-Host "[carbon.toml] Using custom sign_command" -ForegroundColor Gray
            Invoke-Expression $signCommand
            if ($LASTEXITCODE -ne 0) {
                exit $LASTEXITCODE
            }
        }
    }
}

# Fall back to signtool if no custom command
if ($LASTEXITCODE -eq 0 -or [string]::IsNullOrWhiteSpace($signCommand)) {
    $certPath = $env:CARBON_CERT_PATH
    $certPassword = $env:CARBON_CERT_PASSWORD
    $timestampServer = $env:CARBON_TIMESTAMP_SERVER -or "http://timestamp.digicert.com"

    if (-not $certPath -or -not $certPassword) {
        Write-Error "Certificate not found. Set CARBON_CERT_PATH and CARBON_CERT_PASSWORD"
        exit 1
    }

    $result = Sign-FileWithSignTool -FilePath $File -CertPath $certPath -CertPassword $certPassword -TimestampServer $timestampServer
    if (-not $result) { exit 1 }

    Verify-Signature -FilePath $File
    if ($LASTEXITCODE -ne 0) { exit 1 }
}

Write-Host ""
Write-Host "✓ Done! File is ready for distribution." -ForegroundColor Green
}

Write-Host "[sign-windows] Signed successfully"
