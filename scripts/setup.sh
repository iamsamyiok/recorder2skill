#!/usr/bin/env bash
# Recorder Demo setup (Linux). Run:
#   bash scripts/setup.sh
set -euo pipefail

have() { command -v "$1" >/dev/null 2>&1; }

if [ "$(uname -s)" != "Linux" ]; then
  echo "This setup script targets Linux (Windows uses scripts\\setup.ps1)." >&2
  exit 1
fi

if ! have node; then
  echo "ERROR: Node.js not found. Install Node.js (https://nodejs.org)." >&2
  exit 1
fi
# Match the vendored recorder's engines range exactly (>=24.19 <25), not just
# the major: 24.6 passing setup then failing npm engines confused a real user.
NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_MINOR="$(echo "$NODE_VERSION" | cut -d. -f2)"
if [ "${NODE_MAJOR:-0}" -lt 24 ] || { [ "${NODE_MAJOR:-0}" -eq 24 ] && [ "${NODE_MINOR:-0}" -lt 19 ]; } || [ "${NODE_MAJOR:-0}" -ge 25 ]; then
  echo "ERROR: Node.js >=24.19 <25 required (found v$NODE_VERSION). The vendored recorder pins engines >=24.19 <25." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor/skill-recorder"

echo "==> Installing vendor dependencies (npm ci)..."
(cd "$VENDOR" && npm ci)

echo "==> Building vendor app (tsc + vite, produces dist-electron/main.js)..."
(cd "$VENDOR" && npm run build)

ELECTRON_BIN="$VENDOR/node_modules/electron/dist/electron"
if [ ! -f "$ELECTRON_BIN" ]; then
  # Some npm setups (allow-scripts policies, --ignore-scripts) skip the
  # electron postinstall. Run the official installer directly; it honors
  # ELECTRON_MIRROR. On failure, retry once via the npmmirror mirror —
  # github.com / electronjs.org downloads are frequently reset for users
  # behind the GFW (a real user had to wire this by hand).
  echo "==> electron binary missing (postinstall skipped?). Running electron's installer directly..."
  if ! (cd "$VENDOR" && node node_modules/electron/install.js); then
    echo "==> electron download failed; retrying via https://npmmirror.com/mirrors/electron/ ..."
    (cd "$VENDOR" && ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js)
  fi
fi
if [ ! -f "$ELECTRON_BIN" ]; then
  echo "ERROR: electron binary not found at $ELECTRON_BIN" >&2
  echo "The electron download failed even via the npmmirror fallback." >&2
  echo "Check network/proxy, or set ELECTRON_MIRROR yourself, then re-run setup." >&2
  exit 1
fi
chmod +x "$ELECTRON_BIN" 2>/dev/null || true

# Data-root resolution mirrors scripts/recorder-cli.mjs: new env var, legacy
# env var alias, then keep an existing legacy default dir (upgrades keep
# their history), else the recorder2skill default.
LEGACY_DATA_DIR="$HOME/.recorder-demo"
DEFAULT_DATA_DIR="$HOME/.recorder2skill"
if [ -n "${RECORDER2SKILL_DATA_DIR:-}" ]; then
  DATA_DIR="$RECORDER2SKILL_DATA_DIR"
elif [ -n "${RECORDER_DEMO_DATA_DIR:-}" ]; then
  DATA_DIR="$RECORDER_DEMO_DATA_DIR"
elif [ -d "$LEGACY_DATA_DIR" ]; then
  DATA_DIR="$LEGACY_DATA_DIR"
else
  DATA_DIR="$DEFAULT_DATA_DIR"
fi
mkdir -p "$DATA_DIR/sessions" "$DATA_DIR/skills" "$DATA_DIR/logs"

echo ""
echo "Setup complete."
echo "  vendor app : $VENDOR/dist-electron/main.js"
echo "  data dir   : $DATA_DIR"
echo ""
echo "Next:"
echo "  1. Verify the install:  node scripts/recorder-cli.mjs doctor"
echo "  2. Install the analysis skill into your agent (see README, step 2),"
echo "     then set your model key for the agent itself (env, not hardcoded):"
echo '       export AGNES_API_KEY="<your key>"   # default provider in opencode.json'
echo "  3. Record:  node scripts/recorder-cli.mjs start"
echo ""
echo "Linux notes:"
echo "  - X11 session recommended (Wayland needs XWayland; screen capture follows the"
echo "    desktop portal). The recorder degrades gracefully without a display server."
echo "  - Browser URL capture is macOS/Windows only; on Linux the timeline still gets"
echo "    app switches, window titles and clipboard events."
echo "  - If Electron fails to launch, install runtime libs, e.g. on Debian/Ubuntu:"
echo "    sudo apt-get install -y libgtk-3-0 libnss3 libasound2 libgbm1 libxss1"
