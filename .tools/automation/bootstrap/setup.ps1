# Carbon Native V2 - PowerShell Toolchain & Environment Bootstrap Script

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Carbon Native V2 Environment Setup (Win) " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

function Check-Command($cmd, $name) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        $ver = & $cmd --version 2>&1 | Select-Object -First 1
        Write-Host "[OK] $name found: $ver" -ForegroundColor Green
    } else {
        Write-Host "[WARNING] $name ($cmd) not found in PATH." -ForegroundColor Yellow
    }
}

Write-Host "`nChecking core build toolchains..." -ForegroundColor White
Check-Command "bazel" "Bazel Build System"
Check-Command "clang" "LLVM Clang Compiler"
Check-Command "rustc" "Rust Compiler"
Check-Command "zig" "Zig Compiler"
Check-Command "go" "Go Compiler"
Check-Command "flatc" "FlatBuffers Compiler"
Check-Command "node" "Node.js Runtime"
Check-Command "dotnet" ".NET SDK"

Write-Host "`nWorkspace bootstrap completed." -ForegroundColor Cyan
