#!/bin/bash
# Deploy the delete-mirror-event Cloud Function.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/deploy.sh" delete-mirror-event
