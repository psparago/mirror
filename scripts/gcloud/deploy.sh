#!/bin/bash
# Deploy a single Cloud Function for Project Mirror
# Usage: ./deploy.sh <function-name>
#
# See also: ./deploy-all.sh (deploy everything), ./deploy-<name>.sh (shortcuts)

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

ALL_FUNCTIONS=(
  get-s3-url
  list-mirror-events
  delete-mirror-event
  get-batch-s3-upload-urls
  get-event-bundle
  get-voice-sample
  synthesize-speech
  delete-companion-account
  submit-client-logs
  unsplash-search
  generate-ai-description
  on-reflection-created
  on-reflection-updated
  send-fast-lane-notification
  aggregate-slow-lane-notifications
  send-posting-reminders
)

print_available_functions() {
  for fn in "${ALL_FUNCTIONS[@]}"; do
    echo "  • ${fn}"
  done
}

# Check if function name was provided
if [ -z "$1" ]; then
  echo -e "${RED}Error: Function name required${NC}"
  echo ""
  echo "Usage: $0 <function-name>"
  echo ""
  echo "Available functions:"
  print_available_functions
  exit 1
fi

FUNCTION_NAME="$1"

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

# Common deployment parameters
REGION="us-central1"
FIRESTORE_TRIGGER_LOCATION="${FIRESTORE_TRIGGER_LOCATION:-nam5}"
RUNTIME="go125"
NODE_RUNTIME="nodejs20"
SLOW_LANE_TOPIC="aggregate-slow-lane-notifications"
SLOW_LANE_SCHEDULER_JOB="aggregate-slow-lane-notifications"
SLOW_LANE_SCHEDULE="*/15 * * * *"
POSTING_REMINDERS_TOPIC="send-posting-reminders"
POSTING_REMINDERS_SCHEDULER_JOB="send-posting-reminders"
POSTING_REMINDERS_SCHEDULE="0 14 * * *"
PUBSUB_TRIGGER_LOCATION="${PUBSUB_TRIGGER_LOCATION:-${REGION}}"
SCHEDULER_LOCATION="${SCHEDULER_LOCATION:-${REGION}}"
ENV_VARS="AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID},AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY},AWS_REGION=${AWS_REGION}"

