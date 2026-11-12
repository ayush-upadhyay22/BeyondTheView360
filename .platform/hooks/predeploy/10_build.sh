#!/usr/bin/env bash
# Build the monorepo on the EB instance after npm install (CodeBuild skipped — account quota 0).
set -euo pipefail
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=768}"
echo "Running npm run build (NODE_OPTIONS=${NODE_OPTIONS})"
npm run build
