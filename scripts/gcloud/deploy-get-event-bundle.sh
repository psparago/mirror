#!/bin/bash
# Deploy the get-event-bundle Cloud Function.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/deploy.sh" get-event-bundle
