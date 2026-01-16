#!/bin/bash
set -e

echo "🚀 Building ALL Apps for TestFlight (Production)"
echo ""

# Save the script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."

# Build LG (Cole)
echo "🔨 Building Looking Glass (LG)..."
cd "$PROJECT_ROOT/apps/cole"
npx eas build \
  --profile production \
  --platform ios \
  --non-interactive \
  --auto-submit

echo ""

# Build Companion
echo "🔨 Building Looking Glass Companion..."
cd "$PROJECT_ROOT/apps/companion"
npx eas build \
  --profile production \
  --platform ios \
  --non-interactive \
  --auto-submit

echo ""
echo "✅ Builds queued! They will appear in TestFlight automatically."