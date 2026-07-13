#!/usr/bin/env bash
# Start llama-server for MiniCPM AI integration with Battlegrid.
# The game connects to http://localhost:18766 from the browser.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LLAMA_SERVER="$SCRIPT_DIR/../MiniCPM-Desk-Pet/minicpm-sidecar/bin/mac-arm64/llama-server"
MODEL="$SCRIPT_DIR/../MiniCPM5-1B-Claude-Opus-Fable5-Thinking-GGUF/MiniCPM5-1B-Claude-Opus-Fable5-Thinking-Q4_K_M.gguf"
PORT=18766

if [ ! -f "$LLAMA_SERVER" ]; then
  echo "ERROR: llama-server not found at $LLAMA_SERVER"
  exit 1
fi
if [ ! -f "$MODEL" ]; then
  echo "ERROR: GGUF model not found at $MODEL"
  exit 1
fi

echo "Starting MiniCPM llama-server on port $PORT ..."
echo "Model: $MODEL"

exec "$LLAMA_SERVER" \
  --model "$MODEL" \
  --port "$PORT" \
  --host 127.0.0.1 \
  --ctx-size 2048 \
  --n-predict 512 \
  --cors-allow-origin "*"
