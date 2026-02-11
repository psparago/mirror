#!/bin/bash
set -e

# Initialize nvm if npx is not available
if ! command -v npx &> /dev/null; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  nvm use default 2>/dev/null || nvm use 20 2>/dev/null || true
fi

# --- PRE-FLIGHT CHECKLIST ---
echo "========================================================"
echo "🛑 STOP! PRE-FLIGHT CHECKLIST (Avoid Expensive Errors)"
echo "========================================================"
echo ""
echo "1. [ ] VERSION BUMP? (app.json 'version')"
echo "       Marketing number (e.g., 1.0.2 -> 1.0.3) if releasing new features."
echo ""
echo "2. [ ] BUILD NUMBER? (managed remotely by EAS - autoIncrement is ON)"
echo ""
echo "3. [ ] GIT COMMITTED?"
echo "       EAS builds from git. Uncommitted changes in app.json are IGNORED."
echo "       Run 'git status' to be sure."
echo ""
echo "4. [ ] CONFIG CHECK?"
echo "       eas.json has correct IDs? updates configured?"
echo "========================================================"
echo ""
read -p "⚠️  Have you verified ALL of the above? Press [ENTER] to ship or [Ctrl+C] to abort..."

# Parse argument: explorer | connect | (empty = both)
TARGET="${1:-}"
if [[ -n "$TARGET" && "$TARGET" != "explorer" && "$TARGET" != "connect" ]]; then
  echo "Usage: $0 [explorer|connect]"
  echo "  explorer - build and ship Reflections Explorer only"
  echo "  connect  - build and ship Reflections Connect only"
  echo "  (none)   - build and ship both apps"
  exit 1
fi

# Save the script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."

build_explorer() {
  echo "🔨 Building Reflections Explorer..."
  cd "$PROJECT_ROOT/apps/explorer"
  npx eas-cli build \
    --profile production \
    --platform ios \
    --non-interactive \
    --auto-submit
  echo ""
}

build_connect() {
  echo "🔨 Building Reflections Connect..."
  cd "$PROJECT_ROOT/apps/connect"
  npx eas-cli build \
    --profile production \
    --platform ios \
    --non-interactive \
    --auto-submit
  echo ""
}

echo ""
if [[ -z "$TARGET" ]]; then
  echo "🚀 Building BOTH apps for TestFlight (Production)"
else
  echo "🚀 Building $TARGET for TestFlight (Production)"
fi
echo ""

case "$TARGET" in
  explorer) build_explorer ;;
  connect)  build_connect ;;
  *)       build_explorer; build_connect ;;
esac

echo "✅ Builds queued! They will appear in TestFlight automatically."
