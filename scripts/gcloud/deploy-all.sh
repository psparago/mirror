#!/bin/bash
# Deploy all Cloud Functions for Project Mirror
# Loads deployment credentials from .env.deploy and deploys all Cloud Functions sequentially

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.deploy"
SOURCE_DIR="${PROJECT_ROOT}/backend/gcloud/functions"
NOTIFICATIONS_NODE_SOURCE_DIR="${PROJECT_ROOT}/backend/gcloud/notifications-node"

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

# Check for Node notification package
if [ ! -f "${NOTIFICATIONS_NODE_SOURCE_DIR}/package.json" ]; then
  echo -e "${RED}Error: package.json not found in ${NOTIFICATIONS_NODE_SOURCE_DIR}${NC}"
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

echo -e "${GREEN}✓ Environment variables loaded${NC}"
echo ""

# Common deployment parameters
REGION="us-central1"
FIRESTORE_TRIGGER_LOCATION="${FIRESTORE_TRIGGER_LOCATION:-nam5}"
RUNTIME="go125"
NODE_RUNTIME="nodejs20"
SLOW_LANE_TOPIC="aggregate-slow-lane-notifications"
SLOW_LANE_SCHEDULER_JOB="aggregate-slow-lane-notifications"
SLOW_LANE_SCHEDULE="*/15 * * * *"
PUBSUB_TRIGGER_LOCATION="${PUBSUB_TRIGGER_LOCATION:-${REGION}}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-${REGION}}"
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

# Function 5: get-event-bundle
echo -e "${YELLOW}Deploying get-event-bundle...${NC}"
gcloud functions deploy get-event-bundle \
  --gen2 \
  --runtime=${RUNTIME} \
  --region=${REGION} \
  --source="${SOURCE_DIR}" \
  --entry-point=GetEventBundle \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars ${ENV_VARS} \
  --quiet

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ get-event-bundle deployed successfully${NC}"
else
  echo -e "${RED}✗ get-event-bundle deployment failed${NC}"
  exit 1
fi
echo ""

# Function 6: get-voice-sample
echo -e "${YELLOW}Deploying get-voice-sample...${NC}"
gcloud functions deploy get-voice-sample \
  --gen2 \
  --runtime=${RUNTIME} \
  --region=${REGION} \
  --source="${SOURCE_DIR}" \
  --entry-point=GetVoiceSample \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars ${ENV_VARS} \
  --quiet

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ get-voice-sample deployed successfully${NC}"
else
  echo -e "${RED}✗ get-voice-sample deployment failed${NC}"
  exit 1
fi
echo ""

# Function 7: unsplash-search
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

# Function 8: delete-companion-account
echo -e "${YELLOW}Deploying delete-companion-account...${NC}"
gcloud functions deploy delete-companion-account \
  --gen2 \
  --runtime=${RUNTIME} \
  --region=${REGION} \
  --source="${SOURCE_DIR}" \
  --entry-point=DeleteCompanionAccount \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars ${ENV_VARS} \
  --quiet

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ delete-companion-account deployed successfully${NC}"
else
  echo -e "${RED}✗ delete-companion-account deployment failed${NC}"
  exit 1
fi
echo ""

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
    --set-env-vars ${ENV_VARS},GEMINI_API_KEY=${GEMINI_API_KEY} \
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

# Function 9: on-reflection-created
echo -e "${YELLOW}Deploying on-reflection-created...${NC}"
gcloud functions deploy on-reflection-created \
  --gen2 \
  --runtime=${RUNTIME} \
  --region=${REGION} \
  --trigger-location=${FIRESTORE_TRIGGER_LOCATION} \
  --source="${SOURCE_DIR}" \
  --entry-point=OnReflectionCreated \
  --trigger-event-filters=type=google.cloud.firestore.document.v1.created \
  --trigger-event-filters=database='(default)' \
  --trigger-event-filters-path-pattern=document='reflections/{reflectionId}' \
  --quiet

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ on-reflection-created deployed successfully${NC}"
else
  echo -e "${RED}✗ on-reflection-created deployment failed${NC}"
  exit 1
fi
echo ""