# Deploy based on function name
case "$FUNCTION_NAME" in
  get-s3-url)
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
    ;;
  
  list-mirror-events)
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
    ;;
  
  delete-mirror-event)
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
    ;;

  get-batch-s3-upload-urls)
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
    ;;
  
  unsplash-search)
    if [ -z "$UNSPLASH_KEY" ]; then
      echo -e "${RED}Error: UNSPLASH_KEY not found in .env.deploy${NC}"
      exit 1
    fi
    echo -e "${YELLOW}Deploying unsplash-search...${NC}"
    gcloud functions deploy unsplash-search \
      --gen2 \
      --runtime=${RUNTIME} \
      --region=${REGION} \
      --source="${SOURCE_DIR}" \
      --entry-point=SearchUnsplash \
      --trigger-http \
      --allow-unauthenticated \
      --set-env-vars UNSPLASH_ACCESS_KEY=${UNSPLASH_KEY} \
      --quiet
    ;;
  
  generate-ai-description)
    if [ -z "$GEMINI_API_KEY" ]; then
      echo -e "${RED}Error: GEMINI_API_KEY not found in .env.deploy${NC}"
      exit 1
    fi
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
    ;;
  
  get-event-bundle)
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
    ;;

  get-voice-sample)
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
    ;;

  synthesize-speech)
    echo -e "${YELLOW}Deploying synthesize-speech...${NC}"
    gcloud functions deploy synthesize-speech \
      --gen2 \
      --runtime=${RUNTIME} \
      --region=${REGION} \
      --source="${SOURCE_DIR}" \
      --entry-point=SynthesizeSpeech \
      --trigger-http \
      --allow-unauthenticated \
      --set-env-vars ${ENV_VARS} \
      --quiet
    ;;

  delete-companion-account)
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
    ;;

  submit-client-logs)
    echo -e "${YELLOW}Deploying submit-client-logs...${NC}"
    gcloud functions deploy submit-client-logs \
      --gen2 \
      --runtime=${RUNTIME} \
      --region=${REGION} \
      --source="${SOURCE_DIR}" \
      --entry-point=SubmitClientLogs \
      --trigger-http \
      --allow-unauthenticated \
      --set-env-vars ${ENV_VARS} \
      --quiet
    ;;

  on-reflection-created)
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
    ;;

  on-reflection-updated)
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
    ;;

  send-fast-lane-notification)
    if [ ! -f "${NOTIFICATIONS_NODE_SOURCE_DIR}/package.json" ]; then
      echo -e "${RED}Error: package.json not found in ${NOTIFICATIONS_NODE_SOURCE_DIR}${NC}"
      exit 1
    fi
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
    ;;

  aggregate-slow-lane-notifications)
    if [ ! -f "${NOTIFICATIONS_NODE_SOURCE_DIR}/package.json" ]; then
      echo -e "${RED}Error: package.json not found in ${NOTIFICATIONS_NODE_SOURCE_DIR}${NC}"
      exit 1
    fi
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
    ;;

  send-posting-reminders)
    if [ ! -f "${NOTIFICATIONS_NODE_SOURCE_DIR}/package.json" ]; then
      echo -e "${RED}Error: package.json not found in ${NOTIFICATIONS_NODE_SOURCE_DIR}${NC}"
      exit 1
    fi
    echo -e "${YELLOW}Ensuring Pub/Sub topic ${POSTING_REMINDERS_TOPIC} exists...${NC}"
    gcloud pubsub topics describe "${POSTING_REMINDERS_TOPIC}" --quiet >/dev/null 2>&1 || \
      gcloud pubsub topics create "${POSTING_REMINDERS_TOPIC}" --quiet

    echo -e "${YELLOW}Deploying send-posting-reminders...${NC}"
    gcloud functions deploy send-posting-reminders \
      --gen2 \
      --runtime=${NODE_RUNTIME} \
      --region=${REGION} \
      --trigger-location=${PUBSUB_TRIGGER_LOCATION} \
      --source="${NOTIFICATIONS_NODE_SOURCE_DIR}" \
      --entry-point=sendPostingReminders \
      --trigger-topic="${POSTING_REMINDERS_TOPIC}" \
      --quiet

    echo -e "${YELLOW}Ensuring daily scheduler job ${POSTING_REMINDERS_SCHEDULER_JOB} exists...${NC}"
    if gcloud scheduler jobs describe "${POSTING_REMINDERS_SCHEDULER_JOB}" --location="${SCHEDULER_LOCATION}" --quiet >/dev/null 2>&1; then
      gcloud scheduler jobs update pubsub "${POSTING_REMINDERS_SCHEDULER_JOB}" \
        --location="${SCHEDULER_LOCATION}" \
        --schedule="${POSTING_REMINDERS_SCHEDULE}" \
        --topic="${POSTING_REMINDERS_TOPIC}" \
        --message-body='{}' \
        --quiet
    else
      gcloud scheduler jobs create pubsub "${POSTING_REMINDERS_SCHEDULER_JOB}" \
        --location="${SCHEDULER_LOCATION}" \
        --schedule="${POSTING_REMINDERS_SCHEDULE}" \
        --topic="${POSTING_REMINDERS_TOPIC}" \
        --message-body='{}' \
        --quiet
    fi
    ;;
  
  *)
    echo -e "${RED}Error: Unknown function name: ${FUNCTION_NAME}${NC}"
    echo ""
    echo "Available functions:"
    print_available_functions
    exit 1
    ;;
esac

if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ ${FUNCTION_NAME} deployed successfully${NC}"
else
  echo -e "${RED}✗ ${FUNCTION_NAME} deployment failed${NC}"
  exit 1
fi

