#!/bin/bash
set -e

echo "🔨 Building Looking Glass (LG) - Development Build for iOS"
echo "This build includes the dev client for hot reload and debugging"
echo ""

cd "$(dirname "$0")/../../apps/cole"

npx eas build --profile development --platform ios --non-interactive

echo ""
echo "✅ Build submitted! Check status at: https://expo.dev/accounts/psparago/projects/mirror-cole/builds"
echo "📱 Once complete, share the URL with testers to install"

