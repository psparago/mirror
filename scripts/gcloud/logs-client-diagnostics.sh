#!/usr/bin/env bash
set -eo pipefail

# Read Reflections client diagnostic logs (Connect + Explorer) from Cloud Logging.
#
# Usage:
#   ./scripts/gcloud/logs-client-diagnostics.sh
#   ./scripts/gcloud/logs-client-diagnostics.sh --batch-id abc123
#   ./scripts/gcloud/logs-client-diagnostics.sh --explorer "Mom" --freshness 1d
#   ./scripts/gcloud/logs-client-diagnostics.sh --explorer-app --explorer-id COLE-01052010 --freshness 1d
#   ./scripts/gcloud/logs-client-diagnostics.sh --filter 'camera:ready-timeout'
#   ./scripts/gcloud/logs-client-diagnostics.sh --download batch.json --batch-id abc123

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="${GCLOUD_PROJECT:-reflections-1200b}"
LIMIT=200
FRESHNESS="7d"
BATCH_ID=""
EXPLORER_NAME=""
EXPLORER_ID=""
COMPANION_NAME=""
FILTER=""
DOWNLOAD=""
LOGGING_READ=0
SOURCE="connect-diagnostics"

usage() {
  cat <<'EOF'
Usage: logs-client-diagnostics.sh [options]

Options:
  --project NAME       GCP project (default: reflections-1200b)
  --source NAME        jsonPayload.source (default: connect-diagnostics)
  --explorer-app       Shortcut for --source explorer-diagnostics
  --batch-id ID        Filter to one upload batch
  --explorer NAME      Filter jsonPayload.explorerName
  --explorer-id ID     Filter jsonPayload.explorerId (Explorer batches)
  --companion NAME     Filter jsonPayload.companionName
  --filter TEXT        Extra SEARCH() text (e.g. camera:mount-error)
  --freshness DURATION Cloud Logging freshness (default: 7d)
  --limit N            Max log entries (default: 200)
  --download FILE      Write JSON array of entries to FILE
  --logging-read       Force gcloud logging read (default when filters used)
  -h, --help           Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --explorer-app) SOURCE="explorer-diagnostics"; shift ;;
    --batch-id) BATCH_ID="$2"; shift 2 ;;
    --explorer) EXPLORER_NAME="$2"; shift 2 ;;
    --explorer-id) EXPLORER_ID="$2"; shift 2 ;;
    --companion) COMPANION_NAME="$2"; shift 2 ;;
    --filter) FILTER="$2"; shift 2 ;;
    --freshness) FRESHNESS="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --download) DOWNLOAD="$2"; LOGGING_READ=1; shift 2 ;;
    --logging-read) LOGGING_READ=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -n "$BATCH_ID" || -n "$EXPLORER_NAME" || -n "$EXPLORER_ID" || -n "$COMPANION_NAME" || -n "$FILTER" || -n "$DOWNLOAD" ]]; then
  LOGGING_READ=1
fi

QUERY="jsonPayload.source=\"${SOURCE}\""

if [[ -n "$BATCH_ID" ]]; then
  QUERY+=" AND jsonPayload.batchId=\"${BATCH_ID}\""
fi
if [[ -n "$EXPLORER_NAME" ]]; then
  QUERY+=" AND jsonPayload.explorerName=\"${EXPLORER_NAME}\""
fi
if [[ -n "$EXPLORER_ID" ]]; then
  QUERY+=" AND jsonPayload.explorerId=\"${EXPLORER_ID}\""
fi
if [[ -n "$COMPANION_NAME" ]]; then
  QUERY+=" AND jsonPayload.companionName=\"${COMPANION_NAME}\""
fi
if [[ -n "$FILTER" ]]; then
  QUERY+=" AND SEARCH(\"${FILTER}\")"
fi

if [[ "$LOGGING_READ" -eq 1 ]]; then
  echo "Query: ${QUERY}"
  echo "Project: ${PROJECT} | freshness: ${FRESHNESS} | limit: ${LIMIT}"
  echo ""

  if [[ -n "$DOWNLOAD" ]]; then
    gcloud logging read "${QUERY}" \
      --project="${PROJECT}" \
      --freshness="${FRESHNESS}" \
      --limit="${LIMIT}" \
      --format=json > "${DOWNLOAD}"
    echo "Wrote ${DOWNLOAD}"
    exit 0
  fi

  gcloud logging read "${QUERY}" \
    --project="${PROJECT}" \
    --freshness="${FRESHNESS}" \
    --limit="${LIMIT}" \
    --format='table(timestamp,jsonPayload.batchId,jsonPayload.companionName,jsonPayload.explorerName,jsonPayload.explorerId,jsonPayload.entryLevel,jsonPayload.message)'
  exit 0
fi

echo "Tip: pass --batch-id, --explorer, --companion, or --filter to query Cloud Logging."
echo "Example:"
echo "  $0 --batch-id YOUR-BATCH-ID --freshness 1d"
