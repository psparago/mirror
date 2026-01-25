#!/bin/bash

# Initialize nvm if available
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Use Node 20 (required for this project)
nvm use 20 2>/dev/null || true

echo "📋 Looking Glass (LG) - Recent Builds"
echo "======================================"
cd "$(dirname "$0")/../../apps/cole"
npx eas build:list --limit 5

echo ""
echo ""
echo "📋 Looking Glass Companion (LG Companion) - Recent Builds"
echo "=========================================================="
cd "$(dirname "$0")/../../apps/companion"
npx eas build:list --limit 5

