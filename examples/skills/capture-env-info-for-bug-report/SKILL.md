---
name: capture-env-info-for-bug-report
description: "Collect runtime version info from the terminal and stage it in the clipboard for pasting into a bug report or issue template."
allowed-tools:
  - Bash(node --version)
  - Bash(python3 --version)
  - Bash(java -version)
  - Bash(xclip *)
  - Bash(wl-copy *)
  - Bash(pbcopy)
  - Bash(clip)
---

# Capture environment info for a bug report

Collect the runtime versions relevant to a bug and stage them for pasting
into the report, straight from the terminal.

## When to use

- You are about to file a bug and the maintainer asks for environment
  details (runtime version, OS build, tool versions).
- You want the exact version string copied verbatim — never retyped.

## Procedure

1. Identify the runtime involved in the bug (node, python, java, ...).
2. Print its exact version string:
   - Node.js: `node --version`
   - Python: `python3 --version`
   - Java: `java -version` 2>&1
3. Copy the version string to the clipboard without the leading `v` (or with
   it, if the report template expects it):
   - Linux/X11: `node --version | tr -d v | xclip -selection clipboard`
   - Windows (PowerShell): `node --version | clip`
   - macOS: `node --version | tr -d v | pbcopy`
4. Open the bug report draft and paste (`Ctrl+V`) into the environment
   section.
5. Repeat steps 2-4 for each additional runtime the report asks for.

## Edge cases

- Version command writes to stderr (e.g. `java -version`): redirect with
  `2>&1` before piping.
- No X display (headless box, SSH): `xclip` fails with `Can't open display`.
  Check `echo $DISPLAY`; if empty or stale, start one and target it:
  `Xvfb :99 -screen 0 1920x1080x24 &` then `export DISPLAY=:99` (the
  clipboard then lives inside that X session only).
- Multiple runtimes: keep one clipboard round-trip per version; do not
  concatenate manually — paste each into its own field.
- If the clipboard paste lands empty, re-run the copy command once — the
  first `xclip` invocation in a session can exit before staging.
