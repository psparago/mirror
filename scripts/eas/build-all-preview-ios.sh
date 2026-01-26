#!/bin/bash
set -e

# Initialize nvm if npx is not available
if ! command -v npx &> /dev/null; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm use default 2>/dev/null || nvm use 20 2>/dev/null || true
fi

echo "📦 Building ALL Looking Glass Apps - Preview Builds for iOS"
echo "Building both Looking Glass (LG) and Looking Glass Companion (LG Companion)"
echo ""

# Save the script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."

# Build LG
echo "🔨 Building Looking Glass (LG)..."
cd "$PROJECT_ROOT/apps/cole"
npx eas-cli build --profile preview --platform ios --non-interactive

echo ""
echo "🔨 Building Looking Glass Companion (LG Companion)..."
cd "$PROJECT_ROOT/apps/companion"
npx eas-cli build --profile preview --platform ios --non-interactive

echo ""
echo "✅ Both builds submitted!"
echo "📱 LG: https://expo.dev/accounts/psparago/projects/mirror-cole/builds"
echo "📱 LG Companion: https://expo.dev/accounts/psparago/projects/mirror-companion/builds"

