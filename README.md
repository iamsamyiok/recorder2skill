# recorder2skill (Windows + Linux)

[![CI](https://github.com/iamsamyiok/recorder2skill/actions/workflows/ci.yml/badge.svg)](https://github.com/iamsamyiok/recorder2skill/actions/workflows/ci.yml)

Record a task once on screen, then let your agent turn it into a standard
`SKILL.md` — a minimal, Windows/Linux derivative of
[microsoft/skill-recorder](https://github.com/microsoft/skill-recorder) (MIT).

Works with ANY agent that can run shell commands and read files (OpenCode,
Claude Code, Codex, ...): every recorder operation is a plain CLI command, and
`skill/recorder2skill/SKILL.md` is a standard Agent Skills file that teaches
the agent the whole flow. The generated `SKILL.md` frontmatter (`name`,
`description`, plus `allowed-tools`) is compatible with OpenCode, Claude Code
and Codex CLI (Codex parses the same frontmatter and ignores unknown fields).
The recording core is the original project, vendored unmodified except for
marked bootstrap patches (see [PATCHES.md](PATCHES.md)):

- screen + window recording (Chromium capture, always-on-top control bar with
  Stop),
- local event collection (app/window switches, titles, browser URLs,
  clipboard previews),
- on-stop pipeline: FFmpeg-backed frame extraction fallback + snapshot
  extraction with perceptual-hash (dHash) dedupe, event correlation, timeline
  `bundle.json`, plus an auto-generated `description.md` first-pass summary,
- `Ctrl/Cmd+Shift+M` drops a marker mid-recording for intentional step
  boundaries,
- structured-PII redaction (email / card / SSN / phone) applied to event text
  previews at read time (vendor detectors; raw values stay on disk).

What changed vs. the original:

- The GitHub Copilot describer/skill-builder is REPLACED by your agent. All
  recorder operations are exposed as `scripts/recorder-cli.mjs` subcommands
  (plain JSON on stdout), so any agent can drive the flow over shell; the
  agent does the step splitting and semantic mapping and writes the standard
  `SKILL.md`.
- Three heavy optional-feature dependencies the demo never uses (Copilot SDK,
  transformers/onnx, tesseract OCR) are swapped for loud-failing local stubs —
  ~970 MB less to download (see PATCHES.md).

```
┌─────────────┐  cli start / wait-ready ┌──────────────────────────────────┐
│ your agent  │ ──────────────────────► │ vendor/skill-recorder (Electron) │
│ (any agent; │                         │ control bar pops up -> user works │
│ model via   │                         │ -> user clicks Stop -> pipeline   │
│ env key)    │ ◄────────────────────── │ -> READY.json                     │
└────┬────────┘  cli timeline / events /└──────────────────────────────────┘
     │           frames (JSON)
     ▼
  agent writes SKILL.md -> cli save-skill -> <data-root>\skills\<name>\SKILL.md
```

## Requirements

- Windows 10/11 (x64/ARM64) or Linux (x64/ARM64) with a desktop session — the
  demo refuses to run elsewhere. On Linux, browser-URL events degrade to app
  switches + window titles + clipboard (URL capture is macOS/Windows in the
  vendor); X11 is the smooth path, Wayland via XWayland.
- Node.js 24.x (the vendored recorder pins `>=24.19 <25`)
- Any agent that can run shell commands and read files (required), or
  optionally the OpenCode CLI for the integrated plugin experience
- An LLM API key for your agent as usual (this repo ships an OpenCode config
  defaulting to Agnes AI via `AGNES_API_KEY`; keys live in the environment,
  never in files)

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
`skills\`, `logs\`): `C:\temp\recorder2skill` on Windows, `~/.recorder2skill`
on Linux. Override with `RECORDER2SKILL_DATA_DIR` (`RECORDER_DEMO_DATA_DIR`
still works as a legacy alias; an existing legacy default directory is used
automatically so upgrades keep their history).

## Setup (PowerShell)

```powershell
# 1. Get the project onto disk (e.g. C:\dev\recorder-demo or ~/recorder-demo), then:
cd C:\dev\recorder-demo        # Windows (PowerShell)
cd ~/recorder-demo             # Linux

# 2. Install + build the vendored recorder (npm ci + tsc/vite build)
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1   # Windows
bash scripts/setup.sh                                        # Linux

#    Slow network? The big download is the Electron binary (~100 MB). Point
#    it at a mirror first, then re-run setup:
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

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

## Use it with any agent

Install the bundled skill into your agent's skills directory:

```bash
# OpenCode (project or global)
cp -r skill/recorder2skill  yourproject/.opencode/skill/
cp -r skill/recorder2skill  ~/.config/opencode/skill/

# Claude Code / other Agent Skills consumers
cp -r skill/recorder2skill  yourproject/.claude/skills/
```

Then tell the agent:

> start recording my screen; I'll do the task, then turn it into a skill

The skill instructs the agent to drive everything through the CLI (each
command prints JSON):

```bash
node scripts/recorder-cli.mjs start            # launch; returns once recording is live
# ... user does the task, clicks Stop (or Ctrl+Shift+R); Ctrl+Shift+M drops a marker ...
node scripts/recorder-cli.mjs wait-ready 600   # blocks until the session is processed
node scripts/recorder-cli.mjs timeline         # ordered steps + auto-generated description
node scripts/recorder-cli.mjs events           # captured events, PII-redacted (--types/--from/--to/--limit)
node scripts/recorder-cli.mjs frames           # kept frames (JPEG paths + phash + reason)
node scripts/recorder-cli.mjs align <id> [more...]  # one recording: step skeleton + hint; two: + parameters
node scripts/recorder-cli.mjs save-skill <name> --description "..." \
  --body-file body.md --tools "Bash(git *),webfetch"   # writes SKILL.md
node scripts/recorder-cli.mjs save-skill <name> ... --script run.mjs   # bundle runnable code under scripts/
node scripts/recorder-cli.mjs archive latest   # move a session to archived-sessions/ (nothing deleted)
node scripts/recorder-cli.mjs sessions --all   # archived sessions stay listed with archived: true
node scripts/skill-doctor.mjs <skillDir>       # validate any SKILL.md (frontmatter + parser limits + script syntax gate)
```

The `description` is written single-line (the format Codex CLI and Claude
Code parsers expect); sessions live until you explicitly `archive` them.
`save-skill` also warns (non-blocking) when a similar skill already exists,
and skills may carry runnable scripts under `scripts/` (syntax-checked by
`skill-doctor`; run them from a project that provides their dependencies).

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

### Use with OpenCode (integrated plugin)

This repo also ships an OpenCode plugin (`.opencode/plugins/recorder-demo.ts`)
registering the same operations as native `recorder_*` tools, plus an
`AGENTS.md` brief and a provider config (default model
`agnes/agnes-2.5-flash` via `AGNES_API_KEY`). Launch `opencode` in the project
root and use the same conversation flow — the agent calls the tools directly
instead of shelling out.

## Data locations

| Path | Contents |
| --- | --- |
| `<data-root>\sessions\<id>\` | `session.json`, `events.jsonl`, `video.webm`, `frames\` (JPEG + `frames.json` manifest), `bundle.json`, `correlation.json`, `description.md` |
| `<data-root>\archived-sessions\<id>\` | same layout; moved there by `archive` (never deleted) |
| `<data-root>\skills\<name>\SKILL.md` | generated skills |
| `<data-root>\logs\` | launch records (`launch.json`), live-recording marker (`recording.json`), recorder console log (`recorder.log`) |

The root defaults to `C:\temp\recorder2skill` on Windows and `~/.recorder2skill`
on Linux; override with the `RECORDER2SKILL_DATA_DIR` environment variable
(`RECORDER_DEMO_DATA_DIR` is a legacy alias; a pre-existing legacy default
directory keeps being used automatically).

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
  except the parts you send to your model provider.
- Heavy vendor features the demo never invokes (Copilot runtime, local LLM
  narration, OCR) are replaced by tiny local stubs under
  `vendor/skill-recorder/demo-stubs/` wired via `file:` dependencies; touching
  one fails loudly at startup instead of silently misbehaving.

## Development

Dev tooling lives at the repo root (Node >= 24.19):

```bash
npm install
npm test          # esbuild-bundles the OpenCode plugin, then runs the test suite
npm run typecheck # strict tsc over .opencode/plugins/recorder-demo.ts
```

`tests/` covers the plugin tool semantics (newest-session resolution, event
filters and truncation, frame manifests, SKILL.md rendering) plus the CLI's
data-root resolution, exit codes, and `doctor` self-check. CI runs the suite
and a full vendor build on every push.

## License

MIT. The vendored source keeps its original MIT license; all modifications
are listed in [PATCHES.md](PATCHES.md) and marked with `[RECORDER-DEMO]`
blocks in code.
