#!/bin/bash

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

