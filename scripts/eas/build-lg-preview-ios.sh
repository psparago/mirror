#!/bin/bash
set -e

echo "📦 Building Looking Glass (LG) - Preview Build for iOS"
echo "This build is optimized for internal distribution to family devices"
echo ""

cd "$(dirname "$0")/../../apps/cole"

npx eas build --profile preview --platform ios --non-interactive

echo ""
echo "✅ Build submitted! Check status at: https://expo.dev/accounts/psparago/projects/mirror-cole/builds"
echo "📱 Once complete, share the URL with your family to install on their devices"

