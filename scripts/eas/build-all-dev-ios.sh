#!/bin/bash
set -e

# Initialize nvm if npx is not available
if ! command -v npx &> /dev/null; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm use default 2>/dev/null || nvm use 20 2>/dev/null || true
fi

echo "🔨 Building ALL Reflections Apps - Development Builds for iOS"
echo "Building both Reflections Explorer and Reflections Connect"
echo "These builds include the dev client for hot reload and debugging"
echo ""

# Save the script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."

# Build Reflections Explorer
echo "🔨 Building Reflections Explorer Development..."
cd "$PROJECT_ROOT/apps/cole"
npx eas-cli build --profile development --platform ios --non-interactive

echo ""
echo "🔨 Building Reflections Connect Development..."
cd "$PROJECT_ROOT/apps/companion"
npx eas-cli build --profile development --platform ios --non-interactive

echo ""
echo "✅ Both development builds submitted!"
echo "📱 LG: https://expo.dev/accounts/psparago/projects/mirror-cole/builds"
echo "📱 LG Companion: https://expo.dev/accounts/psparago/projects/mirror-companion/builds"
echo ""
echo "💡 Once installed, you can use Fast Refresh for instant updates without rebuilding!"

