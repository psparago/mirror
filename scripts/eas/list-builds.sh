#!/bin/bash

# Initialize nvm if npx is not available
if ! command -v npx &> /dev/null; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm use default 2>/dev/null || nvm use 20 2>/dev/null || true
fi

echo "📋 Looking Glass (LG) - Recent Builds"
echo "======================================"
cd "$(dirname "$0")/../../apps/cole"
npx eas-cli build:list --limit 5

echo ""
echo ""
echo "📋 Looking Glass Companion (LG Companion) - Recent Builds"
echo "=========================================================="
cd "$(dirname "$0")/../../apps/companion"
npx eas-cli build:list --limit 5

