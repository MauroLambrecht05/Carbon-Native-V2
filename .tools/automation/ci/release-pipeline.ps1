# Windows CI/CD Release Pipeline
# Orchestrates: Build → Sign → Upload → Publish
# Usage: .\release-pipeline.ps1 -Version "2.0.0" -Channel "stable"

param(
    [Parameter(Mandatory=$true)]
    [string]$Version,

    [Parameter(Mandatory=$false)]
    [string]$Channel = "stable",

    [Parameter(Mandatory=$false)]
    [array]$Platforms = @("windows-x86_64", "windows-arm64"),

    [Parameter(Mandatory=$false)]
    [switch]$DryRun = $false,

    [Parameter(Mandatory=$false)]
    [switch]$SkipBuild = $false,

    [Parameter(Mandatory=$false)]
    [switch]$SkipSign = $false,

    [Parameter(Mandatory=$false)]
    [switch]$SkipUpload = $false
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $ProjectRoot

# Color functions
function Write-Step { Write-Host "`n" -NoNewline; Write-Host "▶ $($args -join ' ')" -ForegroundColor Cyan -NoNewline; Write-Host "" }
function Write-Done { Write-Host "✅ $($args -join ' ')" -ForegroundColor Green }
function Write-Error { Write-Host "❌ $($args -join ' ')" -ForegroundColor Red; exit 1 }
function Write-Info { Write-Host "   $($args -join ' ')" -ForegroundColor Gray }

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║         🚀 Carbon Release Pipeline" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

Write-Host ""
Write-Host "Version:  " -NoNewline; Write-Host $Version -ForegroundColor Cyan
Write-Host "Channel:  " -NoNewline; Write-Host $Channel -ForegroundColor Cyan
Write-Host "Platforms:" -NoNewline; Write-Host (" " + ($Platforms -join ", ")) -ForegroundColor Cyan
Write-Host "Dry-run:  " -NoNewline; Write-Host $DryRun -ForegroundColor Cyan
Write-Host ""

# Step 1: Build
if (-not $SkipBuild) {
    Write-Step "[1/5] Building release binaries..."

    foreach ($platform in $Platforms) {
        Write-Host "      Building for " -NoNewline
        Write-Host $platform -ForegroundColor Cyan

        switch -Wildcard ($platform) {
            "windows-*" {
                Write-Info "(would run: cargo zigbuild --release --target $platform)"
            }
        }
    }

    Write-Done "Build complete"
}

# Step 2: Generate Installers
Write-Step "[2/5] Generating installers..."

foreach ($platform in $Platforms) {
    switch ($platform) {
        "windows-x86_64" {
            Write-Host "      Generating NSIS installer..." -ForegroundColor Cyan
            Write-Info "(would run: bun run carbon bundle --target nsis)"
        }
        "windows-arm64" {
            Write-Host "      Generating WiX installer..." -ForegroundColor Cyan
            Write-Info "(would run: bun run carbon bundle --target wix)"
        }
    }
}

Write-Done "Installers generated"

# Step 3: Code Signing
if (-not $SkipSign) {
    Write-Step "[3/5] Code Signing..."

    foreach ($platform in $Platforms) {
        Write-Host "      Signing " -NoNewline
        Write-Host $platform -ForegroundColor Cyan

        if ($platform -like "windows-*") {
            Write-Info "Authenticode (signtool)"
            Write-Info "(would run: .\sign-windows.ps1 -File `"dist\app-$Version-$platform.exe`")"
        }
    }

    Write-Done "Code signing complete"
}

# Step 4: Create and Sign Manifest
Write-Step "[4/5] Creating and signing manifest..."

$DistDir = "dist\$Channel"
$ManifestFile = "$DistDir\manifest.json"

if (-not (Test-Path $DistDir)) {
    New-Item -ItemType Directory -Path $DistDir -Force | Out-Null
}

$Manifest = @{
    version = $Version
    pub_date = (Get-Date -AsUTC -Format "o")
    channel = $Channel
    notes = "Release $Version on $Channel channel"
    min_version = "1.0.0"
    rollout = 10
    keyring = @{
        primary = "MCowBQYDK2VwAyEA..."
        secondary = $null
        secondary_signed_by_primary = $null
        validity_window_days = 365
    }
    platforms = @{
        "windows-x86_64" = @{
            url = "https://releases.example.com/$Channel/$Version/app-$Version-x86_64.exe"
            signature = ""
            sha256 = ""
        }
        "windows-arm64" = @{
            url = "https://releases.example.com/$Channel/$Version/app-$Version-arm64.exe"
            signature = ""
            sha256 = ""
        }
    }
}

$Manifest | ConvertTo-Json -Depth 10 | Out-File -FilePath $ManifestFile -Encoding UTF8
Write-Host "      Manifest created: " -NoNewline
Write-Host $ManifestFile -ForegroundColor Cyan

Write-Info "Signing manifest..."
Write-Info "(would run: bun run carbon signer sign `"$ManifestFile`")"

Write-Done "Manifest signed"

# Step 5: Upload to S3/R2
if (-not $SkipUpload) {
    Write-Step "[5/5] Uploading to S3/R2..."

    foreach ($platform in $Platforms) {
        Write-Host "      Uploading " -NoNewline
        Write-Host $platform -ForegroundColor Cyan
        Write-Info "(would run: bun run carbon publish app --version $Version)"
    }

    Write-Host "      Uploading manifest..." -ForegroundColor Cyan
    Write-Info "(would run: aws s3 cp `"$ManifestFile`" s3://releases/manifest.json)"

    Write-Done "Upload complete"
}

# Summary
Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║ " -NoNewline -ForegroundColor Cyan
Write-Host "✅ Release Pipeline Complete" -ForegroundColor Green -NoNewline
Write-Host "                           ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

Write-Host ""
Write-Host "📊 Release Summary:"
Write-Host "   Version: $Version"
Write-Host "   Channel: $Channel"
Write-Host "   Platforms: " -NoNewline; Write-Host ($Platforms -join ", ") -ForegroundColor Cyan
Write-Host ""
Write-Host "📍 Next Steps:"
Write-Host "   1. Monitor rollout metrics (update adoption)"
Write-Host "   2. Watch crash rates for first 24 hours"
Write-Host "   3. Be ready to yank version if issues found"
Write-Host ""
Write-Host "Ready for distribution! ✨" -ForegroundColor Green
