#!/usr/bin/env node
// Recorder Demo CLI — Windows-only bridge between the OpenCode plugin tools and
// the vendored microsoft/skill-recorder Electron app (MIT, see PATCHES.md).
//
// Commands (all print JSON on stdout, human logs on stderr):
//   start                     launch the recorder app in demo mode (autostarts recording)
//   wait-ready [timeoutSec]   poll for the READY.json marker of the current launch
//   last                      summarize the newest session on disk
//   summary <sessionId>       summarize one session
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = path.join(projectRoot, "vendor", "skill-recorder");
// Windows keeps its C:\temp default; other platforms use a dot-dir in $HOME.
const defaultDataRoot = process.platform === "win32" ? "C:\\temp\\recorder-demo" : path.join(os.homedir(), ".recorder-demo");
const dataRoot = process.env.RECORDER_DEMO_DATA_DIR || defaultDataRoot;
const sessionsDir = path.join(dataRoot, "sessions");
const logsDir = path.join(dataRoot, "logs");
const LAUNCH_FILE = path.join(logsDir, "launch.json");

const SUPPORTED = new Set(["win32", "linux"]);
/** Platform-specific electron binary name inside node_modules/electron/dist. */
const electronBinary = process.platform === "win32" ? "electron.exe" : "electron";

function log(msg) {
  process.stderr.write(`[recorder-cli] ${msg}\n`);
}

function die(msg, code = 1) {
  process.stderr.write(`[recorder-cli] ERROR: ${msg}\n`);
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  process.exit(code);
}

function ensureDirs() {
  for (const dir of [dataRoot, sessionsDir, logsDir, path.join(dataRoot, "skills")]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Launch the vendored Electron app in demo mode. Returns immediately. */
async function cmdStart() {
  if (!SUPPORTED.has(process.platform)) {
    die(`This demo targets Windows and Linux only (screen capture + collectors are built for those). Got: ${process.platform}.`);
  }
  const electronExe = path.join(vendorRoot, "node_modules", "electron", "dist", electronBinary);
  const mainJs = path.join(vendorRoot, "dist-electron", "main.js");
  for (const [label, p] of [["electron binary", electronExe], ["dist-electron/main.js", mainJs]]) {
    if (!existsSync(p)) {
      die(`Missing ${label} (${p}). Run setup first: scripts\\setup.ps1 (Windows) or scripts/setup.sh (Linux).`);
    }
  }
  ensureDirs();

  // Light re-entry guard (the stock app has no single-instance lock): refuse a
  // second recorder while a recent launch has not produced a session yet.
  if (args[0] !== "--force" && existsSync(LAUNCH_FILE)) {
    try {
      const last = JSON.parse(readFileSync(LAUNCH_FILE, "utf8"));
      const twoHours = 2 * 60 * 60 * 1000;
      if (Date.now() - last.startedAt < twoHours && !newestReadySince(last.startedAt)) {
        die(
          "A recording was launched recently and no session has been produced yet. " +
            "Click Stop on the floating bar and run wait-ready, or pass --force to launch anyway.",
        );
      }
    } catch {
      // unreadable launch record -> fall through and overwrite it
    }
  }

  const startedAt = Date.now();
  writeFileSync(LAUNCH_FILE, JSON.stringify({ startedAt, pid: null }, null, 2));

  // Electron refuses to run as root without --no-sandbox (typical in
  // containers/CI on Linux); regular desktop users are unaffected.
  const launchArgs = ["."];
  if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0) {
    launchArgs.unshift("--no-sandbox");
  }

  // Capture the app's console output (the vendor logger is console-only) so
  // capture problems are diagnosable instead of silently swallowed.
  const recorderLog = path.join(logsDir, "recorder.log");
  const out = openSync(recorderLog, "a");
  writeSync(out, `\n===== launch ${new Date(startedAt).toISOString()} (pid pending) =====\n`);
  const child = spawn(electronExe, launchArgs, {
    cwd: vendorRoot,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      RECORDER_DEMO_AUTOSTART: "1",
      SKILL_RECORDER_SESSIONS_DIR: sessionsDir,
    },
  });
  closeSync(out);
  writeFileSync(LAUNCH_FILE, JSON.stringify({ startedAt, pid: child.pid, log: recorderLog }, null, 2));
  child.unref();

  // The app writes logs/recording.json only once recording is REALLY live
  // (screen enumeration can take tens of seconds on minimal Linux sessions).
  const recordingMarker = path.join(logsDir, "recording.json");
  let recording = null;
  for (let waited = 0; waited < 30_000; waited += 500) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const marker = JSON.parse(readFileSync(recordingMarker, "utf8"));
      if (marker.startedAt >= startedAt - 5_000) {
        recording = marker;
        break;
      }
    } catch {
      // marker not written yet
    }
    try {
      process.kill(child.pid, 0);
    } catch {
      break; // electron process exited — startup failed
    }
  }
  if (!recording) {
    die(
      `The recorder did not start recording within 30s. Its console log is at ${recorderLog} — ` +
        "check it for startup errors (missing display, capture backend, etc.).",
    );
  }

  log(`recorder launched (pid ${child.pid}), overlay bar will appear; click Stop when done`);
  log(`recorder console log: ${recorderLog}`);
  process.stdout.write(
    JSON.stringify({
      ok: true,
      startedAt,
      recordingStartedAt: recording.startedAt,
      sessionId: recording.sessionId,
      dataDir: dataRoot,
      sessionsDir,
      log: recorderLog,
      note: "Recording started. Do the task, then click Stop on the floating bar (or Ctrl+Shift+R), then run wait-ready.",
    }) + "\n",
  );
}

