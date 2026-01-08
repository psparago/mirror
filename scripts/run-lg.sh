#!/bin/bash

# Run Looking Glass (LG) app
echo "🚀 Starting Looking Glass (LG) Development Server..."
cd "$(dirname "$0")/../apps/cole" || exit 1
npx expo start -c --dev-client --port 8081