# Function 10: on-reflection-updated
echo -e "${YELLOW}Deploying on-reflection-updated...${NC}"
gcloud functions deploy on-reflection-updated \
  --gen2 \
  --runtime=${RUNTIME} \
  --region=${REGION} \
  --trigger-location=${FIRESTORE_TRIGGER_LOCATION} \
  --source="${SOURCE_DIR}" \
  --entry-point=OnReflectionUpdated \
  --trigger-event-filters=type=google.cloud.firestore.document.v1.updated \
  --trigger-event-filters=database='(default)' \
  --trigger-event-filters-path-pattern=document='reflections/{reflectionId}' \
  --quiet

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ on-reflection-updated deployed successfully${NC}"
else
  echo -e "${RED}✗ on-reflection-updated deployment failed${NC}"
  exit 1
fi
echo ""

# Function 11: send-fast-lane-notification
echo -e "${YELLOW}Deploying send-fast-lane-notification...${NC}"
gcloud functions deploy send-fast-lane-notification \
  --gen2 \
  --runtime=${NODE_RUNTIME} \
  --region=${REGION} \
  --trigger-location=${FIRESTORE_TRIGGER_LOCATION} \
  --source="${NOTIFICATIONS_NODE_SOURCE_DIR}" \
  --entry-point=sendFastLaneNotification \
  --trigger-event-filters=type=google.cloud.firestore.document.v1.created \
  --trigger-event-filters=database='(default)' \
  --trigger-event-filters-path-pattern=document='pending_notifications/{notificationId}' \
  --quiet

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ send-fast-lane-notification deployed successfully${NC}"
else
  echo -e "${RED}✗ send-fast-lane-notification deployment failed${NC}"
  exit 1
fi
echo ""

# Function 12: aggregate-slow-lane-notifications
echo -e "${YELLOW}Ensuring Pub/Sub topic ${SLOW_LANE_TOPIC} exists...${NC}"
gcloud pubsub topics describe "${SLOW_LANE_TOPIC}" --quiet >/dev/null 2>&1 || \
  gcloud pubsub topics create "${SLOW_LANE_TOPIC}" --quiet

echo -e "${YELLOW}Deploying aggregate-slow-lane-notifications...${NC}"
gcloud functions deploy aggregate-slow-lane-notifications \
  --gen2 \
  --runtime=${NODE_RUNTIME} \
  --region=${REGION} \
  --trigger-location=${PUBSUB_TRIGGER_LOCATION} \
  --source="${NOTIFICATIONS_NODE_SOURCE_DIR}" \
  --entry-point=aggregateSlowLaneNotifications \
  --trigger-topic="${SLOW_LANE_TOPIC}" \
  --quiet

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ aggregate-slow-lane-notifications deployed successfully${NC}"
else
  echo -e "${RED}✗ aggregate-slow-lane-notifications deployment failed${NC}"
  exit 1
fi

echo -e "${YELLOW}Ensuring 15-minute scheduler job ${SLOW_LANE_SCHEDULER_JOB} exists...${NC}"
if gcloud scheduler jobs describe "${SLOW_LANE_SCHEDULER_JOB}" --location="${SCHEDULER_LOCATION}" --quiet >/dev/null 2>&1; then
  gcloud scheduler jobs update pubsub "${SLOW_LANE_SCHEDULER_JOB}" \
    --location="${SCHEDULER_LOCATION}" \
    --schedule="${SLOW_LANE_SCHEDULE}" \
    --topic="${SLOW_LANE_TOPIC}" \
    --message-body='{}' \
    --quiet
else
  gcloud scheduler jobs create pubsub "${SLOW_LANE_SCHEDULER_JOB}" \
    --location="${SCHEDULER_LOCATION}" \
    --schedule="${SLOW_LANE_SCHEDULE}" \
    --topic="${SLOW_LANE_TOPIC}" \
    --message-body='{}' \
    --quiet
fi
echo ""

echo "=========================================="
echo -e "${GREEN}All functions deployed successfully!${NC}"
echo ""
echo "Deployed functions:"
echo "  • get-s3-url"
echo "  • list-mirror-events"
echo "  • delete-mirror-event"
echo "  • get-batch-s3-upload-urls"
echo "  • get-event-bundle"
echo "  • get-voice-sample"
echo "  • delete-companion-account"
if [ "$SKIP_UNSPLASH" = false ]; then
  echo "  • unsplash-search"
fi
if [ "$SKIP_AI" = false ]; then
  echo "  • generate-ai-description"
fi
echo "  • on-reflection-created"
echo "  • on-reflection-updated"
echo "  • send-fast-lane-notification"
echo "  • aggregate-slow-lane-notifications"

