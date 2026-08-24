#!/usr/bin/env bash
# macOS Notarization Submission and Polling
# Usage: ./notarize-poll.sh <file>
# Environment: CARBON_APPLE_ID, CARBON_APP_PASSWORD, CARBON_TEAM_ID

set -euo pipefail

FILE="${1:-.}"

if [ ! -f "$FILE" ] && [ ! -d "$FILE" ]; then
    echo "❌ File or directory not found: $FILE"
    exit 1
fi

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
GRAY='\033[0;90m'
NC='\033[0m'

echo -e "${BLUE}🍎 macOS Notarization${NC}"
echo -e "${BLUE}=====================${NC}"

# Get credentials from environment
APPLE_ID="${CARBON_APPLE_ID:-}"
APP_PASSWORD="${CARBON_APP_PASSWORD:-}"
TEAM_ID="${CARBON_TEAM_ID:-}"

if [ -z "$APPLE_ID" ] || [ -z "$APP_PASSWORD" ] || [ -z "$TEAM_ID" ]; then
    echo -e "${RED}❌ Missing credentials:${NC}"
    [ -z "$APPLE_ID" ] && echo "  - CARBON_APPLE_ID"
    [ -z "$APP_PASSWORD" ] && echo "  - CARBON_APP_PASSWORD"
    [ -z "$TEAM_ID" ] && echo "  - CARBON_TEAM_ID"
    exit 1
fi

echo -e "${BLUE}📤 Submitting for notarization: $(basename "$FILE")${NC}"
echo -e "${GRAY}Apple ID: $APPLE_ID${NC}"
echo -e "${GRAY}Team ID: $TEAM_ID${NC}"

# Create temporary archive for notarization
ARCHIVE_PATH="/tmp/$(basename "$FILE").zip"
if [ -d "$FILE" ]; then
    ditto -c -k --sequesterRsrc "$FILE" "$ARCHIVE_PATH"
    NOTARIZE_FILE="$ARCHIVE_PATH"
else
    NOTARIZE_FILE="$FILE"
fi

echo "⏳ Submitting to Apple Notary Service..."

# Submit for notarization
SUBMIT_OUTPUT=$(xcrun notarytool submit "$NOTARIZE_FILE" \
    --apple-id "$APPLE_ID" \
    --password "$APP_PASSWORD" \
    --team-id "$TEAM_ID" \
    --output-format json 2>/dev/null)

REQUEST_UUID=$(echo "$SUBMIT_OUTPUT" | jq -r '.id' 2>/dev/null || echo "")

if [ -z "$REQUEST_UUID" ] || [ "$REQUEST_UUID" = "null" ]; then
    echo -e "${RED}❌ Failed to submit for notarization${NC}"
    echo "$SUBMIT_OUTPUT" | jq '.' 2>/dev/null || echo "$SUBMIT_OUTPUT"
    exit 1
fi

echo -e "${GREEN}✅ Submitted successfully${NC}"
echo -e "${GRAY}Request ID: $REQUEST_UUID${NC}"

# Clean up archive if created
if [ "$NOTARIZE_FILE" != "$FILE" ]; then
    rm -f "$ARCHIVE_PATH"
fi

echo ""
echo -e "${BLUE}⏳ Polling for notarization status...${NC}"
echo "   (This typically takes 5-10 minutes)"

# Poll for notarization status
MAX_ATTEMPTS=120
ATTEMPT=0
POLL_INTERVAL=30

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    STATUS=$(xcrun notarytool info "$REQUEST_UUID" \
        --apple-id "$APPLE_ID" \
        --password "$APP_PASSWORD" \
        --team-id "$TEAM_ID" \
        --output-format json | jq -r '.status')

    case "$STATUS" in
        Accepted)
            echo -e "${GREEN}✅ Notarization Accepted!${NC}"
            echo -e "${BLUE}📍 Stapling ticket...${NC}"

            # Staple the ticket to the file
            if [ -d "$FILE" ]; then
                xcrun stapler staple "$FILE"
            else
                xcrun stapler staple "$FILE"
            fi

            echo -e "${GREEN}✅ Notarization complete and stapled${NC}"
            echo ""
            echo "File is ready for distribution!"
            exit 0
            ;;

        Rejected)
            echo -e "${RED}❌ Notarization Rejected${NC}"

            # Fetch rejection details
            DETAILS=$(xcrun notarytool log "$REQUEST_UUID" \
                --apple-id "$APPLE_ID" \
                --password "$APP_PASSWORD" \
                --team-id "$TEAM_ID" 2>/dev/null || echo "")

            if [ -n "$DETAILS" ]; then
                echo "Details:"
                echo "$DETAILS" | jq '.' 2>/dev/null || echo "$DETAILS"
            fi
            exit 1
            ;;

        In\ Progress)
            ELAPSED=$((ATTEMPT * POLL_INTERVAL))
            echo -e "${YELLOW}⏳ Processing... (${ELAPSED}s elapsed)${NC}"
            ;;

        *)
            echo -e "${GRAY}Status: $STATUS (attempt $((ATTEMPT + 1))/$MAX_ATTEMPTS)${NC}"
            ;;
    esac

    sleep $POLL_INTERVAL
    ATTEMPT=$((ATTEMPT + 1))
done

echo -e "${RED}❌ Notarization timed out after $((ATTEMPT * POLL_INTERVAL)) seconds${NC}"
exit 1
