#!/bin/bash
# Deploy all Cloud Functions for Project Mirror
# Loads AWS credentials from .env.deploy and deploys all three functions sequentially

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.deploy"
SOURCE_DIR="${PROJECT_ROOT}/backend/s3-signer"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Project Mirror - Deploy All Cloud Functions${NC}"
echo "=========================================="

# Check for .env.deploy file
if [ ! -f "$ENV_FILE" ]; then
  echo -e "${RED}Error: .env.deploy file not found!${NC}"
  echo "Please copy .env.deploy.example to .env.deploy and add your credentials."
  exit 1
fi

# Check for go.mod
if [ ! -f "${SOURCE_DIR}/go.mod" ]; then
  echo -e "${RED}Error: go.mod not found in ${SOURCE_DIR}${NC}"
  exit 1
fi

# Load environment variables
source "$ENV_FILE"

# Verify required environment variables are set
if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ] || [ -z "$AWS_REGION" ]; then
  echo -e "${RED}Error: AWS credentials not found in .env.deploy${NC}"
  echo "Required: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION"
  exit 1
fi

echo -e "${GREEN}✓ Environment variables loaded${NC}"
echo ""

# Common deployment parameters
REGION="us-central1"
RUNTIME="go125"
ENV_VARS="AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID},AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY},AWS_REGION=${AWS_REGION}"

# Function 1: get-s3-url
echo -e "${YELLOW}Deploying get-s3-url...${NC}"
gcloud functions deploy get-s3-url \
  --gen2 \
  --runtime=${RUNTIME} \
  --region=${REGION} \
  --source="${SOURCE_DIR}" \
  --entry-point=GetSignedURL \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars ${ENV_VARS} \
  --quiet

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ get-s3-url deployed successfully${NC}"
else
  echo -e "${RED}✗ get-s3-url deployment failed${NC}"
  exit 1
fi
echo ""

# Function 2: list-mirror-photos
echo -e "${YELLOW}Deploying list-mirror-photos...${NC}"
gcloud functions deploy list-mirror-photos \
  --gen2 \
  --runtime=${RUNTIME} \
  --region=${REGION} \
  --source="${SOURCE_DIR}" \
  --entry-point=ListMirrorPhotos \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars ${ENV_VARS} \
  --quiet

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ list-mirror-photos deployed successfully${NC}"
else
  echo -e "${RED}✗ list-mirror-photos deployment failed${NC}"
  exit 1
fi
echo ""

# Function 3: delete-mirror-event
echo -e "${YELLOW}Deploying delete-mirror-event...${NC}"
gcloud functions deploy delete-mirror-event \
  --gen2 \
  --runtime=${RUNTIME} \
  --region=${REGION} \
  --source="${SOURCE_DIR}" \
  --entry-point=DeleteMirrorEvent \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars ${ENV_VARS} \
  --quiet

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ delete-mirror-event deployed successfully${NC}"
else
  echo -e "${RED}✗ delete-mirror-event deployment failed${NC}"
  exit 1
fi
echo ""

echo "=========================================="
echo -e "${GREEN}All functions deployed successfully!${NC}"
echo ""
echo "Deployed functions:"
echo "  • get-s3-url"
echo "  • list-mirror-photos"
echo "  • delete-mirror-event"

