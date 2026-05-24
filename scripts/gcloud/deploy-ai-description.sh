#!/bin/bash
# Deploy the generate-ai-description Cloud Function.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/deploy.sh" generate-ai-description
