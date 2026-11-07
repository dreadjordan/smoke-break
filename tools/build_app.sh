#!/bin/bash
# Builds Smoke Break and installs it in /Applications for local use. Set SIGNING_IDENTITY to a certificate's name to sign with it.
# Why: macOS ties its screen and audio permissions to the signature, so a real identity keeps them across rebuilds; ad-hoc signing loses them each time.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run --silent build:helper
npx electron-builder --mac dir --arm64 ${SIGNING_IDENTITY:+"--config.mac.identity=$SIGNING_IDENTITY"}
ditto "dist/mac-arm64/Smoke Break.app" "/Applications/Smoke Break.app"
