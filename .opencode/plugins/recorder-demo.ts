// recorder2skill plugin for OpenCode (Windows + Linux).
//
// Registers custom tools that bridge OpenCode to the vendored
// microsoft/skill-recorder recorder (MIT, see PATCHES.md). This plugin REPLACES
// the original project's GitHub Copilot describer/skill-builder: the session
// analysis (step splitting, semantic mapping) and the SKILL.md authoring are
// done by the OpenCode agent itself, using these tools to read the captured
// timeline / events / frames.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type Plugin, tool } from "@opencode-ai/plugin";

// Reused, unmodified, from the vendored original project (MIT).
import { MEANINGFUL_EVENT_TYPES } from "../../vendor/skill-recorder/common/correlation";
import { redactText, scanStructuredPii } from "../../vendor/skill-recorder/common/sensitive";
import { slugifySkillName } from "../../vendor/skill-recorder/common/skill";

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(pluginDir, "..", "..");
const cliPath = path.join(projectRoot, "scripts", "recorder-cli.mjs");
// Must mirror scripts/recorder-cli.mjs data-root resolution:
// RECORDER2SKILL_DATA_DIR -> RECORDER_DEMO_DATA_DIR (legacy alias) ->
// legacy default dir if it already exists (upgrades keep history) -> new default.
const defaultDataRoot =
  process.platform === "win32"
    ? { current: "C:\\temp\\recorder2skill", legacy: "C:\\temp\\recorder-demo" }
    : { current: path.join(os.homedir(), ".recorder2skill"), legacy: path.join(os.homedir(), ".recorder-demo") };
const dataRoot =
  process.env.RECORDER2SKILL_DATA_DIR ||
  process.env.RECORDER_DEMO_DATA_DIR ||
  (existsSync(defaultDataRoot.legacy) ? defaultDataRoot.legacy : defaultDataRoot.current);

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function readEventsFile(sessionDir: string): Array<{ seq: number; t: number; epoch: number; type: string; source: string; payload: Record<string, unknown> }> {
  const eventsPath = path.join(sessionDir, "events.jsonl");
  if (!existsSync(eventsPath)) return [];
  const rows: ReturnType<typeof readEventsFile> = [];
  for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return rows;
}

function sessionStartMeta(dir: string): { order: number; mtimeMs: number } {
  // Order by the recorded wall-clock end (fallback: start, fallback: mtime) so
  // "newest" is deterministic even when dirs get written in the same ms.
  const meta = readJson<{ startedAt?: number; stoppedAt?: number | null }>(path.join(dir, "session.json"));
  const order = meta?.stoppedAt ?? meta?.startedAt ?? 0;
  return { order, mtimeMs: statSync(path.join(dir, "session.json")).mtimeMs };
}

function listSessionDirs(): string[] {
  const sessionsDir = path.join(dataRoot, "sessions");
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir)
    .map((name) => path.join(sessionsDir, name))
    .filter((p) => statSync(p).isDirectory() && existsSync(path.join(p, "session.json")))
    .sort((a, b) => {
      const ma = sessionStartMeta(a);
      const mb = sessionStartMeta(b);
      return mb.order - ma.order || mb.mtimeMs - ma.mtimeMs;
    });
}

function resolveSessionDir(sessionId?: string): { dir: string; id: string } | null {
  const dirs = listSessionDirs();
  if (sessionId) {
    const dir = dirs.find((d) => path.basename(d) === sessionId);
    return dir ? { dir, id: sessionId } : null;
  }
  if (!dirs.length) return null;
  return { dir: dirs[0], id: path.basename(dirs[0]) };
}

function runCli(args: string[], timeoutMs = 15_000): string {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  const out = (res.stdout || "").trim();
  if (res.error) return JSON.stringify({ ok: false, error: String(res.error) });
  if (res.status !== 0 && !out) {
    return JSON.stringify({ ok: false, error: (res.stderr || `exit ${res.status}`).trim() });
  }
  return out || JSON.stringify({ ok: false, error: (res.stderr || `exit ${res.status}`).trim() });
}

