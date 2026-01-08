#!/bin/bash

# Run Looking Glass Companion (LG Companion) app
echo "🚀 Starting Looking Glass Companion (LG Companion) Development Server..."
cd "$(dirname "$0")/../apps/companion" || exit 1
npx expo start -c --dev-client --port 8082

