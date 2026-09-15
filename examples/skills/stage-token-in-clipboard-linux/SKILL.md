---
name: stage-token-in-clipboard-linux
description: "Stage a token or other text into the X11 clipboard from a Linux terminal and verify it, when preparing to paste credentials into another desktop app."
allowed-tools:
  - Bash(command -v xclip)
  - Bash(sudo apt-get install -y xclip)
  - Bash(xclip *)
  - Bash(wl-copy *)
  - Bash(wl-paste *)
---

# Stage a token in the clipboard (Linux/X11)

Stage a secret (token, key, password) into the clipboard from a terminal so it
can be pasted into a target app, without writing it to a file or shell history.

## When to use

- You need to hand a credential to a GUI app (browser form, editor, chat) and
  the source lives in a terminal or script.
- The token must transit the clipboard only — never a temp file, never an
  echoed command line in shared logs.

## Procedure

1. Make sure `xclip` is installed: `command -v xclip` — if missing,
   `sudo apt-get install -y xclip`.
2. Stage the value, reading it from wherever it lives (env var, file, command
   output):
   `printf '%s' "$TOKEN" | xclip -selection clipboard`
3. Verify the clipboard content without printing it to shared logs:
   `xclip -selection clipboard -o | wc -c` (length check), or paste into the
   target app directly.
4. Switch to the target app and paste (`Ctrl+V`).

## Edge cases

- No X display (headless box, SSH): `xclip` fails with `Can't open display`.
  Check `echo $DISPLAY`; if empty or stale, start one and target it:
  `Xvfb :99 -screen 0 1920x1080x24 &` then `export DISPLAY=:99` (the
  clipboard then lives inside that X session only).
- Wayland sessions: use `wl-copy` / `wl-paste` instead of `xclip`.
- Values with single quotes or newlines: prefer reading from an env var or file
  over inlining the literal into the command.
- Clipboard managers may keep the value after the session ends; clear it when
  done: `printf '' | xclip -selection clipboard`.
- `xclip` forks and returns immediately on some setups; if the paste lands
  empty, retry once — the first invocation may still have been staging.
