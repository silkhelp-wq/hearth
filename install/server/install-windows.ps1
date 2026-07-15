# Hearth server — installer for Windows.
#   Right-click -> Run with PowerShell   (or:  powershell -ExecutionPolicy Bypass -File install-windows.ps1)
# Installs dependencies and starts the server. Keep the window open while hosting.
$ErrorActionPreference = "Stop"
function Say($m) { Write-Host "==> $m" -ForegroundColor Green }

Write-Host "Hearth — Windows server installer" -ForegroundColor Cyan
Write-Host "This will:"
Write-Host "  1. Install the server's dependencies"
Write-Host "  2. Start the server IN THIS WINDOW (keep it open while friends are connected)"
Write-Host "  3. Print your OWNER CLAIM CODE — paste it into the Hearth app (Settings -> Server)"
Write-Host ""
Write-Host "You need Node.js 22+ installed (https://nodejs.org)."
$null = Read-Host "Press Enter to continue (Ctrl-C to cancel)"

try { $null = node -v } catch { throw "Node.js is not installed. Get Node 22+ from https://nodejs.org then re-run." }
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { throw "Node.js 20+ required (you have $(node -v))." }

Set-Location $PSScriptRoot
Say "Installing server dependencies (compiles native pieces; give it a minute)…"
npm install --omit=dev

$data = if ($env:HEARTH_DATA_DIR) { $env:HEARTH_DATA_DIR } else { "$env:LOCALAPPDATA\Hearth\data" }
New-Item -ItemType Directory -Force -Path $data | Out-Null
$env:HEARTH_DATA_DIR = $data

Say "Starting the Hearth server. Keep this window OPEN while your friends are connected."
Say "Your owner claim code will appear below — type it into the app (Settings -> Server)."
Write-Host ""
node src/index.js
