#!/usr/bin/env bash
# publish-update.sh — Deploy a new Synced update to the home server.
#
# Usage:
#   ./scripts/publish-update.sh <version> [artifacts_dir]
#
# Example:
#   ./scripts/publish-update.sh 1.1.0 ./target/release/bundle
#
# Prerequisites:
#   - SSH access to synced-relay.duckdns.org
#   - Update artifacts built with: cargo tauri build (with TAURI_SIGNING_PRIVATE_KEY set)
#
# The script:
#   1. Finds platform-specific update artifacts and their .sig files
#   2. Generates latest.json manifest
#   3. Uploads everything to the server via SCP

set -euo pipefail

VERSION="${1:?Usage: publish-update.sh <version> [artifacts_dir]}"
ARTIFACTS_DIR="${2:-./src-tauri/target/release/bundle}"
SERVER="synced-relay.duckdns.org"
REMOTE_DIR="/var/www/synced/updates"

echo "Publishing Synced v${VERSION}"
echo "Artifacts dir: ${ARTIFACTS_DIR}"
echo "Server: ${SERVER}:${REMOTE_DIR}"
echo ""

# Collect platform artifacts
declare -A PLATFORMS
declare -A SIGNATURES

# Linux — AppImage
LINUX_ARTIFACT=$(find "${ARTIFACTS_DIR}" -name "*.AppImage.tar.gz" 2>/dev/null | head -1)
if [ -n "${LINUX_ARTIFACT}" ] && [ -f "${LINUX_ARTIFACT}.sig" ]; then
    PLATFORMS["linux-x86_64"]="${LINUX_ARTIFACT}"
    SIGNATURES["linux-x86_64"]=$(cat "${LINUX_ARTIFACT}.sig")
    echo "Found Linux: $(basename "${LINUX_ARTIFACT}")"
fi

# Windows — NSIS
WINDOWS_ARTIFACT=$(find "${ARTIFACTS_DIR}" -name "*-setup.nsis.zip" 2>/dev/null | head -1)
if [ -n "${WINDOWS_ARTIFACT}" ] && [ -f "${WINDOWS_ARTIFACT}.sig" ]; then
    PLATFORMS["windows-x86_64"]="${WINDOWS_ARTIFACT}"
    SIGNATURES["windows-x86_64"]=$(cat "${WINDOWS_ARTIFACT}.sig")
    echo "Found Windows: $(basename "${WINDOWS_ARTIFACT}")"
fi

# macOS — DMG (aarch64)
MACOS_ARTIFACT=$(find "${ARTIFACTS_DIR}" -name "*.app.tar.gz" 2>/dev/null | head -1)
if [ -n "${MACOS_ARTIFACT}" ] && [ -f "${MACOS_ARTIFACT}.sig" ]; then
    PLATFORMS["darwin-aarch64"]="${MACOS_ARTIFACT}"
    SIGNATURES["darwin-aarch64"]=$(cat "${MACOS_ARTIFACT}.sig")
    echo "Found macOS: $(basename "${MACOS_ARTIFACT}")"
fi

if [ ${#PLATFORMS[@]} -eq 0 ]; then
    echo "ERROR: No update artifacts found in ${ARTIFACTS_DIR}"
    echo "Build with: TAURI_SIGNING_PRIVATE_KEY=\$(cat ~/.tauri/synced.key) cargo tauri build"
    exit 1
fi

echo ""
echo "Generating latest.json..."

# Build platforms JSON
PLATFORM_JSON=""
for platform in "${!PLATFORMS[@]}"; do
    ARTIFACT="${PLATFORMS[$platform]}"
    FILENAME=$(basename "${ARTIFACT}")
    SIG="${SIGNATURES[$platform]}"

    [ -n "${PLATFORM_JSON}" ] && PLATFORM_JSON="${PLATFORM_JSON},"
    PLATFORM_JSON="${PLATFORM_JSON}
    \"${platform}\": {
      \"url\": \"https://${SERVER}/updates/${FILENAME}\",
      \"signature\": \"${SIG}\"
    }"
done

PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > /tmp/synced-latest.json << MANIFEST
{
  "version": "${VERSION}",
  "notes": "Synced v${VERSION}",
  "pub_date": "${PUB_DATE}",
  "platforms": {${PLATFORM_JSON}
  }
}
MANIFEST

echo "Generated latest.json:"
cat /tmp/synced-latest.json
echo ""

# Upload artifacts
echo "Uploading to ${SERVER}..."
ssh "${SERVER}" "mkdir -p ${REMOTE_DIR}"

for platform in "${!PLATFORMS[@]}"; do
    ARTIFACT="${PLATFORMS[$platform]}"
    echo "  Uploading $(basename "${ARTIFACT}")..."
    scp -q "${ARTIFACT}" "${SERVER}:${REMOTE_DIR}/"
    scp -q "${ARTIFACT}.sig" "${SERVER}:${REMOTE_DIR}/"
done

echo "  Uploading latest.json..."
scp -q /tmp/synced-latest.json "${SERVER}:${REMOTE_DIR}/latest.json"
rm /tmp/synced-latest.json

echo ""
echo "Published Synced v${VERSION} to https://${SERVER}/updates/latest.json"
echo "Platforms: ${!PLATFORMS[*]}"
