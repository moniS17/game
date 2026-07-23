#!/usr/bin/env bash
# build-android-apk.sh — Build the Battlegrid Android APK.
#
# Bundles all HTML/JS/CSS/SVG game files into a native Android app that
# runs entirely offline — no browser, no server, no GitHub needed.
#
# Prerequisites:
#   - JDK 17+ (java, javac in PATH or JAVA_HOME set)
#   - Android SDK (ANDROID_HOME or ANDROID_SDK_ROOT set, or ~/Library/Android/sdk)
#   - Or: just open the android/ folder in Android Studio and click Build
#
# Usage:
#   ./build-android-apk.sh           # build debug APK
#   ./build-android-apk.sh install   # build + install on connected device
#
# Output: android/app/build/outputs/apk/debug/app-debug.apk
#
# China mirror note: settings.gradle already includes Aliyun Maven mirrors
# so Gradle dependencies download fast without a VPN.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ANDROID_DIR="$SCRIPT_DIR/android"
ASSETS_DIR="$ANDROID_DIR/app/src/main/assets"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

log()  { printf "${GREEN}[✓]${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}[!]${NC} %s\n" "$1"; }
err()  { printf "${RED}[✗]${NC} %s\n" "$1" >&2; exit 1; }
info() { printf "${BLUE}[·]${NC} %s\n" "$1"; }

# ── Step 1: Check Java ─────────────────────────────────────────────────
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
    JAVA="$JAVA_HOME/bin/java"
elif command -v java >/dev/null 2>&1; then
    JAVA="java"
else
    err "Java not found. Install JDK 17+: https://adoptium.net/"
fi
JAVA_VER=$("$JAVA" -version 2>&1 | head -1)
log "Java: $JAVA_VER"

# ── Step 2: Find Android SDK ───────────────────────────────────────────
if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
    for candidate in \
        "$HOME/Library/Android/sdk" \
        "$HOME/Android/Sdk" \
        "/opt/android-sdk" \
        "/usr/local/lib/android/sdk"; do
        if [ -d "$candidate" ]; then
            export ANDROID_HOME="$candidate"
            break
        fi
    done
fi
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -z "$SDK" ] && err "Android SDK not found. Set ANDROID_HOME or install Android Studio."
log "Android SDK: $SDK"

# ── Step 3: Sync game files into assets ─────────────────────────────────
info "Syncing game files into APK assets..."
mkdir -p "$ASSETS_DIR/assets"

# Copy HTML, JS, JSON, TXT
for ext in html js json txt; do
    for f in "$SCRIPT_DIR"/*.$ext; do
        [ -f "$f" ] && cp "$f" "$ASSETS_DIR/"
    done
done

# Copy image/svg assets
for f in "$SCRIPT_DIR"/assets/*.svg "$SCRIPT_DIR"/assets/*.png "$SCRIPT_DIR"/assets/*.webp; do
    [ -f "$f" ] && cp "$f" "$ASSETS_DIR/assets/"
done

log "Game files synced."

# ── Step 4: Build APK ──────────────────────────────────────────────────
cd "$ANDROID_DIR"

info "Building APK (this may take a few minutes on first run)..."
if [ "${1:-}" = "install" ]; then
    ./gradlew installDebug --no-daemon
    log "APK installed on device!"
else
    ./gradlew assembleDebug --no-daemon
fi

APK="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"

echo ""
echo "════════════════════════════════════════════════════════════════"
if [ -f "$APK" ]; then
    SIZE=$(du -h "$APK" | cut -f1)
    printf " ${GREEN}${BOLD}Build successful!${NC}\n"
    echo ""
    echo " APK: $APK"
    echo " Size: $SIZE"
    echo ""
    echo " Install on phone:"
    echo "   adb install -r $APK"
    echo ""
    echo " Or copy the APK to your phone and tap to install."
    echo " (Enable 'Install from unknown sources' in Settings first)"
else
    printf " ${RED}${BOLD}Build failed.${NC}\n"
    echo " Check the output above for errors."
fi
echo "════════════════════════════════════════════════════════════════"
