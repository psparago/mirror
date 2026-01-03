#!/bin/bash
set -e

echo "📦 Building Looking Glass Companion (LG Companion) - Preview Build for iOS"
echo "This build is optimized for internal distribution to family devices"
echo ""

cd "$(dirname "$0")/../../apps/companion"

npx eas build --profile preview --platform ios --non-interactive

echo ""
echo "✅ Build submitted! Check status at: https://expo.dev/accounts/psparago/projects/mirror-companion/builds"
echo "📱 Once complete, share the URL with your family to install on their devices"