export const RecorderDemoPlugin: Plugin = async () => {
  return {
    tool: {
      recorder_start: tool({
        description:
          "Launch the screen recorder (vendored microsoft/skill-recorder) in demo mode (Windows or Linux). " +
          "Recording starts immediately and a floating control bar appears on screen. Tell the user: " +
          "do the task now, then click Stop on the floating bar (or Ctrl+Shift+R). After calling this, " +
          "call recorder_wait_ready to pick up the finished session.",
        args: {},
        async execute() {
          return runCli(["start"]);
        },
      }),

      recorder_wait_ready: tool({
        description:
          "Wait (blocking) until the current recording is stopped and post-processed (FFmpeg/frame " +
          "extraction + phash dedupe + timeline bundle). Call this after recorder_start once the user " +
          "has clicked Stop. Returns the session id, event/frame counts and file paths.",
        args: {
          timeoutSec: tool.schema.number().int().positive().max(3600).optional().describe("Max seconds to wait (default 600)."),
        },
        async execute(args) {
          return runCli(["wait-ready", String(args.timeoutSec ?? 600)], (args.timeoutSec ?? 600) * 1000 + 30_000);
        },
      }),

      recorder_sessions: tool({
        description:
          "List recorded sessions stored locally (under the demo data dir, default C:\\temp\\recorder-demo\\sessions), newest first.",
        args: {},
        async execute() {
          const sessions = listSessionDirs().map((dir) => {
            const meta = readJson<{ id: string; startedAt: number; stoppedAt: number | null }>(path.join(dir, "session.json"));
            return {
              sessionId: path.basename(dir),
              startedAt: meta?.startedAt ?? null,
              stoppedAt: meta?.stoppedAt ?? null,
              ready: existsSync(path.join(dir, "READY.json")),
              dir,
            };
          });
          return JSON.stringify({ ok: true, count: sessions.length, sessions }, null, 2);
        },
      }),

      recorder_get_timeline: tool({
        description:
          "Read the segmented timeline of a recording: ordered steps with start time (atMs, ms since " +
          "recording start), duration, app, urls, titles, commands, clipboard counts and markers. " +
          "Call this FIRST when analyzing a session. Omit sessionId to use the newest session.",
        args: {
          sessionId: tool.schema.string().optional().describe("Session id; omit for the newest session."),
        },
        async execute({ sessionId }) {
          const found = resolveSessionDir(sessionId);
          if (!found) return JSON.stringify({ ok: false, error: "No session found. Run recorder_start first." });
          const bundle = readJson<import("../../vendor/skill-recorder/common/bundle").SessionBundle>(
            path.join(found.dir, "bundle.json"),
          );
          if (!bundle) {
            return JSON.stringify({
              ok: false,
              error: `bundle.json missing for ${found.id} (session not processed yet). Call recorder_wait_ready first.`,
            });
          }
          const startedAt = bundle.session.startedAt;
          // Vendor's heuristic describer output — a ready-made first-pass
          // analysis the agent can refine instead of starting from zero.
          const descriptionPath = path.join(found.dir, "description.md");
          const description = existsSync(descriptionPath)
            ? readFileSync(descriptionPath, "utf8")
            : undefined;
          const view = {
            sessionId: found.id,
            durationMs: bundle.session.durationMs,
            platform: bundle.session.platform,
            stats: bundle.stats,
            ...(description ? { description, descriptionPath } : {}),
            steps: bundle.steps.map((s) => ({
              index: s.index,
              atMs: s.startMs - startedAt,
              durationMs: s.durationMs,
              boundary: s.boundary,
              app: s.app,
              titles: s.titles,
              hosts: s.hosts,
              urls: s.urls,
              commands: s.commands,
              clipboardCount: s.clipboardCount,
              markers: s.markers,
              frameCount: s.frames.length,
              summary: s.summary,
            })),
          };
          return JSON.stringify(view, null, 2);
        },
      }),

      recorder_get_events: tool({
        description:
          "Read the raw event stream of a recording (window titles, browser URLs, clipboard text, app " +
          "switches). Defaults to the meaningful events of the newest session. Times are atMs (ms since " +
          "recording start). Use to disambiguate anything the timeline leaves unclear.",
        args: {
          sessionId: tool.schema.string().optional().describe("Session id; omit for the newest session."),
          types: tool.schema.array(tool.schema.string()).optional().describe("Event types to include, e.g. [\"browser.url\",\"clipboard.change\"]."),
          fromMs: tool.schema.number().optional().describe("Window start (atMs)."),
          toMs: tool.schema.number().optional().describe("Window end (atMs)."),
        },
        async execute({ sessionId, types, fromMs, toMs }) {
          const found = resolveSessionDir(sessionId);
          if (!found) return JSON.stringify({ ok: false, error: "No session found." });
          const meta = readJson<{ startedAt: number }>(path.join(found.dir, "session.json"));
          const startedAt = meta?.startedAt ?? 0;
          const wanted = types && types.length ? new Set(types) : null;
          const from = typeof fromMs === "number" ? fromMs : -Infinity;
          const to = typeof toMs === "number" ? toMs : Infinity;
          const all = readEventsFile(found.dir)
            .filter((e) => (wanted ? wanted.has(e.type) : MEANINGFUL_EVENT_TYPES.has(e.type)))
            .map((e) => ({ ...e, atMs: e.epoch - startedAt }))
            .filter((e) => e.atMs >= from && e.atMs <= to);
          const MAX_EVENTS = 500;
          const rows = all.slice(0, MAX_EVENTS).map((e) => {
            const payload: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(e.payload)) {
              let out: unknown = typeof v === "string" && v.length > 2000 ? v.slice(0, 2000) + "…[truncated]" : v;
              // Redact structured PII in string fields with the vendor's
              // dependency-free detectors; raw values stay untouched on disk.
              if (typeof out === "string") {
                const matches = scanStructuredPii(out);
                if (matches.length > 0) out = redactText(out, matches);
              }
              payload[k] = out;
            }
            return { seq: e.seq, atMs: e.atMs, type: e.type, source: e.source, ...payload };
          });
          return JSON.stringify(
            {
              sessionId: found.id,
              count: rows.length,
              total: all.length,
              ...(all.length > rows.length
                ? { truncated: true, note: `Showing the first ${MAX_EVENTS} of ${all.length}. Narrow with fromMs/toMs or types.` }
                : {}),
              events: rows,
            },
            null,
            2,
          );
        },
      }),

      recorder_list_frames: tool({
        description:
          "List extracted screen frames (JPEG) of a recording with atMs (ms since start), perceptual-hash " +
          "(dHash) dedupe reason. To VIEW a frame, use the built-in read tool on the returned absolute " +
          "path. Frames are opportunistic evidence — look at them only where events are ambiguous.",
        args: {
          sessionId: tool.schema.string().optional().describe("Session id; omit for the newest session."),
        },
        async execute({ sessionId }) {
          const found = resolveSessionDir(sessionId);
          if (!found) return JSON.stringify({ ok: false, error: "No session found." });
          const framesDir = path.join(found.dir, "frames");
          type FrameRecord = { file: string; tMs: number; phash: string; reason?: string; source: string };
          // frames/frames.json is a top-level array; accept {frames:[...]} too.
          const manifest = readJson<FrameRecord[] | { frames?: FrameRecord[] }>(
            path.join(framesDir, "frames.json"),
          );
          const items = Array.isArray(manifest) ? manifest : (manifest?.frames ?? []);
          if (items.length === 0) {
            return JSON.stringify({ ok: true, sessionId: found.id, hasVideo: false, frames: [] });
          }
          const meta = readJson<{ startedAt: number }>(path.join(found.dir, "session.json"));
          const startedAt = meta?.startedAt ?? 0;
          return JSON.stringify(
            {
              ok: true,
              sessionId: found.id,
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
          );
        },
      }),

      recorder_save_skill: tool({
        description:
          "Write the final SKILL.md for a recorded session into the demo skills dir " +
          "(data root default: C:\\temp\\recorder-demo on Windows, ~/.recorder-demo elsewhere; " +
          "override with RECORDER_DEMO_DATA_DIR). Provide a kebab-case name, a " +
          "trigger-oriented description, the imperative generalized instructions body, and optional " +
          "allowed-tools frontmatter patterns (e.g. [\"Bash(gh *)\", \"webfetch\"]).",
        args: {
          name: tool.schema.string().min(1).describe("kebab-case skill id, e.g. submit-expense-records."),
          description: tool.schema.string().min(1).describe("SKILL.md description: what it does + when to use it."),
          body: tool.schema.string().min(1).describe("Markdown instructions body (imperative, generalized, native-tool-first)."),
          allowedTools: tool.schema.array(tool.schema.string()).optional().describe("allowed-tools frontmatter patterns."),
        },
        async execute({ name, description, body, allowedTools }) {
          const slug = slugifySkillName(name);
          const skillsDir = path.join(dataRoot, "skills");
          const outDir = path.join(skillsDir, slug);
          mkdirSync(outDir, { recursive: true });
          // Codex and Claude parsers expect a single-line description.
          const oneLine = description.replace(/\s+/g, " ").trim();
          if (oneLine.length > 1024) {
            console.warn("[recorder2skill] description exceeds 1024 chars; consider shortening it.");
          }
          const lines: string[] = ["---", `name: ${slug}`, `description: ${JSON.stringify(oneLine)}`];
          const tools = (allowedTools ?? []).map((t) => t.trim()).filter(Boolean);
          if (tools.length) {
            lines.push("allowed-tools:");
            for (const t of tools) lines.push(`  - ${t}`);
          }
          lines.push("---", "", body.trim(), "");
          const outPath = path.join(outDir, "SKILL.md");
          writeFileSync(outPath, lines.join("\n"));
          return JSON.stringify({ ok: true, skill: slug, path: outPath }, null, 2);
        },
      }),
    },
  };
};
