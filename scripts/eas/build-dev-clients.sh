#!/bin/bash
set -e

# Initialize nvm if available
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Use Node 20 (required for this project)
nvm use 20 2>/dev/null || true

echo "🛠️  Building Development Clients (Simulator & Physical Device)"
echo "This enables you to code without overwriting the TestFlight apps."
echo ""

# Save the script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."

# Build LG Dev
echo "🔨 Building LG Dev..."
cd "$PROJECT_ROOT/apps/cole"
npx eas build --profile development --platform ios --non-interactive

# Build Companion Dev
echo ""
echo "🔨 Building Companion Dev..."
cd "$PROJECT_ROOT/apps/companion"
npx eas build --profile development --platform ios --non-interactive

echo ""
echo "✅ Dev builds queued!"