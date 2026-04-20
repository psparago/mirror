#!/usr/bin/env bash
set -eo pipefail

# Resolve repo paths from this script's location (works from any cwd; avoids
# broken relative cd when $0 is a relative path and cwd is not the repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONNECT_DIR="$REPO_ROOT/apps/connect"

# Initialize nvm if npx is not available
if ! command -v npx &> /dev/null; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm use default 2>/dev/null || nvm use 20 2>/dev/null || true
fi

if ! command -v npx &> /dev/null; then
  echo "error: npx not found. Install Node.js or configure nvm." >&2
  exit 1
fi

echo "🔨 Building Reflections Connect - Development Build for Android"
echo "This build includes the dev client for hot reload and debugging"
echo ""
echo "→ $CONNECT_DIR"
echo ""

cd "$CONNECT_DIR"

# --yes: non-interactive npx install of eas-cli when not already present
npx --yes eas-cli build --profile development --platform android --non-interactive

echo ""
echo "✅ Build submitted! Check status at: https://expo.dev/accounts/psparago/projects/reflections-connect/builds"
echo "📱 Once complete, use the Expo dashboard install link or download the artifact for your device"
