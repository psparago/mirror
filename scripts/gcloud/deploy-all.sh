#!/bin/bash
# Deploy all Cloud Functions for Project Mirror
# Loads AWS credentials from .env.deploy and deploys all three functions sequentially

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.deploy"
SOURCE_DIR="${PROJECT_ROOT}/backend/gcloud/functions"

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

# Check for Unsplash key (optional, but needed for unsplash-search function)
if [ -z "$UNSPLASH_KEY" ]; then
  echo -e "${YELLOW}Warning: UNSPLASH_KEY not found in .env.deploy${NC}"
  echo "The unsplash-search function will be skipped."
  SKIP_UNSPLASH=true
else
  SKIP_UNSPLASH=false
fi

# Check for Gemini API key (optional, but needed for generate-ai-description function)
if [ -z "$GEMINI_API_KEY" ]; then
  echo -e "${YELLOW}Warning: GEMINI_API_KEY not found in .env.deploy${NC}"
  echo "The generate-ai-description function will be skipped."
  SKIP_AI=true
else
  SKIP_AI=false
fi

# Check for OpenAI API key (optional, needed for TTS)
if [ -z "$OPENAI_API_KEY" ]; then
  echo -e "${YELLOW}Warning: OPENAI_API_KEY not found in .env.deploy${NC}"
  echo "TTS functionality will be disabled."
fi

echo -e "${GREEN}✓ Environment variables loaded${NC}"
echo ""

# Common deployment parameters
REGION="us-central1"
RUNTIME="go125"
ENV_VARS="AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID},AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY},AWS_REGION=${AWS_REGION},OPENAI_API_KEY=${OPENAI_API_KEY}"

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

# Function 2: list-mirror-events
echo -e "${YELLOW}Deploying list-mirror-events...${NC}"
gcloud functions deploy list-mirror-events \
  --gen2 \
  --runtime=${RUNTIME} \
  --region=${REGION} \
  --source="${SOURCE_DIR}" \
  --entry-point=ListMirrorEvents \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars ${ENV_VARS} \
  --quiet

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ list-mirror-events deployed successfully${NC}"
else
  echo -e "${RED}✗ list-mirror-events deployment failed${NC}"
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

# Function 4: get-batch-s3-upload-urls
echo -e "${YELLOW}Deploying get-batch-s3-upload-urls...${NC}"
gcloud functions deploy get-batch-s3-upload-urls \
  --gen2 \
  --runtime=${RUNTIME} \
  --region=${REGION} \
  --source="${SOURCE_DIR}" \
  --entry-point=GetBatchS3UploadURLs \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars ${ENV_VARS} \
  --quiet

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ get-batch-s3-upload-urls deployed successfully${NC}"
else
  echo -e "${RED}✗ get-batch-s3-upload-urls deployment failed${NC}"
  exit 1
fi
echo ""

# Function 5: unsplash-search
if [ "$SKIP_UNSPLASH" = false ]; then
  echo -e "${YELLOW}Deploying unsplash-search...${NC}"
  
  # Set required variables for deploy-unsplash.sh
  export FUNCTION_NAME="unsplash-search"
  export RUNTIME="${RUNTIME}"
  export REGION="${REGION}"
  export ENTRY_POINT="SearchUnsplash"
  export UNSPLASH_KEY="${UNSPLASH_KEY}"
  export PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
  export SOURCE_DIR="${SOURCE_DIR}"
  
  # Call the deploy-unsplash.sh script
  bash "${SCRIPT_DIR}/deploy-unsplash.sh"
  
  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ unsplash-search deployed successfully${NC}"
  else
    echo -e "${RED}✗ unsplash-search deployment failed${NC}"
    exit 1
  fi
  echo ""
else
  echo -e "${YELLOW}⚠ Skipping unsplash-search (UNSPLASH_KEY not set)${NC}"
  echo ""
fi

# Function 6: generate-ai-description
if [ "$SKIP_AI" = false ]; then
  echo -e "${YELLOW}Deploying generate-ai-description...${NC}"
  gcloud functions deploy generate-ai-description \
    --gen2 \
    --runtime=${RUNTIME} \
    --region=${REGION} \
    --source="${SOURCE_DIR}" \
    --entry-point=GenerateAIDescription \
    --trigger-http \
    --allow-unauthenticated \
    --set-env-vars GEMINI_API_KEY=${GEMINI_API_KEY},OPENAI_API_KEY=${OPENAI_API_KEY} \
    --quiet

  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ generate-ai-description deployed successfully${NC}"
  else
    echo -e "${RED}✗ generate-ai-description deployment failed${NC}"
    exit 1
  fi
  echo ""
else
  echo -e "${YELLOW}⚠ Skipping generate-ai-description (GEMINI_API_KEY not set)${NC}"
  echo ""
fi

echo "=========================================="
echo -e "${GREEN}All functions deployed successfully!${NC}"
echo ""
echo "Deployed functions:"
echo "  • get-s3-url"
echo "  • list-mirror-events"
echo "  • delete-mirror-event"
echo "  • get-batch-s3-upload-urls"
if [ "$SKIP_UNSPLASH" = false ]; then
  echo "  • unsplash-search"
fi
if [ "$SKIP_AI" = false ]; then
  echo "  • generate-ai-description"
fi

