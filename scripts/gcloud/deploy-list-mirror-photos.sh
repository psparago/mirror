#!/bin/bash
# Deploy the list-mirror-events Cloud Function.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/deploy.sh" list-mirror-events
