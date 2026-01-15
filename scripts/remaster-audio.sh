#!/bin/bash
# Remaster Audio Backfill Wrapper
# Loads credentials from scripts/gcloud/.env.deploy and runs the Go remaster tool

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/scripts/gcloud/.env.deploy"

echo "🎨 Project Mirror - Audio Remastering Tool"
echo "=========================================="

if [ ! -f "$ENV_FILE" ]; then
    echo "❌ Error: .env.deploy not found at $ENV_FILE"
    exit 1
fi

# Load env vars (exporting them so the Go script can see them)
set -a
source "$ENV_FILE"
set +a

# Allow overriding Explorer ID via command line argument
if [ ! -z "$1" ]; then
    export EXPLORER_ID="$1"
    echo "👤 Processing Explorer: $EXPLORER_ID"
else
    echo "👤 Processing Default Explorer: ${EXPLORER_ID:-cole}"
fi

# Navigate to the functions directory where go.mod lives
cd "${PROJECT_ROOT}/backend/gcloud/functions"

# Run the remaster tool
go run cmd/remaster/main.go