function readSessionSummary(dir) {
  const out = { dir };
  for (const [key, file] of [
    ["session", "session.json"],
    ["bundle", "bundle.json"],
    ["correlation", "correlation.json"],
  ]) {
    const p = path.join(dir, file);
    if (existsSync(p)) {
      try {
        out[key] = JSON.parse(readFileSync(p, "utf8"));
      } catch {
        out[key] = null;
      }
    }
  }
  const framesManifest = path.join(dir, "frames", "frames.json");
  if (existsSync(framesManifest)) {
    try {
      // frames.json is a top-level array; accept {frames:[...]} too.
      const manifest = JSON.parse(readFileSync(framesManifest, "utf8"));
      const count = Array.isArray(manifest) ? manifest.length : (manifest.frames?.length ?? 0);
      out.frames = { dir: path.join(dir, "frames"), count };
    } catch {
      out.frames = { dir: path.join(dir, "frames"), count: 0 };
    }
  }
  const eventsPath = path.join(dir, "events.jsonl");
  if (existsSync(eventsPath)) {
    out.eventCount = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).length;
  }
  out.ready = existsSync(path.join(dir, "READY.json"));
  return out;
}

function sessionOrder(dir) {
  // Order by the recorded wall-clock end (fallback: start, fallback: mtime) so
  // "newest" is deterministic even when dirs get written in the same ms.
  let order = 0;
  try {
    const meta = JSON.parse(readFileSync(path.join(dir, "session.json"), "utf8"));
    order = meta.stoppedAt ?? meta.startedAt ?? 0;
  } catch {
    order = 0;
  }
  return { order, mtimeMs: statSync(path.join(dir, "session.json")).mtimeMs };
}

function listSessionDirs() {
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir)
    .filter((name) => !name.startsWith("."))
    .map((name) => path.join(sessionsDir, name))
    .filter((p) => statSync(p).isDirectory() && existsSync(path.join(p, "session.json")))
    .sort((a, b) => {
      const ma = sessionOrder(a);
      const mb = sessionOrder(b);
      return mb.order - ma.order || mb.mtimeMs - ma.mtimeMs;
    });
}

function newestReadySince(sinceMs) {
  for (const dir of listSessionDirs()) {
    const ready = path.join(dir, "READY.json");
    if (existsSync(ready) && statSync(ready).mtimeMs >= sinceMs - 1500) return dir;
  }
  return null;
}

/** Poll until this launch's session is processed (READY.json) or timeout. */
function cmdWaitReady(timeoutSec = 600, pollSec = 2) {
  if (!existsSync(LAUNCH_FILE)) {
    die(`No launch record at ${LAUNCH_FILE}. Run "start" first.`);
  }
  let startedAt;
  try {
    startedAt = JSON.parse(readFileSync(LAUNCH_FILE, "utf8")).startedAt;
  } catch {
    die(`Unreadable launch record at ${LAUNCH_FILE}. Re-run "start".`);
  }
  const deadline = Date.now() + timeoutSec * 1000;
  log(`waiting up to ${timeoutSec}s for the session to be stopped and processed...`);
  const tick = () => {
    const dir = newestReadySince(startedAt);
    if (dir) {
      const summary = readSessionSummary(dir);
      const meta = summary.session || {};
      process.stdout.write(
        JSON.stringify({
          ok: true,
          sessionId: meta.id || path.basename(dir),
          sessionDir: dir,
          startedAt: meta.startedAt ?? null,
          stoppedAt: meta.stoppedAt ?? null,
          eventCount: summary.eventCount ?? 0,
          frameCount: summary.frames?.count ?? 0,
          bundleSteps: summary.bundle?.stats?.stepCount ?? null,
          files: {
            events: path.join(dir, "events.jsonl"),
            bundle: path.join(dir, "bundle.json"),
            frames: summary.frames?.dir ?? null,
            correlation: existsSync(path.join(dir, "correlation.json"))
              ? path.join(dir, "correlation.json")
              : null,
          },
        }) + "\n",
      );
      process.exit(0);
    }
    if (Date.now() > deadline) {
      process.stdout.write(
        JSON.stringify({ ok: false, error: `No READY session within ${timeoutSec}s. Stop the recording on the overlay bar, or re-run wait-ready.` }) + "\n",
      );
      process.exit(1);
    }
    setTimeout(tick, pollSec * 1000);
  };
  tick();
}

function cmdLast() {
  const dirs = listSessionDirs();
  if (!dirs.length) {
    process.stdout.write(JSON.stringify({ ok: false, error: `No sessions under ${sessionsDir}` }) + "\n");
    process.exit(1);
  }
  const dir = dirs[0];
  const summary = readSessionSummary(dir);
  process.stdout.write(
    JSON.stringify({ ok: true, sessionId: summary.session?.id ?? path.basename(dir), ...summary }, null, 2) + "\n",
  );
}

function cmdSummary(sessionId) {
  const dir = path.join(sessionsDir, sessionId);
  if (!isValidSessionId(sessionId) || !existsSync(path.join(dir, "session.json"))) {
    die(`Unknown session: ${sessionId}`);
  }
  const summary = readSessionSummary(dir);
  process.stdout.write(JSON.stringify({ ok: true, sessionId, ...summary }, null, 2) + "\n");
}

function isValidSessionId(id) {
  return typeof id === "string" && id.length <= 128 && !id.includes("..") && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "start") cmdStart();
else if (cmd === "wait-ready") cmdWaitReady(Number(args[0]) || 600, Number(args[1]) || 2);
else if (cmd === "last") cmdLast();
else if (cmd === "summary" && args[0]) cmdSummary(args[0]);
else {
  process.stderr.write("Usage: recorder-cli.mjs start | wait-ready [timeoutSec] | last | summary <sessionId>\n");
  process.exit(2);
}
