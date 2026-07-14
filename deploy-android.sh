#!/usr/bin/env bash
# deploy-android.sh — Build, push, and run MiniCPM on an Android device via ADB.
#
# Automates the full pipeline:
#   1. Cross-compile llama-server for Android arm64 (or reuse a cached build)
#   2. Push binary + GGUF model to the device
#   3. Start the server on-device at port 18766
#
# The Battlegrid PWA running in Chrome on the same phone connects to
# http://127.0.0.1:18766 — no port forwarding needed.
#
# Prerequisites:
#   - adb (Android platform-tools)
#   - Android NDK (auto-detected from ~/Library/Android/sdk or ANDROID_NDK env)
#   - cmake, git
#   - USB debugging enabled on the phone

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODEL_FILE="MiniCPM5-1B-Claude-Opus-Fable5-Thinking-Q4_K_M.gguf"
MODEL_URL="https://github.com/moniS17/game/releases/download/model-v1/$MODEL_FILE"
MODEL_CACHE="$SCRIPT_DIR/.cache"
LLAMA_SRC="$SCRIPT_DIR/../llama.cpp"
BUILD_DIR="$LLAMA_SRC/build-android"
ANDROID_DIR="/data/local/tmp/battlegrid-cpm"
PORT=18766

# ── Colours ──────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

log()  { printf "${GREEN}[✓]${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}[!]${NC} %s\n" "$1"; }
err()  { printf "${RED}[✗]${NC} %s\n" "$1" >&2; exit 1; }
info() { printf "${BLUE}[·]${NC} %s\n" "$1"; }

# ── Step 1: Check prerequisites ─────────────────────────────────────────
command -v adb   >/dev/null 2>&1 || err "adb not found — install Android platform-tools."
command -v cmake >/dev/null 2>&1 || err "cmake not found — brew install cmake"
command -v git   >/dev/null 2>&1 || err "git not found."

DEVICE=$(adb devices 2>/dev/null | awk '/\tdevice$/{print $1; exit}')
[ -z "$DEVICE" ] && err "No Android device connected. Plug in via USB and enable USB debugging."
log "Device: $DEVICE"

ARCH=$(adb -s "$DEVICE" shell getprop ro.product.cpu.abi | tr -d '\r')
info "Architecture: $ARCH"
[[ "$ARCH" == arm64* || "$ARCH" == aarch64* ]] \
  || warn "Expected arm64-v8a, got $ARCH — the binary may not run."

# ── Step 2: Find the Android NDK ────────────────────────────────────────
if [ -z "${ANDROID_NDK:-}" ]; then
  for candidate in \
    "$HOME/Library/Android/sdk/ndk/"*/    \
    "$HOME/Android/Sdk/ndk/"*/            \
    /opt/homebrew/share/android-ndk       \
    /opt/android-ndk-*; do
    if [ -f "${candidate%/}/build/cmake/android.toolchain.cmake" ]; then
      ANDROID_NDK="${candidate%/}"
      break
    fi
  done
fi
[ -z "${ANDROID_NDK:-}" ] && err "Android NDK not found. Set ANDROID_NDK or install via Android Studio."
log "NDK: $ANDROID_NDK"

# ── Step 3: Get llama.cpp source ─────────────────────────────────────────
if [ ! -d "$LLAMA_SRC/CMakeLists.txt" ] && [ ! -f "$LLAMA_SRC/CMakeLists.txt" ]; then
  info "Cloning llama.cpp …"
  git clone --depth 1 https://github.com/ggml-org/llama.cpp "$LLAMA_SRC"
  log "Cloned llama.cpp."
else
  log "llama.cpp source present."
fi

# ── Step 4: Cross-compile llama-server for Android arm64 ─────────────────
LLAMA_BIN="$BUILD_DIR/bin/llama-server"

if [ -f "$LLAMA_BIN" ]; then
  log "Cached Android llama-server found — skipping build."
else
  info "Cross-compiling llama-server for Android arm64 …"
  mkdir -p "$BUILD_DIR"

  cmake -B "$BUILD_DIR" -S "$LLAMA_SRC" \
    -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK/build/cmake/android.toolchain.cmake" \
    -DANDROID_ABI=arm64-v8a \
    -DANDROID_PLATFORM=android-28 \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_OPENMP=OFF \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_EXAMPLES=OFF \
    -DLLAMA_BUILD_SERVER=ON

  JOBS=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
  cmake --build "$BUILD_DIR" --config Release --target llama-server -j"$JOBS"

  [ -f "$LLAMA_BIN" ] || err "Build failed — llama-server binary not produced."
  log "Build complete."
