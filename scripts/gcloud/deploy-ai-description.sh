#!/bin/bash
# Deploy generate-ai-description Cloud Function
# Loads GEMINI_API_KEY from .env.deploy file

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

# Check for required API keys
if [ -z "$GEMINI_API_KEY" ]; then
  echo -e "${RED}Error: GEMINI_API_KEY not found in .env.deploy${NC}"
  exit 1
fi

if [ -z "$OPENAI_API_KEY" ]; then
  echo -e "${YELLOW}Warning: OPENAI_API_KEY not found in .env.deploy${NC}"
  echo "TTS functionality will be disabled."
fi

echo -e "${YELLOW}Deploying generate-ai-description...${NC}"

gcloud functions deploy generate-ai-description \
  --gen2 \
  --runtime=go125 \
  --region=us-central1 \
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

