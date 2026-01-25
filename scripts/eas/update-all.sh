#!/bin/bash
set -e

# Default branch is prod, can override with first argument
BRANCH="${1:-prod}"

echo "📡 Publishing OTA Updates for ALL Apps"
echo "   Branch: $BRANCH"
echo ""

# Save the script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."

# Prompt for update message once
read -p "📝 Enter update message (or press Enter for default): " MESSAGE
MESSAGE="${MESSAGE:-Memory and performance improvements}"

echo ""
echo "=========================================="
echo "🔵 Updating Looking Glass Explorer..."
echo "=========================================="
cd "$PROJECT_ROOT/apps/cole"
npx eas update --branch "$BRANCH" --message "$MESSAGE"

echo ""
echo "=========================================="
echo "🟢 Updating Looking Glass Companion..."
echo "=========================================="
cd "$PROJECT_ROOT/apps/companion"
npx eas update --branch "$BRANCH" --message "$MESSAGE"

echo ""
echo "✅ All updates published to '$BRANCH' branch!"
