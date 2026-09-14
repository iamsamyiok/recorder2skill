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

# Data-root resolution mirrors scripts/recorder-cli.mjs (new env var, legacy
# alias, keep an existing legacy default dir, else the recorder2skill default).
$legacyDataDir = "C:\temp\recorder-demo"
$defaultDataDir = "C:\temp\recorder2skill"
$dataDir =
  if ($env:RECORDER2SKILL_DATA_DIR) { $env:RECORDER2SKILL_DATA_DIR }
  elseif ($env:RECORDER_DEMO_DATA_DIR) { $env:RECORDER_DEMO_DATA_DIR }
  elseif (Test-Path $legacyDataDir) { $legacyDataDir }
  else { $defaultDataDir }
foreach ($sub in @("sessions", "skills", "logs")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $dataDir $sub) | Out-Null
}

$electronExe = Join-Path $vendor "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electronExe)) {
  # Some npm setups (allow-scripts policies, --ignore-scripts) skip the
  # electron postinstall. Run the official installer directly; it honors
  # ELECTRON_MIRROR.
  Write-Host "==> electron binary missing (postinstall skipped?). Running electron's installer directly..."
  Push-Location $vendor
  try {
    node node_modules\electron\install.js
    if ($LASTEXITCODE -ne 0) { throw "electron installer failed" }
  } finally {
    Pop-Location
  }
}
if (-not (Test-Path $electronExe)) {
  throw "electron.exe not found at $electronExe - the electron download failed. Check network/proxy or set ELECTRON_MIRROR, then re-run setup."
}

Write-Host ""
Write-Host "Setup complete."
Write-Host "  vendor app : $vendor\dist-electron\main.js"
Write-Host "  data dir   : $dataDir"
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Verify the install:  node scripts\recorder-cli.mjs doctor"
Write-Host "  2. Install the analysis skill into your agent (see README, step 2),"
Write-Host "     then set your model key for the agent itself (env, not hardcoded):"
Write-Host '       $env:AGNES_API_KEY = "<your key>"   # default provider in opencode.json'
Write-Host "  3. Record:  node scripts\recorder-cli.mjs start"
