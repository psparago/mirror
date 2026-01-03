#!/bin/bash
set -e

echo "🔨 Building ALL Looking Glass Apps - Development Builds for iOS"
echo "Building both Looking Glass (LG) and Looking Glass Companion (LG Companion)"
echo "These builds include the dev client for hot reload and debugging"
echo ""

# Save the script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."

# Build LG
echo "🔨 Building Looking Glass (LG) Development..."
cd "$PROJECT_ROOT/apps/cole"
npx eas build --profile development --platform ios --non-interactive

echo ""
echo "🔨 Building Looking Glass Companion (LG Companion) Development..."
cd "$PROJECT_ROOT/apps/companion"
npx eas build --profile development --platform ios --non-interactive

echo ""
echo "✅ Both development builds submitted!"
echo "📱 LG: https://expo.dev/accounts/psparago/projects/mirror-cole/builds"
echo "📱 LG Companion: https://expo.dev/accounts/psparago/projects/mirror-companion/builds"
echo ""
echo "💡 Once installed, you can use Fast Refresh for instant updates without rebuilding!"