fi

# ── Step 5: Download model from GitHub (or use local cache) ─────────────
MODEL_PATH="$MODEL_CACHE/$MODEL_FILE"
mkdir -p "$MODEL_CACHE"

# Also check the sibling directory for a local copy
LOCAL_COPY="$SCRIPT_DIR/../MiniCPM5-1B-Claude-Opus-Fable5-Thinking-GGUF/$MODEL_FILE"
if [ -f "$MODEL_PATH" ]; then
  log "Model found in cache."
elif [ -f "$LOCAL_COPY" ]; then
  info "Copying model from local directory …"
  cp "$LOCAL_COPY" "$MODEL_PATH"
  log "Model cached from local copy."
else
  info "Downloading model from GitHub (~656 MB) …"
  command -v curl >/dev/null 2>&1 || err "curl not found — needed to download the model."
  curl -L --progress-bar -o "$MODEL_PATH.tmp" "$MODEL_URL"
  mv "$MODEL_PATH.tmp" "$MODEL_PATH"
  log "Model downloaded."
fi
MODEL_SIZE_H=$(du -h "$MODEL_PATH" | cut -f1)
log "Model: $MODEL_FILE ($MODEL_SIZE_H)"

# ── Step 6: Push binary to device ───────────────────────────────────────
adb -s "$DEVICE" shell "mkdir -p $ANDROID_DIR" 2>/dev/null
info "Pushing llama-server binary …"
adb -s "$DEVICE" push "$LLAMA_BIN" "$ANDROID_DIR/llama-server" >/dev/null
adb -s "$DEVICE" shell "chmod 755 $ANDROID_DIR/llama-server"
log "Binary deployed."

# ── Step 7: Push model (skip if same size already on device) ────────────
LOCAL_SIZE=$(wc -c < "$MODEL_PATH" | tr -d ' ')
REMOTE_SIZE=$(adb -s "$DEVICE" shell "wc -c < $ANDROID_DIR/$MODEL_FILE 2>/dev/null || echo 0" | tr -d '\r ')

if [ "$LOCAL_SIZE" = "$REMOTE_SIZE" ]; then
  log "Model already on device (size matches) — skipping push."
else
  info "Pushing model ($MODEL_SIZE_H) … this may take a few minutes."
  adb -s "$DEVICE" push "$MODEL_PATH" "$ANDROID_DIR/$MODEL_FILE"
  log "Model deployed."
fi

# ── Step 8: Kill any old server, start a fresh one ──────────────────────
adb -s "$DEVICE" shell "pkill -f 'llama-server.*--port $PORT' 2>/dev/null || true"
sleep 1

info "Starting MiniCPM server on device (port $PORT) …"
adb -s "$DEVICE" shell "cd $ANDROID_DIR && nohup ./llama-server \
  --model $MODEL_FILE \
  --port $PORT \
  --host 127.0.0.1 \
  --ctx-size 2048 \
  --n-predict 512 \
  --cors-allow-origin '*' \
  > /data/local/tmp/battlegrid-cpm.log 2>&1 &"

# ── Step 9: Wait for health check ───────────────────────────────────────
info "Waiting for server to become ready …"
READY=0
for i in $(seq 1 20); do
  HEALTH=$(adb -s "$DEVICE" shell "curl -s http://127.0.0.1:$PORT/health 2>/dev/null" | tr -d '\r')
  if echo "$HEALTH" | grep -qi 'ok'; then
    READY=1
    break
  fi
  sleep 2
done

echo ""
echo "════════════════════════════════════════════════════════════════"
if [ "$READY" -eq 1 ]; then
  printf " ${GREEN}${BOLD}MiniCPM is running on Android!${NC}\n"
else
  printf " ${YELLOW}${BOLD}Server pushed — may still be loading the model.${NC}\n"
  echo " Check logs:  adb shell cat /data/local/tmp/battlegrid-cpm.log"
fi
echo "════════════════════════════════════════════════════════════════"
echo " Device:   $DEVICE ($ARCH)"
echo " Binary:   $ANDROID_DIR/llama-server"
echo " Model:    $ANDROID_DIR/$MODEL_FILE"
echo " Endpoint: http://127.0.0.1:$PORT  (on-device)"
echo ""
echo " Next steps:"
echo "   1. Open Chrome on the phone"
echo "   2. Navigate to your Battlegrid server"
echo "   3. Start a new game → select MiniCPM as AI engine"
echo "════════════════════════════════════════════════════════════════"
