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
  echo "ERROR: Node.js not found. Install Node.js 24 (https://nodejs.org)." >&2
  exit 1
fi
NODE_MAJOR="$(node --version | sed -E 's/^v([0-9]+)\..*$/\1/')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "ERROR: Node.js 24.x required (found $(node --version)). The vendored recorder pins engines >=24.19 <25." >&2
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
  echo "ERROR: electron binary not found at $ELECTRON_BIN" >&2
  echo "The electron postinstall download failed. Check network/proxy, then re-run: npm ci in $VENDOR" >&2
  exit 1
fi
chmod +x "$ELECTRON_BIN" 2>/dev/null || true

DATA_DIR="${RECORDER_DEMO_DATA_DIR:-$HOME/.recorder-demo}"
mkdir -p "$DATA_DIR/sessions" "$DATA_DIR/skills" "$DATA_DIR/logs"

echo ""
echo "Setup complete."
echo "  vendor app : $VENDOR/dist-electron/main.js"
echo "  data dir   : $DATA_DIR"
echo ""
echo "Next:"
echo "  1. Set your model key (environment variable, not hardcoded):"
echo '       export OPENCODE_API_KEY="<your OpenCode Zen key>"'
echo "  2. Start the agent in this directory:  opencode"
echo "  3. Say: start recording my screen, then turn it into a skill"
echo ""
echo "Linux notes:"
echo "  - X11 session recommended (Wayland needs XWayland; screen capture follows the"
echo "    desktop portal). The recorder degrades gracefully without a display server."
echo "  - Browser URL capture is macOS/Windows only; on Linux the timeline still gets"
echo "    app switches, window titles and clipboard events."
echo "  - If Electron fails to launch, install runtime libs, e.g. on Debian/Ubuntu:"
echo "    sudo apt-get install -y libgtk-3-0 libnss3 libasound2 libgbm1 libxss1"
