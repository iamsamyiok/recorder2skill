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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Vendor's dependency-free structured-PII detectors (TS with erasable types;
// Node 24 strips them at import time). See PATCHES.md.
import { redactText, scanStructuredPii } from "../vendor/skill-recorder/common/sensitive.ts";

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
// Archived sessions keep all data but leave the active set (Codex-style
// archived_sessions); addressable by explicit id, excluded from defaults.
const archivedSessionsDir = path.join(dataRoot, "archived-sessions");
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
  atomicWriteFileSync(LAUNCH_FILE, JSON.stringify({ startedAt, pid: null }, null, 2));

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
  atomicWriteFileSync(LAUNCH_FILE, JSON.stringify({ startedAt, pid: child.pid, dataRoot, sessionId: null, log: recorderLog }, null, 2));
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
  atomicWriteFileSync(LAUNCH_FILE, JSON.stringify({ startedAt, pid: child.pid, dataRoot, sessionId: recording.sessionId, log: recorderLog }, null, 2));
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
  // Vendor's heuristic describer writes description.md during post-processing;
  // surface it as a ready-made first-pass analysis.
  const descriptionMd = path.join(dir, "description.md");
  if (existsSync(descriptionMd)) {
    try {
      out.description = readFileSync(descriptionMd, "utf8");
      out.descriptionPath = descriptionMd;
    } catch {
      // unreadable description is not fatal
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

function listSessionDirsDetailed() {
  // Codex rollout's session_index keeps walking past "unsaved or partial"
  // session dirs instead of failing the whole listing: an entry without a
  // readable session.json is skipped (and counted) here.
  if (!existsSync(sessionsDir)) return { dirs: [], partial: 0 };
  let partial = 0;
  const dirs = readdirSync(sessionsDir)
    .filter((name) => !name.startsWith("."))
    .map((name) => path.join(sessionsDir, name))
    .filter((p) => {
      let st;
      try {
        st = statSync(p);
      } catch {
        return false; // vanished mid-listing; keep walking
      }
      if (!st.isDirectory()) return false;
      const metaPath = path.join(p, "session.json");
      if (!existsSync(metaPath)) {
        partial += 1;
        return false;
      }
      try {
        JSON.parse(readFileSync(metaPath, "utf8"));
        return true;
      } catch {
        partial += 1; // torn session.json (e.g. crash mid-write)
        return false;
      }
    })
    .sort((a, b) => {
      const ma = sessionOrder(a);
      const mb = sessionOrder(b);
      return mb.order - ma.order || mb.mtimeMs - ma.mtimeMs;
    });
  return { dirs, partial };
}

function listSessionDirs() {
  return listSessionDirsDetailed().dirs;
}

/** Write via tmp + rename so a crash never leaves a torn state file behind. */
function atomicWriteFileSync(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
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
  if (!isValidSessionId(sessionId)) die(`Unknown session: ${sessionId}`);
  // Active first, then archived sessions remain addressable by explicit id.
  const dir = [sessionsDir, archivedSessionsDir]
    .map((root) => path.join(root, sessionId))
    .find((d) => existsSync(path.join(d, "session.json")));
  if (!dir) die(`Unknown session: ${sessionId}`);
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
    if (!isValidSessionId(idOrUndefined)) die(`Unknown session: ${idOrUndefined}`);
    // Active first, then archived sessions remain addressable by explicit id.
    for (const root of [sessionsDir, archivedSessionsDir]) {
      const dir = path.join(root, idOrUndefined);
      if (existsSync(path.join(dir, "session.json"))) return { id: idOrUndefined, dir };
    }
    die(`Unknown session: ${idOrUndefined}`);
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

function cmdSessions(opts = {}) {
  const includeArchived = opts.all === true;
  const { dirs, partial: activePartial } = listSessionDirsDetailed();
  let archivedPartial = 0;
  const archivedDirs = [];
  if (includeArchived && existsSync(archivedSessionsDir)) {
    for (const name of readdirSync(archivedSessionsDir)) {
      if (name.startsWith(".")) continue;
      const p = path.join(archivedSessionsDir, name);
      const metaPath = path.join(p, "session.json");
      try {
        if (!statSync(p).isDirectory()) continue;
        if (!existsSync(metaPath)) {
          archivedPartial += 1;
          continue;
        }
        JSON.parse(readFileSync(metaPath, "utf8"));
        archivedDirs.push(p);
      } catch {
        archivedPartial += 1;
      }
    }
  }
  const sessions = [...dirs, ...archivedDirs].map((dir) => {
    const id = path.basename(dir);
    const meta = readJsonIn(dir, "session.json") ?? {};
    const bundle = readJsonIn(dir, "bundle.json");
    const manifest = readJsonIn(path.join(dir, "frames"), "frames.json");
    return {
      sessionId: id,
      startedAt: meta.startedAt ?? 0,
      stoppedAt: meta.stoppedAt ?? null,
      ready: existsSync(path.join(dir, "READY.json")),
      archived: dir.startsWith(archivedSessionsDir),
      eventCount: bundle?.stats?.eventCount ?? 0,
      stepCount: bundle?.stats?.stepCount ?? 0,
      frameCount: Array.isArray(manifest) ? manifest.length : (manifest?.frames?.length ?? 0),
      dir,
    };
  });
  sessions.sort((a, b) => b.startedAt - a.startedAt);
  const partial = activePartial + archivedPartial;
  process.stdout.write(
    JSON.stringify({ ok: true, count: sessions.length, ...(partial ? { partial } : {}), sessions }, null, 2) + "\n",
  );
}

/** Move a session out of the active set without deleting anything. */
function cmdArchive(idOrUndefined) {
  const { id, dir } = resolveTargetSession(idOrUndefined === "latest" ? undefined : idOrUndefined);
  if (dir.startsWith(archivedSessionsDir)) {
    process.stdout.write(JSON.stringify({ ok: true, sessionId: id, dir, alreadyArchived: true }, null, 2) + "\n");
    return;
  }
  mkdirSync(archivedSessionsDir, { recursive: true });
  const target = path.join(archivedSessionsDir, id);
  if (existsSync(target)) die(`Archived session already exists: ${target}`);
  renameSync(dir, target);
  process.stdout.write(JSON.stringify({ ok: true, sessionId: id, dir: target, alreadyArchived: false }, null, 2) + "\n");
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
  let skippedLines = 0;
  let events = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      // Torn tail / corrupt line: skip and count, mirroring Codex rollout
      // readers which continue past unparseable lines instead of failing.
      try {
        const { payload, ...rest } = JSON.parse(line);
        return [{ ...rest, atMs: rest.epoch - startedAt, ...(payload ?? {}) }];
      } catch {
        skippedLines += 1;
        return [];
      }
    });
  const total = events.length;
  if (meaningfulOnly) events = events.filter((e) => MEANINGFUL_EVENT_TYPES.has(e.type));
  else if (requested.length) events = events.filter((e) => requested.includes(e.type));
  if (opts.from !== undefined) events = events.filter((e) => e.atMs >= opts.from);
  if (opts.to !== undefined) events = events.filter((e) => e.atMs <= opts.to);
  const limit = opts.limit ?? 500;
  const truncated = events.length > limit;
  events = events.slice(0, limit);
  // Redact structured PII (email / card / SSN / phone) in text previews using
  // the vendor's dependency-free detectors, so pasting events into an LLM
  // context never leaks raw values. Raw values stay untouched on disk.
  let redactedCount = 0;
  for (const e of events) {
    for (const key of ["textPreview", "text", "title", "url", "note"]) {
      const value = e[key];
      if (typeof value !== "string" || value.length === 0) continue;
      const matches = scanStructuredPii(value);
      if (matches.length === 0) continue;
      e[key] = redactText(value, matches);
      redactedCount++;
    }
  }
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        sessionId: id,
        count: events.length,
        total,
        truncated,
        ...(skippedLines ? { skippedLines } : {}),
        redactedFields: redactedCount,
        events,
      },
      null,
      2,
    ) + "\n",
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

