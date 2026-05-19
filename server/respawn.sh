#!/bin/bash

script_dir="$(cd "$(dirname "$0")" && pwd)"
workspace_root="$(pwd)"
export COPILOT_WORKSPACE_ROOT="$workspace_root"

RESPAWN_DELAY_SECONDS=3

while true; do
  echo "[respawn] Starting server.js at $(date)"
  node "$script_dir/server.js"
  EXIT_CODE=$?
  echo "[respawn] server.js exited with code $EXIT_CODE. Restarting in ${RESPAWN_DELAY_SECONDS}s..."
  sleep $RESPAWN_DELAY_SECONDS
done
