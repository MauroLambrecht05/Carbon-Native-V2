#!/usr/bin/env bash
# Carbon Native V2 - Bash Environment Bootstrap Script
set -e

echo "=========================================="
echo " Carbon Native V2 Environment Setup (Unix)"
echo "=========================================="

check_cmd() {
    if command -v "$1" >/dev/null 2>&1; then
        echo -e "\033[0;32m[OK]\033[0m $2 found: $($1 --version 2>&1 | head -n 1)"
    else
        echo -e "\033[0;33m[WARN]\033[0m $2 ($1) not found in PATH."
    fi
}

echo ""
echo "Checking core build toolchains..."
check_cmd bazel "Bazel Build System"
check_cmd clang "LLVM Clang Compiler"
check_cmd rustc "Rust Compiler"
check_cmd zig "Zig Compiler"
check_cmd go "Go Compiler"
check_cmd flatc "FlatBuffers Compiler"
check_cmd node "Node.js Runtime"
check_cmd dotnet ".NET SDK"

echo ""
echo "Workspace bootstrap completed."
