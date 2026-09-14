#!/usr/bin/env node
// Recorder2Skill CLI — the agent-agnostic bridge to the vendored
// microsoft/skill-recorder Electron app (MIT, see PATCHES.md). Every control
// and read operation is a plain shell command, so ANY agent that can run
// shell (OpenCode, Claude Code, Codex, ...) can drive the full flow.
//
// Commands (all print JSON on stdout, human logs on stderr):
//   start                     launch the recorder app in demo mode (autostarts recording)
//   wait-ready [timeoutSec]   poll for the READY.json marker of the current launch
//   last                      summarize the newest session on disk
//   summary <sessionId>       summarize one session
//   sessions                  list all sessions (newest first)
//   timeline [sessionId]      ordered steps of the processed session (atMs = ms since start)
//   events [sessionId]        captured events; --types a,b to widen (default: meaningful only)
//   frames [sessionId]        kept screen frames (JPEG paths + phash + reason)
//   save-skill <name>         write SKILL.md from --description + --body-file (+ --tools)
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = path.join(projectRoot, "vendor", "skill-recorder");
// Data-root resolution order: RECORDER2SKILL_DATA_DIR -> RECORDER_DEMO_DATA_DIR
// (legacy alias) -> legacy default dir if it already exists (so upgrades keep
// their history) -> the recorder2skill default.
const defaultDataRoot =
  process.platform === "win32"
    ? { current: "C:\\temp\\recorder2skill", legacy: "C:\\temp\\recorder-demo" }
    : { current: path.join(os.homedir(), ".recorder2skill"), legacy: path.join(os.homedir(), ".recorder-demo") };
const dataRoot =
  process.env.RECORDER2SKILL_DATA_DIR ||
  process.env.RECORDER_DEMO_DATA_DIR ||
  (existsSync(defaultDataRoot.legacy) ? defaultDataRoot.legacy : defaultDataRoot.current);
const sessionsDir = path.join(dataRoot, "sessions");
const logsDir = path.join(dataRoot, "logs");
const LAUNCH_FILE = path.join(logsDir, "launch.json");

const SUPPORTED = new Set(["win32", "linux"]);
/** Platform-specific electron binary name inside node_modules/electron/dist. */
const electronBinary = process.platform === "win32" ? "electron.exe" : "electron";

function log(msg) {
  process.stderr.write(`[recorder2skill] ${msg}\n`);
}

