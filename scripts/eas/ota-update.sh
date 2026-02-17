#!/bin/bash
set -e

# Initialize nvm if npx is not available
if ! command -v npx &> /dev/null; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm use default 2>/dev/null || nvm use 20 2>/dev/null || true
fi

# Parse argument: explorer | connect | (empty = both)
TARGET="${1:-}"
if [[ -n "$TARGET" && "$TARGET" != "explorer" && "$TARGET" != "connect" ]]; then
  echo "Usage: $0 [explorer|connect]"
  echo "  explorer - OTA update Reflections Explorer only"
  echo "  connect  - OTA update Reflections Connect only"
  echo "  (none)   - OTA update both apps"
  exit 1
fi

# Save the script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."

# EAS update channel (named "prod" in EAS — not a git branch)
UPDATE_CHANNEL="prod"

update_explorer() {
  echo "🔵 Publishing OTA for Reflections Explorer..."
  cd "$PROJECT_ROOT/apps/explorer"
  npx eas update --branch "$UPDATE_CHANNEL" --message "$MESSAGE"
  echo ""
}

update_connect() {
  echo "🟢 Publishing OTA for Reflections Connect..."
  cd "$PROJECT_ROOT/apps/connect"
  npx eas update --branch "$UPDATE_CHANNEL" --message "$MESSAGE"
  echo ""
}

# Single prompt for message (used for one or both apps)
read -p "📝 Enter update message (or press Enter for default): " MESSAGE
MESSAGE="${MESSAGE:-Memory and performance improvements}"

echo ""
if [[ -z "$TARGET" ]]; then
  echo "📡 Publishing OTA updates for BOTH apps"
else
  echo "📡 Publishing OTA update for $TARGET"
fi
echo ""

case "$TARGET" in
  explorer) update_explorer ;;
  connect)  update_connect ;;
  *)        update_explorer; update_connect ;;
esac

echo "✅ OTA update(s) published!"
echo "📱 Devices on the prod channel will receive the update automatically."
