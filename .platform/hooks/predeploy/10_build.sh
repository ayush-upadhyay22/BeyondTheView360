#!/usr/bin/env bash
# Build only what the one-process host needs. EB already ran npm install — do NOT npm ci again
# (that was hanging/OOM'ing on t3.micro for 5+ minutes).
set -euo pipefail
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=512}"
export NPM_CONFIG_PRODUCTION=false

echo "predeploy: NODE_OPTIONS=${NODE_OPTIONS}"
echo "predeploy: building @btv/api (bundles workspace packages into dist/host.js)…"
npm run build -w @btv/api

echo "predeploy: building @btv/web (SPA → apps/web/dist)…"
npm run build -w @btv/web

echo "predeploy: build complete."
test -f apps/api/dist/host.js
test -d apps/web/dist
