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

## 3. `package.json` + `demo-stubs/` — heavy optional deps replaced by local stubs

Three dependencies whose features the demo never uses account for ~970 MB of
`npm install` (and most of its wall time). They are swapped for tiny local
packages under `demo-stubs/` via plain dependency-spec changes (no `npm
overrides`), so the lockfile stays honest:

| Replaced | Stub | Real feature (unused by the demo) | Saved |
| --- | --- | --- | --- |
| `@github/copilot-sdk` | `demo-stubs/copilot-sdk` | Copilot describer / skill builder | ~587 MB |
| `@huggingface/transformers` | `demo-stubs/huggingface-transformers` | Narration transcription (off by default) | ~340 MB incl. onnxruntime |
| `tesseract.js` + `tesseract.js-core` | `demo-stubs/tesseract.js`, `demo-stubs/tesseract.js-core` | Advanced-protection OCR (opt-in) | ~44 MB |

Each stub keeps the exact import surface the vendored code touches (named
exports, ESM where the importer is ESM, `.d.ts` for the compiler) and throws
a loud, specific error if its feature is ever actually invoked, so a
misconfiguration cannot fail silently. The recording / frame-extraction /
dHash-dedupe / event-collection / bundling pipeline never touches these
packages; a full record-to-READY session was re-validated with the stubs in
place.

## 4. `electron/main.ts` — marker hotkey `[RECORDER-DEMO]`

The vendor kept `recorder.marker(note)` capture after removing the "Add
marker" HUD button (in favor of voice narration, which the demo stubs out).
This patch re-exposes a user-facing trigger: a global shortcut
`CommandOrControl+Shift+M` that drops a `marker` event (source `user`,
note = `manual marker at <ISO timestamp>`) into the live event stream while
recording. Markers give the analysis phase intentional step boundaries and
survive in `events.jsonl` / `bundle.json` like any other event.

## 5. Demo layer integration of vendor `common/sensitive.ts` (no vendor change)

The vendor ships dependency-free, checksum-validated structured-PII detectors
(`scanStructuredPii`, `redactText` — email / payment card / SSN / phone).
The demo now applies them at **read time** (raw session files on disk stay
untouched):

- `recorder-cli.mjs events` redacts `textPreview` / `text` / `title` / `url`
  / `note` string fields and reports `redactedFields`; the CLI imports the
  vendor `.ts` directly (Node >= 24 strips the erasable types at import).
- The OpenCode plugin's `recorder_get_events` applies the same redaction to
  every string payload field.
- `summary` / `timeline` (CLI) and `recorder_get_timeline` (plugin) surface
  the vendor describer's `description.md` as a ready-made first-pass
  analysis (`description` / `descriptionPath`).

## Platform notes (demo layer, no vendor changes)

- The vendor natively supports macOS and Ubuntu (`install.sh`); the demo
  layer (CLI + plugin + setup scripts) targets Windows and Linux.
- On Linux the vendor's browser-URL collector degrades honestly (no URL
  provider is implemented there upstream): timelines carry app switches,
  window titles and clipboard events instead.

## 6. Crash-tolerance patterns absorbed from openai/codex (demo layer, no vendor change)

Source study: `codex-rs/rollout/src/recorder.rs` (buffered writer with
`write_pending_with_recovery` / `enter_recovery_mode`), `session_index.rs`
("keep walking" past unsaved or partial session dirs), and `list.rs`
(`read_session_meta_line` continues past unparseable lines).

Adopted in `scripts/recorder-cli.mjs` and `.opencode/plugins/recorder-demo.ts`:

- Read-side tolerance: `sessions` / `timeline` / `doctor` skip session dirs
  whose `session.json` is missing or torn (JSON.parse failure) and count them
  as `partial` instead of failing the whole listing; the plugin's session
  listing does the same silently. `events` continues past unparseable
  `events.jsonl` lines and reports them as `skippedLines` (present in the
  output only when > 0, so healthy sessions keep their old shape).
- Write-side atomicity: state files written by the demo layer (`launch.json`
  ×3, generated `SKILL.md` in CLI and plugin) now go through tmp + `rename`
  (`atomicWriteFileSync`), so a crash can never leave a torn file behind —
  this closes the loop with the read-side tolerance above.
- Evaluated, not adopted: writer reopen-and-retry (`recorder.rs`) — our state
  files are small single-shot writes where tmp+rename already covers the torn
  case; vendor `READY.json`/`recording.json` atomic writes — the CLI treats
  READY.json as existence-only and a torn `recording.json` is recovered by
  re-running `start`.
