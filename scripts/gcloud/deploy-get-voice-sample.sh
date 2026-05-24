#!/bin/bash
# Deploy the get-voice-sample Cloud Function (voice_sample.go).
# Returns presigned S3 URLs for Google TTS voice preview MP3s.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/deploy.sh" get-voice-sample
