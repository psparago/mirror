#!/bin/bash
set -e

# Initialize nvm if available
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Use Node 20 (required for this project)
nvm use 20 2>/dev/null || true

echo "🔨 Building Looking Glass (LG) - Development Build for iOS"
echo "This build includes the dev client for hot reload and debugging"
echo ""

cd "$(dirname "$0")/../../apps/cole"

npx eas build --profile development --platform ios --non-interactive

echo ""
echo "✅ Build submitted! Check status at: https://expo.dev/accounts/psparago/projects/mirror-cole/builds"
echo "📱 Once complete, share the URL with testers to install"

