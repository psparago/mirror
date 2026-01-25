#!/bin/bash
set -e

# Initialize nvm if available
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Use Node 20 (required for this project)
nvm use 20 2>/dev/null || true

# Default branch is prod, can override with first argument
BRANCH="${1:-prod}"

echo "📡 Publishing OTA Update for Looking Glass Companion"
echo "   Branch: $BRANCH"
echo ""

# Save the script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."

cd "$PROJECT_ROOT/apps/companion"

# Prompt for update message
read -p "📝 Enter update message (or press Enter for default): " MESSAGE
MESSAGE="${MESSAGE:-Memory and performance improvements}"

echo ""
echo "🚀 Publishing update..."
echo ""

npx eas update --branch "$BRANCH" --message "$MESSAGE"

echo ""
echo "✅ Update published to '$BRANCH' branch!"
echo "📱 Devices on this branch will receive the update automatically."
