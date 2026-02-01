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
echo "2. [ ] BUILD NUMBER is remote?
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

echo ""
echo "🚀 Building ALL Apps for TestFlight (Production)"
echo ""

# Save the script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/../.."

# --- BUILD Explorer (COLE) ---
echo "🔨 Building Reflections Explorer..."
cd "$PROJECT_ROOT/apps/explorer"
# FIX: Use 'npx eas-cli' explicitly to avoid ambiguous binary errors
npx eas-cli build \
  --profile production \
  --platform ios \
  --non-interactive \
  --auto-submit

echo ""

# --- BUILD Connect ---
echo "🔨 Building Reflections Connect..."
cd "$PROJECT_ROOT/apps/connect"

# FIX: Replaced undefined $EAS_CMD with explicit 'npx eas-cli'
npx eas-cli build \
  --profile production \
  --platform ios \
  --non-interactive \
  --auto-submit

echo ""
echo "✅ Builds queued! They will appear in TestFlight automatically."