function die(msg, code = 1) {
  process.stderr.write(`[recorder2skill] ERROR: ${msg}\n`);
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
  // Written immediately (overwriting any stale record) so wait-ready can tell
  // "this launch never confirmed live" from "waiting on the launched session".
  writeFileSync(LAUNCH_FILE, JSON.stringify({ startedAt, pid: child.pid, dataRoot, sessionId: null, log: recorderLog }, null, 2));
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
  // Anchor the launch record on the confirmed session so wait-ready waits for
  // THIS recording, never a stale one.
  writeFileSync(LAUNCH_FILE, JSON.stringify({ startedAt, pid: child.pid, dataRoot, sessionId: recording.sessionId, log: recorderLog }, null, 2));
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
  let launch;
  try {
    launch = JSON.parse(readFileSync(LAUNCH_FILE, "utf8"));
  } catch {
    die(`Unreadable launch record at ${LAUNCH_FILE}. Re-run "start".`);
  }
  if (launch.dataRoot && path.resolve(launch.dataRoot) !== path.resolve(dataRoot)) {
    die(
      `This launch record belongs to data root "${launch.dataRoot}", but this invocation resolved "${dataRoot}". ` +
        "Set the same data-root environment variable (RECORDER2SKILL_DATA_DIR / RECORDER_DEMO_DATA_DIR) you used for \"start\".",
    );
  }
  if (!launch.sessionId) {
    die(
      `The launch record has no confirmed session (recording never went live?). ` +
        `Check ${launch.log || path.join(logsDir, "recorder.log")} for startup errors, then re-run "start".`,
    );
  }
  const expectedDir = path.join(sessionsDir, launch.sessionId);
  const deadline = Date.now() + timeoutSec * 1000;
  log(`waiting up to ${timeoutSec}s for session ${launch.sessionId} to be stopped and processed...`);
  const tick = () => {
    const dir = existsSync(path.join(expectedDir, "READY.json")) ? expectedDir : null;
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
        JSON.stringify({ ok: false, error: `Session ${launch.sessionId} has no READY.json within ${timeoutSec}s. Stop the recording on the overlay bar (or Ctrl+Shift+R); if it is already stopped, check ${launch.log || "the recorder log"}.` }) + "\n",
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

// ---------------------------------------------------------------------------
// Universal read/save commands — let ANY agent (or script) drive the whole
// flow over plain shell, mirroring the OpenCode plugin tool semantics.
// ---------------------------------------------------------------------------

/** Mirrors vendor common/correlation MEANINGFUL_EVENT_TYPES (kept in sync). */
const MEANINGFUL_EVENT_TYPES = new Set([
  "app.activate",
  "app.title-change",
  "browser.url",
  "terminal.command",
  "clipboard.change",
  "marker",
]);

function resolveTargetSession(idOrUndefined) {
  if (idOrUndefined !== undefined) {
    if (!isValidSessionId(idOrUndefined) || !existsSync(path.join(sessionsDir, idOrUndefined, "session.json"))) {
      die(`Unknown session: ${idOrUndefined}`);
    }
    return { id: idOrUndefined, dir: path.join(sessionsDir, idOrUndefined) };
  }
  const dirs = listSessionDirs();
  if (!dirs.length) die(`No sessions under ${sessionsDir}`);
  return { id: path.basename(dirs[0]), dir: dirs[0] };
}

function readJsonIn(dir, file) {
  const p = path.join(dir, file);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function cmdSessions() {
  const dirs = listSessionDirs();
  const sessions = dirs.map((dir) => {
    const id = path.basename(dir);
    const meta = readJsonIn(dir, "session.json") ?? {};
    const bundle = readJsonIn(dir, "bundle.json");
    const manifest = readJsonIn(path.join(dir, "frames"), "frames.json");
    return {
      sessionId: id,
      startedAt: meta.startedAt ?? 0,
      stoppedAt: meta.stoppedAt ?? null,
      ready: existsSync(path.join(dir, "READY.json")),
      eventCount: bundle?.stats?.eventCount ?? 0,
      stepCount: bundle?.stats?.stepCount ?? 0,
      frameCount: Array.isArray(manifest) ? manifest.length : (manifest?.frames?.length ?? 0),
      dir,
    };
  });
  process.stdout.write(JSON.stringify({ ok: true, count: sessions.length, sessions }, null, 2) + "\n");
}

function cmdTimeline(sessionIdOrUndefined) {
  const { id, dir } = resolveTargetSession(sessionIdOrUndefined);
  const bundle = readJsonIn(dir, "bundle.json");
  const meta = readJsonIn(dir, "session.json");
  if (!bundle || !meta) {
    die(`Session ${id} has no processed bundle yet (recording still running or processing). Run wait-ready first.`);
  }
  const steps = (bundle.steps ?? []).map((s) => ({
    index: s.index,
    atMs: s.startMs - meta.startedAt,
    durationMs: s.durationMs,
    boundary: s.boundary,
    app: s.app,
    titles: s.titles ?? [],
    hosts: s.hosts ?? [],
    urls: s.urls ?? [],
    commands: s.commands ?? [],
    clipboardCount: s.clipboardCount ?? 0,
    markers: s.markers ?? [],
    frameCount: (s.frames ?? []).length,
    summary: s.summary,
  }));
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        sessionId: id,
        durationMs: bundle.session?.durationMs ?? (meta.stoppedAt ?? 0) - meta.startedAt,
        platform: bundle.session?.platform ?? meta.platform,
        stats: bundle.stats ?? {},
        steps,
      },
      null,
      2,
    ) + "\n",
  );
}

function cmdEvents(sessionIdOrUndefined, opts) {
  const { id, dir } = resolveTargetSession(sessionIdOrUndefined);
  const meta = readJsonIn(dir, "session.json");
  const eventsPath = path.join(dir, "events.jsonl");
  if (!existsSync(eventsPath)) die(`Session ${id} has no events yet.`);
  const startedAt = meta?.startedAt ?? 0;
  const requested = (opts.types ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const meaningfulOnly = requested.length === 0 && !opts.all;
  let events = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map(({ payload, ...rest }) => ({ ...rest, atMs: rest.epoch - startedAt, ...(payload ?? {}) }));
  const total = events.length;
  if (meaningfulOnly) events = events.filter((e) => MEANINGFUL_EVENT_TYPES.has(e.type));
  else if (requested.length) events = events.filter((e) => requested.includes(e.type));
  if (opts.from !== undefined) events = events.filter((e) => e.atMs >= opts.from);
  if (opts.to !== undefined) events = events.filter((e) => e.atMs <= opts.to);
  const limit = opts.limit ?? 500;
  const truncated = events.length > limit;
  events = events.slice(0, limit);
  process.stdout.write(
    JSON.stringify({ ok: true, sessionId: id, count: events.length, total, truncated, events }, null, 2) + "\n",
  );
}

function cmdFrames(sessionIdOrUndefined) {
  const { id, dir } = resolveTargetSession(sessionIdOrUndefined);
  const framesDir = path.join(dir, "frames");
  const manifest = readJsonIn(framesDir, "frames.json");
  const items = Array.isArray(manifest) ? manifest : (manifest?.frames ?? []);
  if (items.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, sessionId: id, hasVideo: false, frames: [] }, null, 2) + "\n");
    return;
  }
  const startedAt = readJsonIn(dir, "session.json")?.startedAt ?? 0;
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        sessionId: id,
        framesDir,
        frames: items.map((f) => ({
          path: path.join(framesDir, f.file),
          atMs: f.tMs - startedAt,
          phash: f.phash,
          source: f.source,
          reason: f.reason,
        })),
      },
      null,
      2,
    ) + "\n",
  );
}