function readSkillMeta(dir) {
  const f = path.join(dir, "SKILL.md");
  if (!existsSync(f)) return null;
  const text = readFileSync(f, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split("\n")) {
    const km = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (km) meta[km[1]] = km[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, '$1');
  }
  return meta;
}

function textTokens(text) {
  return new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}

/** Jaccard similarity of two skill word sets (route/recommend-style reuse check). */
function skillSimilarity(a, b) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function cmdSaveSkill(name, opts) {
  if (!opts.description) die("save-skill requires --description \"what it does + when to use it\".");
  const bodyFile = opts.bodyFile ?? opts["body-file"];
  if (!bodyFile) die("save-skill requires --body-file <markdown file with the instructions body>.");
  if (!existsSync(bodyFile)) die(`Body file not found: ${bodyFile}`);
  const slug = slugifySkillName(String(name ?? ""));
  const skillsDir = path.join(dataRoot, "skills");
  const outDir = path.join(skillsDir, slug);
  const existed = existsSync(path.join(outDir, "SKILL.md"));
  mkdirSync(outDir, { recursive: true });
  // Codex and Claude parsers expect a single-line description; collapse all
  // whitespace. Warn (keep full) when it exceeds the 1024-char convention.
  const description = String(opts.description).replace(/\s+/g, " ").trim();
  if (description.length > 1024) log.warn("description exceeds 1024 chars; consider shortening it for skill-marketplace compatibility.");
  const lines = ["---", `name: ${slug}`, `description: ${JSON.stringify(description)}`];
  const tools = String(opts.tools ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tools.length) {
    lines.push("allowed-tools:");
    for (const t of tools) lines.push(`  - ${t}`);
  }
  lines.push("---", "", readFileSync(bodyFile, "utf8").trim(), "");

  // Webwright Skill Factory idea: a skill can carry runnable code alongside
  // the prose. Scripts are copied into scripts/ and listed in a standard
  // section so agents see they exist (skill-doctor syntax-checks them).
  const scriptArgs = [
    ...(opts.script ? [String(opts.script)] : []),
    ...String(opts.scripts ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ];
  const bundled = [];
  const scriptsDir = path.join(outDir, "scripts");
  for (const src of scriptArgs) {
    if (!existsSync(src)) die(`Script not found: ${src}`);
    mkdirSync(scriptsDir, { recursive: true });
    const base = path.basename(src);
    const dest = path.join(scriptsDir, base);
    atomicWriteFileSync(dest, readFileSync(src));
    bundled.push(`scripts/${base}`);
  }
  if (bundled.length) {
    lines.push("## Bundled scripts", "");
    for (const b of bundled) lines.push(`- \`${b}\``);
    lines.push(
      "",
      "Runnable code shipped with this skill. Node and Python resolve imports from the",
      "script's own directory upward, so run it inside a project that provides the",
      "dependencies (or install the prerequisites next to `scripts/`).",
      "",
    );
  }

  const outPath = path.join(outDir, "SKILL.md");
  atomicWriteFileSync(outPath, lines.join("\n"));

  // Reuse check (resolved out of the caller's way): a non-blocking hint when
  // an existing skill looks like a duplicate of what is about to land.
  let similarTo;
  if (existsSync(skillsDir)) {
    const incoming = textTokens(`${slug} ${description}`);
    similarTo = readdirSync(skillsDir)
      .filter((n) => n !== slug && !n.startsWith("."))
      .map((n) => {
        const meta = readSkillMeta(path.join(skillsDir, n));
        if (!meta) return null;
        const score = skillSimilarity(incoming, textTokens(`${meta.name ?? n} ${meta.description ?? ""}`));
        return score >= 0.5 ? { id: n, score: Number(score.toFixed(2)) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

  process.stdout.write(
    JSON.stringify(
      { ok: true, skill: slug, path: outPath, ...(existed ? { existed: true } : {}), ...(bundled.length ? { scripts: bundled } : {}), ...(similarTo?.length ? { similarTo } : {}) },
      null,
      2,
    ) + "\n",
  );
}

// ---------------------------------------------------------------------------
// Multi-recording alignment — Webwright Skill Factory "learn" idea: solves of
// the same task template are aligned; what is identical becomes the skeleton,
// what differs is lifted into parameters. Deterministic, zero-dependency LCS.
// ---------------------------------------------------------------------------

function normalizeStepText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function loadAlignableEvents(id) {
  const { id: sid, dir } = resolveTargetSession(id === "latest" ? undefined : id);
  const meta = readJsonIn(dir, "session.json");
  const eventsPath = path.join(dir, "events.jsonl");
  if (!existsSync(eventsPath)) die(`Session ${sid} has no events yet.`);
  const startedAt = meta?.startedAt ?? 0;
  const events = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const { payload, ...rest } = JSON.parse(line);
        return [{ ...rest, atMs: rest.epoch - startedAt, ...(payload ?? {}) }];
      } catch {
        return []; // torn line: alignment tolerates and skips it
      }
    })
    .filter((e) => MEANINGFUL_EVENT_TYPES.has(e.type))
    .map((e) => ({
      type: e.type,
      atMs: e.atMs,
      app: String(e.app ?? e.source ?? ""),
      text: String(e.textPreview ?? e.text ?? e.title ?? e.url ?? e.note ?? ""),
    }));
  return { id: sid, events };
}

/** Longest common subsequence over signature arrays; returns ordered [i, j] pairs. */
function lcsMatches(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

function cmdAlign(ids) {
  if (!ids || ids.length < 1) {
    die("align requires at least one session id (the literal \"latest\" means the newest active session).");
  }
  // One recording works; two or more make it better. Deduplicate ids that
  // resolve to the same session ("latest latest") so a session never aligns
  // against itself.
  const loaded = [];
  const seen = new Set();
  for (const id of ids) {
    const l = loadAlignableEvents(id);
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    loaded.push(l);
  }
  const first = loaded[0];
  if (!first.events.length) die(`Session ${first.id} has no meaningful events to align.`);

  // Single-recording path: the skeleton is this session's step list; the
  // honest hint tells the agent how to upgrade it into a parameterized skill.
  if (loaded.length === 1) {
    const skeleton = first.events.map((e) => ({
      refAtMs: e.atMs,
      type: e.type,
      ...(e.app ? { app: e.app } : {}),
      ...(e.text ? { text: e.text } : {}),
      presentIn: 1,
    }));
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          sessions: [{ id: first.id, meaningfulEvents: first.events.length }],
          skeletonSteps: skeleton.length,
          skeleton,
          hint: "Single recording: this is the raw step skeleton. Record the same task once more and re-run align to lift the values that vary into parameters.",
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const sig = (e) => `${e.type}|${e.app}|${normalizeStepText(e.text)}`;
  const firstSigs = first.events.map(sig);
  // Match every other session against the first; keep the first-session
  // positions that survive every pairwise LCS — that is the common skeleton.
  let keep = new Map(first.events.map((_, i) => [i, new Map()]));
  for (const other of loaded.slice(1)) {
    const pairs = new Map(lcsMatches(firstSigs, other.events.map(sig)));
    const next = new Map();
    for (const [i, m] of keep) {
      if (pairs.has(i)) {
        m.set(other.id, pairs.get(i));
        next.set(i, m);
      }
    }
    keep = next;
  }
  const skeleton = [];
  const parameters = [];
  for (const [i, matchMap] of [...keep].sort((a, b) => a[0] - b[0])) {
    const e = first.events[i];
    const values = [
      ...new Set([e.text, ...[...matchMap].map(([id, j]) => loaded.find((l) => l.id === id).events[j].text)]),
    ]
      .map((t) => t.trim())
      .filter(Boolean);
    skeleton.push({
      refAtMs: e.atMs,
      type: e.type,
      ...(e.app ? { app: e.app } : {}),
      ...(e.text ? { text: e.text } : {}),
      presentIn: matchMap.size + 1,
    });
    if (values.length > 1) {
      parameters.push({ slot: `skeleton[${skeleton.length - 1}].text`, values });
    }
  }
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        sessions: loaded.map((l) => ({ id: l.id, meaningfulEvents: l.events.length })),
        skeletonSteps: skeleton.length,
        skeleton,
        ...(parameters.length ? { parameters } : {}),
        note: "refAtMs is measured on the first session; feed skeleton + parameters to save-skill as the parameterized procedure.",
      },
      null,
      2,
    ) + "\n",
  );
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

  const { dirs: sessions, partial: partialSessions } = listSessionDirsDetailed();
  const archivedCount = existsSync(archivedSessionsDir)
    ? readdirSync(archivedSessionsDir).filter((n) => !n.startsWith(".") && existsSync(path.join(archivedSessionsDir, n, "session.json"))).length
    : 0;
  add(
    "sessions",
    true,
    (sessions.length === 0 ? "no sessions yet" : `${sessions.length} active session(s)`)
      + (partialSessions ? `, ${partialSessions} partial (skipped)` : "")
      + (archivedCount ? `, ${archivedCount} archived` : "")
      + (sessions.length ? `, newest: ${path.basename(sessions[0])}` : ""),
  );

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
  "                  sessions [--all] | timeline [sessionId] | events [sessionId] [--types a,b] [--all] [--from ms] [--to ms] [--limit n] |\n" +
  "                  frames [sessionId] | skills | doctor | archive [sessionId|latest] |\n" +
  "                  align <sessionId> [more...] | save-skill <name> --description \"...\" --body-file <file> [--tools \"a,b\"] [--script <file>]\n";
if (cmd === "start") cmdStart();
else if (cmd === "wait-ready") cmdWaitReady(Number(args[0]) || 600, Number(args[1]) || 2);
else if (cmd === "last") cmdLast();
else if (cmd === "summary" && args[0]) cmdSummary(args[0]);
else if (cmd === "sessions") {
  const { opts } = parseOpts(args);
  cmdSessions({ all: opts.all === true });
}
else if (cmd === "archive" && args[0]) cmdArchive(args[0]);
else if (cmd === "archive") cmdArchive(undefined);
else if (cmd === "align" && args.length >= 1) cmdAlign(args);
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
