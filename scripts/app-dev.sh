#!/bin/sh
# Dev mode: vite rebuilds islands on change; tsx restarts the server on
# change. Two watchers, one command, no HMR (full-page reload by design).
set -e
cd "$(dirname "$0")/.."

pnpm exec vite build --watch &
VITE_PID=$!
trap 'kill $VITE_PID 2>/dev/null' EXIT

BEELINE_DEV_LOGIN="${BEELINE_DEV_LOGIN:-rainhead}" pnpm exec tsx watch src/app/main.ts
