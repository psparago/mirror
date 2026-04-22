#!/usr/bin/env bash
set -eo pipefail

# Reflections Connect → Google Play **internal testing** track (production Android AAB + submit).
# Mirrors ship-to-testflight.sh; only Connect is supported here.
#
# Usage:
#   ./scripts/eas/ship-to-play-internal.sh
#   ./scripts/eas/ship-to-play-internal.sh connect
#
# Prerequisites (first time / if submit fails):
#   - Play Console app created; package com.psparago.reflections.connect
#   - EAS linked to Google Play: https://docs.expo.dev/submit/android/
#   - Service account / credentials configured for eas submit (dashboard or local key)

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

# --- PRE-FLIGHT CHECKLIST ---
echo "========================================================"
echo "STOP — PRE-FLIGHT (Avoid expensive mistakes)"
echo "========================================================"
echo ""
echo "1. [ ] VERSION BUMP? (apps/connect app.json expo.version)"
echo "       Marketing number if this release has new user-facing changes."
echo ""
echo "2. [ ] VERSION CODES? (EAS remote — autoIncrement is ON for production)"
echo ""
echo "3. [ ] GIT COMMITTED?"
echo "       EAS builds from git; uncommitted app.json changes are ignored."
echo "       Run: git status"
echo ""
echo "4. [ ] PLAY CONSOLE + EAS SUBMIT?"
echo "       eas.json submit.production.android → track internal"
echo "       Google Play service account linked for eas submit (see Expo docs)."
echo "========================================================"
echo ""
read -r -p "Continue? Press ENTER to build & submit, or Ctrl+C to abort..."

TARGET="${1:-connect}"
if [[ -n "$TARGET" && "$TARGET" != "connect" ]]; then
  echo "Usage: $0 [connect]"
  echo "  (default) connect — Reflections Connect only"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo ""
echo "Building Reflections Connect — Android production (AAB) + submit → Play internal"
echo ""

cd "$PROJECT_ROOT/apps/connect"
npx eas-cli build \
  --profile production \
  --platform android \
  --non-interactive \
  --auto-submit

echo ""
echo "Done. Build + submit queued; check:"
echo "  https://expo.dev/accounts/psparago/projects/reflections-connect/builds"
echo "Then Play Console → Testing → Internal testing for the new release."
