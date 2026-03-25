# Build the Python sidecar binary with PyInstaller and rename it
# with the Rust target triple (required by Tauri's externalBin).
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-sidecar.ps1

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)

# Get the Rust target triple
$RustcOutput = rustc -vV
$Triple = ($RustcOutput | Select-String "host:").ToString().Split(" ")[1]
if (-not $Triple) {
    Write-Error "Could not determine Rust target triple. Is rustc installed?"
    exit 1
}

Write-Host "Building sidecar for target: $Triple"

Set-Location $ProjectRoot
pyinstaller `
    --onefile `
    --name ghostchat-server `
    --distpath src-tauri/binaries `
    --workpath build/pyinstaller `
    --specpath build `
    --exclude-module numpy `
    --exclude-module PIL `
    --exclude-module Pillow `
    --exclude-module tkinter `
    --exclude-module _tkinter `
    --exclude-module matplotlib `
    --exclude-module scipy `
    --exclude-module pandas `
    --exclude-module pytest `
    --exclude-module pygments `
    --exclude-module rich `
    --exclude-module chardet `
    backend/sidecar_entry.py

$Exe = "src-tauri/binaries/ghostchat-server.exe"
$Target = "src-tauri/binaries/ghostchat-server-$Triple.exe"

if (Test-Path $Exe) {
    Move-Item -Force $Exe $Target
    Write-Host "Sidecar built: $Target"
} else {
    Write-Error "PyInstaller output not found"
    exit 1
}

Write-Host "Done."
