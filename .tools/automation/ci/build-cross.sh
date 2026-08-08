#!/usr/bin/env bash
# Cross-compile carbon-mini for multiple targets using cargo-zigbuild
# Usage: ./build-cross.sh <target-triple>
# Example: ./build-cross.sh x86_64-pc-windows-gnu

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <target-triple>"
  echo "Example: $0 x86_64-pc-windows-gnu"
  exit 1
fi

TARGET="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Set SOURCE_DATE_EPOCH for reproducible builds
export SOURCE_DATE_EPOCH=$(git -C "$PROJECT_DIR" log -1 --pretty=%ct)

echo "[build-cross] Target: $TARGET"
echo "[build-cross] Source date epoch: $SOURCE_DATE_EPOCH"

cd "$PROJECT_DIR"

cargo zigbuild --release \
  --target "$TARGET" \
  --manifest-path "$PROJECT_DIR/.config/rust/Cargo.toml" \
  -p carbon-runtime \
  --bin carbon-mini \
  --no-default-features \
  --features mini,snapshot \
  -Z unstable-options \
  --build-override-dir "$PROJECT_DIR/.cargo"

echo "[build-cross] Build complete: $TARGET"
