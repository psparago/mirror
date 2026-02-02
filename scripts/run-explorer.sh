#!/bin/bash

# Initialize nvm if available
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Use Node 20 (required for this project)
nvm use 20 2>/dev/null || true

# Run Looking Glass (LG) app (iOS only - use dev client on iOS device/simulator)
echo "🚀 Starting Reflections Explorer Development Server..."
echo "📱 Open the app on your iOS device or simulator to connect"
cd "$(dirname "$0")/../apps/explorer" || exit 1
npx expo start -c --dev-client --port 8083
