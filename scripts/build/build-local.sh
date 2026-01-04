#!/bin/bash

# --- CONFIGURATION ---
IPAD_ID="2DF5362B-7C98-54FC-86C5-9D5F68CCAECE"
IPHONE_ID="992E8F6C-702F-5518-9DDC-187B3A382EFB"

# --- LOGIC ---
if [ "$1" == "cole" ]; then
    echo "🚀 Building Looking Glass (iPad)..."
    cd apps/cole && EXPO_NO_GIT_STATUS=1 npx expo run:ios --device $IPAD_ID
elif [ "$1" == "companion" ]; then
    echo "📱 Building Companion (iPhone)..."
    cd apps/companion && EXPO_NO_GIT_STATUS=1 npx expo run:ios --device $IPHONE_ID
else
    echo "❌ Error: Specify 'cole' or 'companion'"
    echo "Usage: ./build-local.sh cole"
fi