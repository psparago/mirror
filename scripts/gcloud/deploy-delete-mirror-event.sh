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

gcloud functions deploy delete-mirror-event \
  --gen2 \
  --runtime=go125 \
  --region=us-central1 \
  --source="${SOURCE_DIR}" \
  --entry-point=DeleteMirrorEvent \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID},AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY},AWS_REGION=${AWS_REGION} \
  --quiet

