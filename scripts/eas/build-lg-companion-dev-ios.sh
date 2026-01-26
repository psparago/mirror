#!/bin/bash
set -e

# Initialize nvm if npx is not available
if ! command -v npx &> /dev/null; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm use default 2>/dev/null || nvm use 20 2>/dev/null || true
fi

echo "🔨 Building Looking Glass Companion (LG Companion) - Development Build for iOS"
echo "This build includes the dev client for hot reload and debugging"
echo ""

cd "$(dirname "$0")/../../apps/companion"

npx eas-cli build --profile development --platform ios --non-interactive

echo ""
echo "✅ Build submitted! Check status at: https://expo.dev/accounts/psparago/projects/mirror-companion/builds"
echo "📱 Once complete, share the URL with testers to install"

