# Patches to vendor/skill-recorder

Base: microsoft/skill-recorder @ `d22be1a66b250c663dde3bf202b04514ba82134c`
(MIT, commit included via `git archive`, no `.git` carried).

Everything under `vendor/skill-recorder/` is the ORIGINAL project except the
changes listed below. All changes are marked in code with
`// [RECORDER-DEMO] begin` / `// [RECORDER-DEMO] end` blocks.

## 1. `electron/main.ts` — added imports

Two lines for the demo bootstrap (`node:fs`, `node:path`) and one re-export
import (`sessionsRoot`) pulled from the project's own `recorder/session-store`.
No behavioral change by themselves.

## 2. `electron/main.ts` — demo bootstrap in `app.whenReady()`

Purpose: let the demo CLI drive the recorder without touching any of the
recording / frame-extraction / phash-dedupe / event-collection code.

Behavior (only when `RECORDER_DEMO_AUTOSTART=1`, which is set exclusively by
`scripts/recorder-cli.mjs`):

1. On launch, start recording immediately (the CLI invocation is the consent
   step; the stock recording-privacy reminder remains in the UI). Once
   recording is actually live, write `logs/recording.json` (sessionId +
   startedAt) under the data root — settings like screen enumeration can take
   tens of seconds on minimal Linux sessions, and `recorder-cli.mjs start`
   polls this marker so it only reports success once recording is real.
2. When the first saved session finishes post-processing (`lastSession
   .processed` fires after the stock pipeline: frame extraction, dHash dedupe,
   `bundle.json`), write `READY.json` into the session directory and quit the
   app so `recorder-cli.mjs wait-ready` can return the session to OpenCode.

The original click-Stop flow (always-on-top control bar), discard flow, tray,
global shortcut, Copilot modules, and all storage code are untouched. The
Copilot-based describer/skill-builder modules remain in the vendor but are
never invoked by the demo: their role (session analysis -> intent + steps ->
SKILL.md) is taken over by the OpenCode agent via the tools registered in
`.opencode/plugins/recorder-demo.ts`.

## Data location

All recorded data lives under the demo data root, overridable with
`RECORDER_DEMO_DATA_DIR`:

- Windows: `C:\temp\recorder-demo` (default)
- Linux: `~/.recorder-demo` (default)

Subfolders: `sessions\`, `skills\`, `logs\`. The sessions root is pointed
there through the original project's own `SKILL_RECORDER_SESSIONS_DIR`
environment variable (no code change needed for storage).

## Platform notes (demo layer, no vendor changes)

- The vendor natively supports macOS and Ubuntu (`install.sh`); the demo
  layer (CLI + plugin + setup scripts) targets Windows and Linux.
- On Linux the vendor's browser-URL collector degrades honestly (no URL
  provider is implemented there upstream): timelines carry app switches,
  window titles and clipboard events instead.
