#!/bin/bash
# Load AWS credentials from .env.deploy file
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.deploy"
SOURCE_DIR="${PROJECT_ROOT}/backend/gcloud/functions"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env.deploy file not found!"
  echo "Please copy .env.deploy.example to .env.deploy and add your credentials."
  exit 1
fi

if [ ! -f "${SOURCE_DIR}/go.mod" ]; then
  echo "Error: go.mod not found in ${SOURCE_DIR}"
  exit 1
fi

source "$ENV_FILE"

echo "🚀 Deploying $FUNCTION_NAME to Google Cloud..."

gcloud functions deploy $FUNCTION_NAME \
  --gen2 \
  --runtime=$RUNTIME \
  --region=$REGION \
  --source="${SOURCE_DIR}" \
  --entry-point=$ENTRY_POINT \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars UNSPLASH_ACCESS_KEY=$UNSPLASH_KEY \
  --project=$PROJECT_ID \
  --quiet

echo "✅ Deployment complete!"