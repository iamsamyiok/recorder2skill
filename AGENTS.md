# recorder2skill — Agent Brief (OpenCode plugin path)

Adapted from microsoft/skill-recorder's Describer and Skill Builder briefs
(MIT, see PATCHES.md). This is the working procedure for turning a screen
recording into a standard `SKILL.md` using the `recorder_*` tools registered
by the `.opencode/plugins/recorder-demo.ts` plugin.

## Flow

1. `recorder_start` — launch the recorder. A floating control bar appears.
   Tell the user to do the task, then click Stop on the bar (or Ctrl+Shift+R).
2. `recorder_wait_ready` — blocking wait until the session is post-processed
   (frame extraction + dHash/phash dedupe + timeline bundle). Do NOT poll with
   other tools while waiting.
3. Analyze the session (method below), then write the skill with
   `recorder_save_skill`. Report the returned SKILL.md path to the user.

## Analyzing a session (step splitting + semantic mapping)

All times are `atMs` = milliseconds since recording start.

Captured event types (what `recorder_get_events` can return):
`app.activate`, `app.title-change`, `browser.url`, `clipboard.change`,
`terminal.command`, `marker`. Structural/lifecycle events are excluded by
default; pass explicit `types` to widen. Users can press
`Cmd/Ctrl+Shift+M` during a recording to drop a marker at an intentional
boundary. String payload fields are redacted for structured PII
(email/card/SSN/phone); raw values stay on disk only.

1. Read `recorder_get_timeline` — the shape of the session: ordered steps with
   app / urls / titles / commands / clipboard counts / markers. The response
   also carries `description` (the vendor describer's auto-generated
   markdown) — read it FIRST as the initial hypothesis.
2. Verify and refine that hypothesis against apps / urls / commands.
3. Read `recorder_get_events` around anything unclear — clipboard text, exact
   URLs, the sequence of title changes.
4. Look at frames ONLY where events are silent or ambiguous
   (`recorder_list_frames`, then the built-in `read` tool on the returned
   paths). Budget ~5 frames for a 30-60s session. Frame viewing needs a
   vision-capable model — the default backend (agnes-2.5-flash) reads
   screenshots natively.
5. Cross-correlate signals (clipboard <-> terminal <-> title <-> url) to
   confirm each step. Filter against the intent: drop recorder bracketing
   (focusing the recorder to press Start/Stop), OS dialogs, URL tracking
   params, sub-second focus flickers, and off-task detours. Never drop a step
   that feeds a later one (a copy, a lookup, a login).

## Writing the SKILL.md

- Generalize from the ONE recorded run: if the user acted on 3 rows, the skill
  handles every row (N). Keep what is essential; drop window positions,
  timings, and one-off specifics.
- Semantic mapping to native tools (never replay UI clicks): browser pages ->
  `webfetch`; local files -> `read`/`write`/`edit`; GitHub -> `gh` CLI /
  `Bash(gh *)`; everything shell-shaped -> `Bash`; only genuine UI-only steps
  stay as manual instructions. Write commands for the user's OS (PowerShell on
  Windows, bash on Linux).
- Extract genuinely fixed literals (a canonical URL, a repo slug) as `{{id}}`
  tokens referenced from the body; variable targets stay as instructions.
- Separate calculation steps (read/derive/decide) from action steps (submit/
  send/create/delete). Actions are the risky surface; keep them explicit.
- `description` is the trigger: state what it does AND when to reach for it.
  The body stays imperative and skimmable: When to use, the ordered procedure,
  edge cases (empty collection, missing file, one item failing).
- The skill must do exactly what its description says: no hidden side effects,
  no destructive steps the user would not expect.
