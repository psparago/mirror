#!/bin/bash
# Deploy the get-batch-s3-upload-urls Cloud Function.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/deploy.sh" get-batch-s3-upload-urls
