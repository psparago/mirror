#!/bin/bash
set -e

# Initialize nvm if npx is not available
if ! command -v npx &> /dev/null; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm use default 2>/dev/null || nvm use 20 2>/dev/null || true
fi

echo "📦 Building Looking Glass (LG) - Preview Build for iOS"
echo "This build is optimized for internal distribution to family devices"
echo ""

cd "$(dirname "$0")/../../apps/cole"

npx eas-cli build --profile preview --platform ios --non-interactive

echo ""
echo "✅ Build submitted! Check status at: https://expo.dev/accounts/psparago/projects/mirror-cole/builds"
echo "📱 Once complete, share the URL with your family to install on their devices"

