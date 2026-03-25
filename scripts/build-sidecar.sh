#!/bin/bash
# Build the Python sidecar binary with PyInstaller and rename it
# with the Rust target triple (required by Tauri's externalBin).
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Source cargo env if available
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

# Get the Rust target triple
TRIPLE=$(rustc -vV | grep 'host:' | awk '{print $2}')
if [ -z "$TRIPLE" ]; then
    echo "ERROR: Could not determine Rust target triple. Is rustc installed?"
    exit 1
fi

echo "Building sidecar for target: ${TRIPLE}"

# Build with PyInstaller — exclude heavy unused packages
cd "$PROJECT_ROOT"
pyinstaller \
    --onefile \
    --name ghostchat-server \
    --strip \
    --distpath src-tauri/binaries \
    --workpath build/pyinstaller \
    --specpath build \
    --exclude-module numpy \
    --exclude-module PIL \
    --exclude-module Pillow \
    --exclude-module tkinter \
    --exclude-module _tkinter \
    --exclude-module matplotlib \
    --exclude-module scipy \
    --exclude-module pandas \
    --exclude-module pytest \
    --exclude-module pygments \
    --exclude-module rich \
    --exclude-module chardet \
    backend/sidecar_entry.py

# Rename with target triple suffix
if [ -f "src-tauri/binaries/ghostchat-server" ]; then
    mv "src-tauri/binaries/ghostchat-server" "src-tauri/binaries/ghostchat-server-${TRIPLE}"
    echo "Sidecar built: src-tauri/binaries/ghostchat-server-${TRIPLE}"
elif [ -f "src-tauri/binaries/ghostchat-server.exe" ]; then
    mv "src-tauri/binaries/ghostchat-server.exe" "src-tauri/binaries/ghostchat-server-${TRIPLE}.exe"
    echo "Sidecar built: src-tauri/binaries/ghostchat-server-${TRIPLE}.exe"
else
    echo "ERROR: PyInstaller output not found"
    exit 1
fi

echo "Done."
