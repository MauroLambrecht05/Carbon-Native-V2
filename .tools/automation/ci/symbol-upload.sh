#!/usr/bin/env bash
# Symbol/debug info upload script
# Usage: ./symbol-upload.sh <binary> [symbol_server_url]

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <binary> [symbol_server_url]"
  exit 1
fi

BINARY="$1"
SYMBOL_SERVER="${2:-$SYMBOL_SERVER_URL}"

if [ ! -f "$BINARY" ]; then
  echo "Error: Binary not found: $BINARY"
  exit 1
fi

BINARY_NAME=$(basename "$BINARY")
BUILD_ID=$(file "$BINARY" | grep -o 'BuildID[^,]*' || echo "unknown")

echo "[symbol-upload] Binary: $BINARY"
echo "[symbol-upload] Build ID: $BUILD_ID"

# Extract debug symbols based on platform
if [ "$(uname)" = "Darwin" ]; then
  # macOS: use dsymutil to extract dSYM
  DSYM_FILE="${BINARY}.dSYM"
  echo "[symbol-upload] Extracting dSYM: $DSYM_FILE"
  dsymutil -o "$DSYM_FILE" "$BINARY"
  SYMBOLS_FILE="$DSYM_FILE"
elif command -v objcopy &> /dev/null; then
  # Linux: use objcopy to extract debug section
  SYMBOLS_FILE="${BINARY}.debug"
  echo "[symbol-upload] Extracting debug info: $SYMBOLS_FILE"
  objcopy --only-keep-debug "$BINARY" "$SYMBOLS_FILE"
elif [ "$(uname)" = "MINGW64_NT" ] || [ "$(uname)" = "MSYS_NT" ]; then
  # Windows: PDB file might already exist
  SYMBOLS_FILE="${BINARY%.exe}.pdb"
  if [ ! -f "$SYMBOLS_FILE" ]; then
    echo "[symbol-upload] Warning: No PDB file found at $SYMBOLS_FILE"
    exit 0
  fi
else
  echo "[symbol-upload] No symbol extraction supported for this platform"
  exit 0
fi

if [ -z "$SYMBOL_SERVER" ]; then
  echo "[symbol-upload] No symbol server URL configured, skipping upload"
  exit 0
fi

# Upload to symbol server
UPLOAD_URL="${SYMBOL_SERVER}/${BINARY_NAME}/${BUILD_ID}/${BINARY_NAME}"

echo "[symbol-upload] Uploading to: $UPLOAD_URL"

if command -v curl &> /dev/null; then
  curl -X POST \
    -F "file=@$SYMBOLS_FILE" \
    "$UPLOAD_URL" || echo "[symbol-upload] Warning: Upload failed, continuing"
else
  echo "[symbol-upload] Warning: curl not found, skipping upload"
fi

echo "[symbol-upload] Symbol upload complete"
