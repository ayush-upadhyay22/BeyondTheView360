#!/usr/bin/env bash
# Build the monorepo on the EB instance (CodePipeline has no CodeBuild stage).
set -euo pipefail
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=768}"
export NPM_CONFIG_PRODUCTION=false

echo "Ensuring dependencies (including devDeps for TypeScript/Vite builds)…"
npm ci --include=dev

echo "Running npm run build (NODE_OPTIONS=${NODE_OPTIONS})"
npm run build

echo "Build complete."
