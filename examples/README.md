# Examples

Real artifacts from an actual Linux recording session (task: check the Node.js
version and stage the output into the clipboard for a bug report), so you can
see the end product without recording anything.

- `timeline.json` / `events.json` — CLI output for the recorded session
  (`recorder-cli.mjs timeline|events <sessionId>`): 2 steps, 5 meaningful
  events, each step linked to its captured frame.
- `skills/` — the two `SKILL.md` files produced from real sessions by the
  analysis flow described in `skill/recorder2skill/SKILL.md`:
  - `capture-env-info-for-bug-report` — from the timeline above.
  - `stage-token-in-clipboard-linux` — from a session that staged a token
    into the X11 clipboard (patterns only; no real secrets).

To produce your own: install the skill, run a task on screen, then follow
`skill/recorder2skill/SKILL.md`.
