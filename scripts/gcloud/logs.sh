#!/bin/bash
# Read Cloud Function logs (Gen2) for Project Mirror.
#
# Usage:
#   ./scripts/gcloud/logs.sh <function-name> [options]
#
# Examples:
#   ./scripts/gcloud/logs.sh aggregate-slow-lane-notifications
#   ./scripts/gcloud/logs.sh send-fast-lane-notification --limit 200
#   ./scripts/gcloud/logs.sh aggregate-slow-lane-notifications --filter cooldown
#   ./scripts/gcloud/logs.sh aggregate-slow-lane-notifications --freshness 1h
#
# See scripts/gcloud/LOGS.md for full documentation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

REGION="${REGION:-us-central1}"
PROJECT="${GCP_PROJECT:-}"
LIMIT=100
FRESHNESS=""
TEXT_FILTER=""
USE_LOGGING_READ=false
FORMAT=""

usage() {
  cat <<EOF
Usage: $(basename "$0") <function-name> [options]

Cloud Functions (Gen2) deployed via ./scripts/gcloud/deploy.sh.

Arguments:
  function-name          Name passed to deploy.sh (e.g. aggregate-slow-lane-notifications)

Options:
  --project ID           GCP project (default: gcloud config get-value project)
  --region REGION        Cloud Function region (default: us-central1)
  --limit N              Max log entries (default: 100)
  --freshness DURATION   Only recent logs, e.g. 30m, 1h, 1d (uses logging read)
  --filter TEXT          Search log message text (uses Cloud Logging SEARCH)
  --logging-read         Use 'gcloud logging read' instead of 'gcloud functions logs read'
  --format FMT           Output format for logging-read (default: table)
  -h, --help             Show this help

Common function names:
  aggregate-slow-lane-notifications
  send-fast-lane-notification
  on-reflection-created
  on-reflection-updated
  get-s3-url
  list-mirror-events
  delete-mirror-event
  unsplash-search
  generate-ai-description
  get-event-bundle

Examples:
  $(basename "$0") aggregate-slow-lane-notifications
  $(basename "$0") aggregate-slow-lane-notifications --filter deferring --limit 50
  $(basename "$0") send-fast-lane-notification --freshness 2h
EOF
}

if [[ $# -lt 1 ]] || [[ "${1:-}" == "-h" ]] || [[ "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

FUNCTION_NAME="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --freshness) FRESHNESS="$2"; shift 2 ;;
    --filter) TEXT_FILTER="$2"; shift 2 ;;
    --logging-read) USE_LOGGING_READ=true; shift ;;
    --format) FORMAT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$PROJECT" ]]; then
  PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
fi

if [[ -z "$PROJECT" ]] || [[ "$PROJECT" == "(unset)" ]]; then
  echo -e "${RED}Error: No GCP project. Pass --project or run: gcloud config set project <id>${NC}" >&2
  exit 1
fi

echo -e "${GREEN}Function:${NC}  ${FUNCTION_NAME}"
echo -e "${GREEN}Project:${NC}   ${PROJECT}"
echo -e "${GREEN}Region:${NC}    ${REGION}"
echo -e "${GREEN}Limit:${NC}     ${LIMIT}"
[[ -n "$TEXT_FILTER" ]] && echo -e "${GREEN}Filter:${NC}    ${TEXT_FILTER}"
[[ -n "$FRESHNESS" ]] && echo -e "${GREEN}Freshness:${NC} ${FRESHNESS}"
echo ""

if [[ "$USE_LOGGING_READ" == true ]] || [[ -n "$FRESHNESS" ]] || [[ -n "$TEXT_FILTER" ]]; then
  QUERY="resource.type=\"cloud_run_revision\"
resource.labels.service_name=\"${FUNCTION_NAME}\""

  if [[ -n "$TEXT_FILTER" ]]; then
    QUERY="${QUERY}
SEARCH(\"${TEXT_FILTER}\")"
  fi

  LOG_CMD=(
    gcloud logging read "$QUERY"
    --project="$PROJECT"
    --limit="$LIMIT"
  )

  if [[ -n "$FRESHNESS" ]]; then
    LOG_CMD+=(--freshness="$FRESHNESS")
  fi

  if [[ -n "$FORMAT" ]]; then
    LOG_CMD+=(--format="$FORMAT")
  else
    LOG_CMD+=(--format='table(timestamp,severity,textPayload)')
  fi

  if ! OUTPUT=$("${LOG_CMD[@]}" 2>&1); then
    echo "$OUTPUT" >&2
    exit 1
  fi

  if [[ -z "$OUTPUT" ]]; then
    echo "No matching log entries."
  else
    printf '%s\n' "$OUTPUT"
  fi
else
  gcloud functions logs read "$FUNCTION_NAME" \
    --gen2 \
    --region="$REGION" \
    --project="$PROJECT" \
    --limit="$LIMIT"
fi
