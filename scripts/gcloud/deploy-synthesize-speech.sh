#!/bin/bash
# Deploy the synthesize-speech Cloud Function (synthesize_speech.go).
# Ephemeral Google TTS: POST text, returns base64 MP3 (no S3 persistence).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/deploy.sh" synthesize-speech
