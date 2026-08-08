#!/usr/bin/env bash
# macOS Code Signing (Gatekeeper + Notarization)
# Usage: ./sign-macos.sh <file>
# Requires: CARBON_DEVELOPER_ID (Team ID), codesign, notarytool

set -euo pipefail

FILE="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CARBON_TOML="$PROJECT_DIR/carbon.toml"

if [ ! -f "$FILE" ] && [ ! -d "$FILE" ]; then
    echo "❌ File or directory not found: $FILE"
    exit 1
fi

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
GRAY='\033[0;90m'
NC='\033[0m'

echo -e "${BLUE}🍎 macOS Code Signing (Gatekeeper)${NC}"
echo -e "${BLUE}====================================${NC}"

# Check if custom sign_command exists in carbon.toml
if [ -f "$CARBON_TOML" ]; then
    SIGN_COMMAND=$(sed -n '/\[signer\.macos\]/,/\[/p' "$CARBON_TOML" | grep 'sign_command' | sed 's/.*sign_command[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/' || true)
    if [ -n "$SIGN_COMMAND" ]; then
        echo -e "${GRAY}[carbon.toml] Using custom sign_command${NC}"
        SIGN_COMMAND="${SIGN_COMMAND//\$FILE/$FILE}"
        eval "$SIGN_COMMAND"
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✅ Signed successfully${NC}"
            exit 0
        else
            echo -e "${RED}❌ Signing failed${NC}"
            exit 1
        fi
    fi
fi

# Use codesign if no custom command
DEVELOPER_ID="${CARBON_DEVELOPER_ID:-}"
ENTITLEMENTS="${CARBON_ENTITLEMENTS:-$PROJECT_DIR/scripts/macos-entitlements.plist}"

if [ -z "$DEVELOPER_ID" ]; then
    echo -e "${RED}❌ CARBON_DEVELOPER_ID not set${NC}"
    exit 1
fi

echo -e "${BLUE}🔐 Signing with identity: $DEVELOPER_ID${NC}"

if [ -d "$FILE" ]; then
    # Signing .app bundle (bottom-up)
    echo "📦 Signing .app bundle: $(basename "$FILE")"

    # Sign frameworks and dylibs first
    find "$FILE/Contents/Frameworks" -name "*.dylib" -o -name "*.framework" | while read -r lib; do
        echo "  Signing: $lib"
        codesign --force --options runtime --timestamp \
            --sign "$DEVELOPER_ID" "$lib" 2>/dev/null || true
    done

    # Sign the main binary
    MAIN_BINARY="$FILE/Contents/MacOS/$(basename "$FILE" .app)"
    if [ -f "$MAIN_BINARY" ]; then
        echo "  Signing main binary..."
        if [ -f "$ENTITLEMENTS" ]; then
            codesign --force --options runtime --timestamp \
                --sign "$DEVELOPER_ID" \
                --entitlements "$ENTITLEMENTS" \
                "$MAIN_BINARY"
        else
            codesign --force --options runtime --timestamp \
                --sign "$DEVELOPER_ID" \
                "$MAIN_BINARY"
        fi
    fi

    # Sign the .app bundle itself
    echo "  Signing .app bundle..."
    codesign --force --verify --verbose \
        --sign "$DEVELOPER_ID" \
        "$FILE"
else
    # Signing single executable
    echo "📁 Signing executable: $(basename "$FILE")"
    codesign --force --options runtime --timestamp \
        --sign "$DEVELOPER_ID" \
        "$FILE"
fi

# Verify signature
echo "✓ Verifying signature..."
codesign --verify --strict --verbose "$FILE"

echo -e "${GREEN}✅ Code signing complete${NC}"
echo ""
echo "Next step: Run notarization"
echo "  ./notarize-poll.sh $FILE"
