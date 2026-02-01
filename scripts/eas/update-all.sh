#!/bin/bash
set -e

# Initialize nvm if npx is not available
if ! command -v npx &> /dev/null; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm use default 2>/dev/null || nvm use 20 2>/dev/null || true
fi

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
echo "🔵 Updating Reflections Explorer..."
echo "=========================================="
cd "$PROJECT_ROOT/apps/explorer"
npx eas update --branch "$BRANCH" --message "$MESSAGE"

echo ""
echo "=========================================="
echo "🟢 Updating Reflections Connect..."
echo "=========================================="
cd "$PROJECT_ROOT/apps/connect"
npx eas update --branch "$BRANCH" --message "$MESSAGE"

echo ""
echo "✅ All updates published to '$BRANCH' branch!"
