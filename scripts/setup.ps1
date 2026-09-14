# Recorder Demo setup (Windows only). Run in PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSVersion.Major -lt 5) {
  throw "PowerShell 5+ required."
}
if ($env:PROCESSOR_ARCHITECTURE -notmatch "AMD64|ARM64") {
  Write-Warning "This demo is validated on Windows x64/ARM64 only."
}

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw "Node.js not found. Install Node.js 24 (https://nodejs.org)." }
$nodeMajor = [int]((node --version) -replace '^v(\d+)\..*$', '$1')
if ($nodeMajor -lt 24) {
  throw "Node.js 24.x required (found $(node --version)). The vendored recorder pins engines >=24.19 <25."
}

$root = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $root "vendor\skill-recorder"

Write-Host "==> Installing vendor dependencies (npm ci)..."
Push-Location $vendor
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed in $vendor" }

  Write-Host "==> Building vendor app (tsc + vite, produces dist-electron\main.js)..."
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed in $vendor" }
} finally {
  Pop-Location
}

$dataDir = if ($env:RECORDER_DEMO_DATA_DIR) { $env:RECORDER_DEMO_DATA_DIR } else { "C:\temp\recorder-demo" }
foreach ($sub in @("sessions", "skills", "logs")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $dataDir $sub) | Out-Null
}

$electronExe = Join-Path $vendor "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electronExe)) {
  throw "electron.exe not found at $electronExe - the electron postinstall download failed. Check network/proxy, then re-run: npm ci in $vendor"
}

Write-Host ""
Write-Host "Setup complete."
Write-Host "  vendor app : $vendor\dist-electron\main.js"
Write-Host "  data dir   : $dataDir"
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Set your model key (environment variable, not hardcoded):"
Write-Host '       $env:OPENCODE_API_KEY = "<your OpenCode Zen key>"'
Write-Host "  2. Start the agent in this directory:  opencode"
Write-Host "  3. Say: start recording my screen, then turn it into a skill"
