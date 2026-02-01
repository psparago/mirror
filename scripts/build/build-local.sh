#!/bin/bash

# --- CONFIGURATION ---
IPAD_ID="2DF5362B-7C98-54FC-86C5-9D5F68CCAECE"
IPHONE_ID="992E8F6C-702F-5518-9DDC-187B3A382EFB"

# --- LOGIC ---
if [ "$1" == "explorer" ]; then
    echo "🚀 Building Reflections Explorer (iPad)..."
    cd apps/explorer && EXPO_NO_GIT_STATUS=1 npx expo run:ios --device $IPAD_ID
elif [ "$1" == "connect" ]; then
    echo "📱 Building Reflections Connect (iPhone)..."
    cd apps/connect && EXPO_NO_GIT_STATUS=1 npx expo run:ios --device $IPHONE_ID
else
    echo "❌ Error: Specify 'explorer' or 'connect'"
    echo "Usage: ./build-local.sh explorer"
fi