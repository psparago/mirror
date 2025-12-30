#!/bin/bash
# Load AWS credentials from .env.deploy file
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.deploy"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env.deploy file not found!"
  echo "Please copy .env.deploy.example to .env.deploy and add your credentials."
  exit 1
fi

source "$ENV_FILE"

gcloud functions deploy list-mirror-photos \
  --gen2 \
  --runtime=go125 \
  --region=us-central1 \
  --source=. \
  --entry-point=ListMirrorPhotos \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID},AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY},AWS_REGION=${AWS_REGION} \
  --quiet

