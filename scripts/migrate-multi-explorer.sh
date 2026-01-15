#!/bin/bash
# Multi-Explorer Migration Script
# Migrates legacy Firestore signals to the new multi-tenant structure
# Usage: ./scripts/migrate-multi-explorer.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/scripts/gcloud/.env.deploy"

echo "🔄 Project Mirror - Firestore Migration Tool"
echo "============================================"

if [ ! -f "$ENV_FILE" ]; then
    echo "❌ Error: .env.deploy not found at $ENV_FILE"
    echo "This is needed for GOOGLE_CLOUD_PROJECT variable."
    exit 1
fi

# Load env vars
set -a
source "$ENV_FILE"
set +a

# Set GOOGLE_CLOUD_PROJECT if not already set (fallback)
if [ -z "$GOOGLE_CLOUD_PROJECT" ]; then
    export GOOGLE_CLOUD_PROJECT="project-mirror-23168"
fi

# Navigate to the functions directory
cd "${PROJECT_ROOT}/backend/gcloud/functions"

# Run the migration tool
echo "📡 Running migration on project: $GOOGLE_CLOUD_PROJECT"
go run cmd/migration/main.go
