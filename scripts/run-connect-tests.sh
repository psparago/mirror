#!/bin/bash
set -euo pipefail

# Initialize nvm if available
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Use Node 20 (required for this project)
nvm use 20 2>/dev/null || true

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

echo "🧪 Running Reflections Connect unit tests..."
npm test --workspace=reflections-connect "$@"
