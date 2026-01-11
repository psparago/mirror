#!/bin/bash
# Deploy get-batch-s3-upload-urls Cloud Function
# Loads AWS credentials from .env.deploy file

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.deploy"
SOURCE_DIR="${PROJECT_ROOT}/backend/gcloud/functions"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

if [ ! -f "$ENV_FILE" ]; then
  echo -e "${RED}Error: .env.deploy file not found!${NC}"
  echo "Please copy .env.deploy.example to .env.deploy and add your credentials."
  exit 1
fi

if [ ! -f "${SOURCE_DIR}/go.mod" ]; then
  echo -e "${RED}Error: go.mod not found in ${SOURCE_DIR}${NC}"
  exit 1
fi

source "$ENV_FILE"

# Verify required environment variables are set
if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ] || [ -z "$AWS_REGION" ]; then
  echo -e "${RED}Error: AWS credentials not found in .env.deploy${NC}"
  echo "Required: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION"
  exit 1
fi

echo -e "${YELLOW}Deploying get-batch-s3-upload-urls...${NC}"

gcloud functions deploy get-batch-s3-upload-urls \
  --gen2 \
  --runtime=go125 \
  --region=us-central1 \
  --source="${SOURCE_DIR}" \
  --entry-point=GetBatchS3UploadURLs \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID},AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY},AWS_REGION=${AWS_REGION} \
  --quiet

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ get-batch-s3-upload-urls deployed successfully${NC}"
else
  echo -e "${RED}✗ get-batch-s3-upload-urls deployment failed${NC}"
  exit 1
fi
