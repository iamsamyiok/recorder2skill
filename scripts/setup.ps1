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
if (-not $node) { throw "Node.js not found. Install Node.js (https://nodejs.org)." }
# Match the vendored recorder's engines range exactly (>=24.19 <25), not just
# the major: 24.6 passing setup then failing npm engines confused a real user.
$nodeVersion = (node --version) -replace '^v', ''
$nodeParts = $nodeVersion.Split('.')
$nodeMajor = [int]$nodeParts[0]
$nodeMinor = if ($nodeParts.Count -gt 1) { [int]$nodeParts[1] } else { 0 }
if (($nodeMajor -lt 24) -or ($nodeMajor -eq 24 -and $nodeMinor -lt 19) -or ($nodeMajor -ge 25)) {
  throw "Node.js >=24.19 <25 required (found v$nodeVersion). The vendored recorder pins engines >=24.19 <25."
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
  # ELECTRON_MIRROR. On failure, retry once via the npmmirror mirror —
  # github.com / electronjs.org downloads are frequently reset for users
  # behind the GFW (a real user had to wire this by hand).
  Write-Host "==> electron binary missing (postinstall skipped?). Running electron's installer directly..."
  Push-Location $vendor
  try {
    node node_modules\electron\install.js
    if ($LASTEXITCODE -ne 0) {
      Write-Host "==> electron download failed; retrying via https://npmmirror.com/mirrors/electron/ ..."
      $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
      node node_modules\electron\install.js
      if ($LASTEXITCODE -ne 0) { throw "electron installer failed (also via npmmirror)" }
    }
  } finally {
    Pop-Location
  }
}
if (-not (Test-Path $electronExe)) {
  throw "electron.exe not found at $electronExe - the electron download failed even via the npmmirror fallback. Check network/proxy, or set ELECTRON_MIRROR yourself, then re-run setup."
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
