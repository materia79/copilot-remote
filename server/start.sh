#!/bin/bash
# start.sh — Launch the Copilot web proxy server + relay
#
# Usage:
#   ./start.sh                          # default background
#   ./start.sh --foreground             # visible foreground
#   ./start.sh --token mynewtoken        # override auth token for this launch
#   ./start.sh --token newtoken --foreground

TOKEN=""
FOREGROUND=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --token)
      TOKEN="$2"
      shift 2
      ;;
    --foreground)
      FOREGROUND=true
      shift
      ;;
    *)
      shift
      ;;
  esac
done

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_root="$(pwd)"
node=$(command -v node || echo "/usr/bin/node")
logsDir="$dir/logs"
serverScript="$dir/server.js"
relayScript="$dir/relay.mjs"

mkdir -p "$logsDir"
export COPILOT_WORKSPACE_ROOT="$workspace_root"

# Build arg arrays
srvArgs=("server.js")
relayArgs=("relay.mjs")

if [[ -n "$TOKEN" ]]; then
  srvArgs+=("--token" "$TOKEN")
  relayArgs+=("--token" "$TOKEN")
fi

if [[ "$FOREGROUND" == true ]]; then
  relayArgs+=("--foreground")
fi

echo "Starting server..."
$node "${serverScript}" "${srvArgs[@]:1}" >> "$logsDir/server.log" 2>> "$logsDir/server-err.log" &
srv_pid=$!
echo "Server PID: $srv_pid"

sleep 2

if [[ "$FOREGROUND" == true ]]; then
  echo "Starting relay (foreground terminal)..."
  sleep_time=8
else
  echo "Starting relay..."
  sleep_time=5
fi

$node "${relayScript}" "${relayArgs[@]:1}" >> "$logsDir/relay.log" 2>> "$logsDir/relay-err.log" &
relay_pid=$!
echo "Relay PID: $relay_pid"

sleep "$sleep_time"

# Verify
if [[ -n "$TOKEN" ]]; then
  authToken="$TOKEN"
else
  authToken=$(grep -o '"authToken":"[^"]*"' "$dir/config.json" | cut -d'"' -f4)
fi

if command -v curl &> /dev/null; then
  if status=$(curl -s -H "Authorization: Bearer $authToken" "http://localhost:3333/api/status" 2>/dev/null); then
    cliOnline=$(echo "$status" | grep -o '"cliOnline":[^,}]*' | cut -d':' -f2)
    echo ""
    echo "Server running — CLI online: $cliOnline"
    echo "  http://localhost:3333/"
  else
    echo "Server health check failed — check logs/server.log"
  fi
else
  echo "Server health check skipped — curl not available"
fi

echo ""
echo "To watch logs:"
echo "  tail -f $logsDir/server.log"
echo "  tail -f $logsDir/relay.log"
