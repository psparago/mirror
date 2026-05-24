#!/bin/bash
# Deploy the delete-companion-account Cloud Function (account.go).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/deploy.sh" delete-companion-account