function slugifySkillName(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "recorded-skill"
  );
}

function cmdSaveSkill(name, opts) {
  if (!opts.description) die("save-skill requires --description \"what it does + when to use it\".");
  const bodyFile = opts.bodyFile ?? opts["body-file"];
  if (!bodyFile) die("save-skill requires --body-file <markdown file with the instructions body>.");
  if (!existsSync(bodyFile)) die(`Body file not found: ${bodyFile}`);
  const slug = slugifySkillName(String(name ?? ""));
  const skillsDir = path.join(dataRoot, "skills");
  const outDir = path.join(skillsDir, slug);
  mkdirSync(outDir, { recursive: true });
  const lines = ["---", `name: ${slug}`, `description: ${JSON.stringify(String(opts.description).trim())}`];
  const tools = String(opts.tools ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tools.length) {
    lines.push("allowed-tools:");
    for (const t of tools) lines.push(`  - ${t}`);
  }
  lines.push("---", "", readFileSync(bodyFile, "utf8").trim(), "");
  const outPath = path.join(outDir, "SKILL.md");
  writeFileSync(outPath, lines.join("\n"));
  process.stdout.write(JSON.stringify({ ok: true, skill: slug, path: outPath }, null, 2) + "\n");
}

function parseOpts(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { opts, positional };
}

function cmdDoctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add("node", nodeMajor >= 24, `node ${process.versions.node} (vendor engines require >=24.19 <25)`);

  const platOk = process.platform === "win32" || process.platform === "linux" || process.platform === "darwin";
  add("platform", platOk, process.platform);

  const electronBin = path.join(vendorRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
  add("electron", existsSync(electronBin), existsSync(electronBin) ? electronBin : `missing: ${electronBin} (run setup.sh / setup.ps1)`);

  const mainJs = path.join(vendorRoot, "dist-electron", "main.js");
  add("vendor-build", existsSync(mainJs), existsSync(mainJs) ? mainJs : `missing: ${mainJs} (run: cd vendor/skill-recorder && npm run build)`);

  let dataOk = true;
  let dataDetail = dataRoot;
  try {
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, ".doctor-probe"), "ok");
    unlinkSync(path.join(dataRoot, ".doctor-probe"));
  } catch (e) {
    dataOk = false;
    dataDetail = `${dataRoot} (${e.message})`;
  }
  add("data-root", dataOk, dataDetail);

  if (process.platform === "linux") {
    add("display", Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY), process.env.DISPLAY ? `DISPLAY=${process.env.DISPLAY}` : "no DISPLAY/WAYLAND_DISPLAY (headless: start Xvfb first)");
  }

  const sessions = listSessionDirs();
  add("sessions", true, sessions.length === 0 ? "no sessions yet" : `${sessions.length} session(s), newest: ${path.basename(sessions[0])}`);

  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(JSON.stringify({ ok: failed.length === 0, dataRoot, checks }, null, 2) + "\n");
  process.exit(failed.length === 0 ? 0 : 1);
}

function cmdSkills() {
  const dir = path.join(dataRoot, "skills");
  const skills = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => !n.startsWith(".") && existsSync(path.join(dir, n, "SKILL.md")))
        .sort()
    : [];
  process.stdout.write(JSON.stringify({ ok: true, skillsDir: dir, skills }, null, 2) + "\n");
}

const [cmd, ...args] = process.argv.slice(2);
const usage =
  "Usage: recorder-cli.mjs start | wait-ready [timeoutSec] | last | summary <sessionId> |\n" +
  "                  sessions | timeline [sessionId] | events [sessionId] [--types a,b] [--all] [--from ms] [--to ms] [--limit n] |\n" +
  "                  frames [sessionId] | skills | doctor |\n" +
  "                  save-skill <name> --description \"...\" --body-file <file> [--tools \"a,b\"]\n";
if (cmd === "start") cmdStart();
else if (cmd === "wait-ready") cmdWaitReady(Number(args[0]) || 600, Number(args[1]) || 2);
else if (cmd === "last") cmdLast();
else if (cmd === "summary" && args[0]) cmdSummary(args[0]);
else if (cmd === "sessions") cmdSessions();
else if (cmd === "timeline") cmdTimeline(args[0]);
else if (cmd === "doctor") cmdDoctor();
else if (cmd === "skills") cmdSkills();
else if (cmd === "events") {
  const { opts, positional } = parseOpts(args);
  cmdEvents(positional[0], {
    types: opts.types,
    all: opts.all === true,
    from: opts.from !== undefined ? Number(opts.from) : undefined,
    to: opts.to !== undefined ? Number(opts.to) : undefined,
    limit: opts.limit !== undefined ? Number(opts.limit) : undefined,
  });
} else if (cmd === "frames") cmdFrames(args[0]);
else if (cmd === "save-skill") {
  const { opts, positional } = parseOpts(args);
  cmdSaveSkill(positional[0], opts);
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  process.stdout.write(usage);
} else {
  process.stderr.write(usage);
  process.exit(2);
}
