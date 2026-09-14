# Recorder Demo Skill (Windows + Linux)

Record a task once on screen, then let OpenCode turn it into a standard
`SKILL.md` — a minimal, Windows/Linux derivative of
[microsoft/skill-recorder](https://github.com/microsoft/skill-recorder) (MIT).

The recording core is the original project, vendored unmodified except for one
marked bootstrap patch (see [PATCHES.md](PATCHES.md)):

- screen + window recording (Chromium capture, always-on-top control bar with
  Stop),
- local event collection (app/window switches, titles, browser URLs,
  clipboard previews),
- on-stop pipeline: FFmpeg-backed frame extraction fallback + snapshot
  extraction with perceptual-hash (dHash) dedupe, event correlation, timeline
  `bundle.json`.

What changed: the original's GitHub Copilot describer/skill-builder is
REPLACED by OpenCode. A plugin registers custom tools via the OpenCode plugin
SDK; the OpenCode agent (its own model interface) does the step splitting and
semantic mapping, then writes the standard `SKILL.md`.

```
┌─────────────┐   recorder_start    ┌──────────────────────────────────┐
│ OpenCode    │ ──────────────────► │ vendor/skill-recorder (Electron) │
│ agent       │                     │ control bar pops up -> user works │
│ (model via  │                     │ -> user clicks Stop -> pipeline   │
│ env key)    │ ◄────────────────── │ -> READY.json                     │
└────┬────────┘  recorder_wait_ready└──────────────────────────────────┘
     │  recorder_get_timeline / get_events / list_frames
     ▼
 SKILL.md -> recorder_save_skill -> <data-root>\skills\<name>\SKILL.md
```

## Requirements

- Windows 10/11 (x64/ARM64) or Linux (x64/ARM64) with a desktop session — the
  demo refuses to run elsewhere. On Linux, browser-URL events degrade to app
  switches + window titles + clipboard (URL capture is macOS/Windows in the
  vendor); X11 is the smooth path, Wayland via XWayland.
- Node.js 24.x (the vendored recorder pins `>=24.19 <25`)
- OpenCode CLI
- An LLM API key for one of the configured providers — read from the
  environment, never hardcoded. Defaults to Agnes AI (`AGNES_API_KEY`,
  see `opencode.json`); OpenCode Zen (`OPENCODE_API_KEY`) also works.

## Layout

```
recorder-demo\
├── vendor\skill-recorder\   original project (MIT) + marked patch
├── .opencode\plugins\       OpenCode plugin: recorder_* custom tools
├── scripts\                 setup.ps1 / setup.sh, recorder-cli.mjs
├── AGENTS.md                agent brief (adapted from the original briefs)
├── opencode.json            OpenCode config
├── config\env.example       key placeholder (copy into env, not files)
├── PATCHES.md               every change to the vendor, itemized
└── LICENSE                  MIT (original retained + attribution)
```

All recorded data stays local under the demo data root (`sessions\`,
`skills\`, `logs\`): `C:\temp\recorder-demo` on Windows, `~/.recorder-demo`
on Linux. Override both with `RECORDER_DEMO_DATA_DIR`.

## Setup (PowerShell)

```powershell
# 1. Get the project onto disk (e.g. C:\dev\recorder-demo or ~/recorder-demo), then:
cd C:\dev\recorder-demo        # Windows (PowerShell)
cd ~/recorder-demo             # Linux

# 2. Install + build the vendored recorder (npm ci + tsc/vite build)
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1   # Windows
bash scripts/setup.sh                                        # Linux

# 3. Provide the model key as an environment variable (session-scoped)
$env:AGNES_API_KEY = "<your Agnes key>"        # default provider (opencode.json)
$env:OPENCODE_API_KEY = "<your Zen key>"       # optional alternative

# 4. Start the agent in the project root
opencode
```

Inside OpenCode, the default model is `agnes/agnes-2.5-flash` (Agnes AI,
OpenAI-compatible); `/models` lists it plus any other configured providers
(e.g. OpenCode Zen). Keys come from environment variables; `opencode.json`
pins no credentials.

## Run it

Say to the agent:

> start recording my screen; I'll do the task, then turn it into a skill

The agent will:

1. call `recorder_start` — the recorder window + floating control bar pop up
   and recording begins,
2. wait while you do the task; click **Stop** on the bar (or `Ctrl+Shift+R`)
   when done,
3. call `recorder_wait_ready` — picks up the processed session (timeline,
   events, frames, dedupe stats),
4. read the timeline/events (and a few frames only where ambiguous), split
   the session into intent + ordered steps, map each step to native tools,
5. call `recorder_save_skill` — writes
   `<data-root>\skills\<name>\SKILL.md` and reports the path.

Success = the SKILL.md exists on disk and is a valid Agent Skills file
(YAML frontmatter `name`/`description`/`allowed-tools` + imperative body).

### Example

A 22-second recording of a terminal task (focus an xterm, echo a marker,
stage a token with `xclip`, flip to a notes window) produced this timeline:

```
steps:
  0. atMs   492  skill-recorder — Skill Recorder        (1 frame)
  1. atMs  4593  XTerm — terminal - demo task           (2 frames, 1 clipboard)
events: app.activate x2 · clipboard.change ("ghp_demo_token_123") ·
        app.title-change x2 ("README.md - notes" → "terminal - demo task")
```

…from which the agent generalized and saved
`~/.recorder-demo/skills/stage-token-in-clipboard-linux/SKILL.md` — a skill
covering any token-staging flow (xclip/wl-copy, verification, cleanup), with
`allowed-tools` pinned to the exact shell patterns involved. The same round
trip works for multi-step browser/IDE tasks: apps, titles, URLs and clipboard
text give the intent; frames settle anything the events leave ambiguous.

### CLI-only usage (without the agent)

```powershell
node scripts\recorder-cli.mjs start          # launch + autostart recording
# ... do the task, click Stop on the floating bar ...
node scripts\recorder-cli.mjs wait-ready 600 # block until processed
node scripts\recorder-cli.mjs last           # newest session summary
```

## Data locations

| Path | Contents |
| --- | --- |
| `<data-root>\sessions\<id>\` | `session.json`, `events.jsonl`, `video.webm`, `frames\` (JPEG + `frames.json` manifest), `bundle.json`, `correlation.json` |
| `<data-root>\skills\<name>\SKILL.md` | generated skills |
| `<data-root>\logs\` | launch records (`launch.json`), live-recording marker (`recording.json`), recorder console log (`recorder.log`) |

The root defaults to `C:\temp\recorder-demo` on Windows and `~/.recorder-demo`
on Linux; override with the `RECORDER_DEMO_DATA_DIR` environment variable.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `setup.ps1` rejects the Node version | Install Node.js 24.x (`>=24.19 <25` is pinned by the vendor); `node --version` to confirm. |
| `Missing electron binary` / `dist-electron/main.js` on `start` | Run `scripts\setup.ps1` (Windows) or `scripts/setup.sh` (Linux) to completion; if the electron binary download failed, re-run `npm ci` inside `vendor/skill-recorder`. |
| Linux: Electron fails to launch with missing-library errors | Install runtime libs: `sudo apt-get install -y libgtk-3-0 libnss3 libasound2 libgbm1 libxss1`. |
| Linux (root/containers): `Running as root without --no-sandbox` | Expected under root; the CLI passes `--no-sandbox` automatically in that case. Regular desktop users are unaffected. |
| No floating control bar after `start` | The recorder window opens behind other windows; check the taskbar. If a second start was refused, a recorder is already running — finish it (`wait-ready`) or use `start --force`. |
| `wait-ready` times out | The recording is still running (or was discarded). Click Stop on the bar, or re-run `wait-ready 3600` while you keep working. |
| `/models` shows nothing usable | Set `$env:AGNES_API_KEY` (default provider) or `$env:OPENCODE_API_KEY` (Zen) in the same shell before launching `opencode`, then run `/connect` to verify the provider entry. |
| `recorder_get_timeline` says bundle missing | The session is still post-processing; call `recorder_wait_ready` first. |

## Scope and limits (by design)

- macOS is left out of the demo CLI even though the vendor supports it; the
  analysis quality on Linux mirrors the vendor's platform support (no browser
  URL events — app/title/clipboard signals carry the timeline).
- No production hardening: the bootstrap trusts env vars, waits are simple
  polls, and failures surface as plain errors.
- Keep secrets out of recordings; the analysis content stays on your machine
  except the parts you send to your model provider via OpenCode.
- The vendored Copilot modules are dead code in this demo (never invoked);
  they remain only to keep the vendor diff minimal.

## License

MIT. The vendored source keeps its original MIT license; all modifications
are listed in [PATCHES.md](PATCHES.md) and marked with `[RECORDER-DEMO]`
blocks in code.
