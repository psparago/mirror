#!/bin/bash

# Run Companion app (iPhone)
cd "$(dirname "$0")/../apps/companion" || exit 1
npm start

