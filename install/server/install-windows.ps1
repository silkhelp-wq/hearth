# Hearth server — installer for Windows.
#   Right-click -> Run with PowerShell   (or:  powershell -ExecutionPolicy Bypass -File install-windows.ps1)
# Installs dependencies and starts the server. Keep the window open while hosting.
$ErrorActionPreference = "Stop"
function Say($m) { Write-Host "==> $m" -ForegroundColor Green }

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
