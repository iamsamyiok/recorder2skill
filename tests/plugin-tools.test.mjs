import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The plugin reads the data root at import time, so the env must be set first.
// Use the primary RECORDER2SKILL_DATA_DIR (the legacy alias is covered in
// cli-resolution.test.mjs, which spawns the CLI as a separate process).
const DATA = path.join(os.tmpdir(), `recorder2skill-test-${process.pid}`);
process.env.RECORDER2SKILL_DATA_DIR = DATA;

const { RecorderDemoPlugin } = await import("./build/plugin.mjs");

const S1 = path.join(DATA, "sessions", "20260914-100000-aaaaaaa");
const S2 = path.join(DATA, "sessions", "20260914-110000-bbbbbbb");
const T0 = 1789380000000; // S1 startedAt
const T1 = 1789380300000; // S2 startedAt (newer)

function seed(dir, id, startedAt) {
  mkdirSync(path.join(dir, "frames"), { recursive: true });
  writeFileSync(path.join(dir, "session.json"), JSON.stringify({ id, startedAt, stoppedAt: startedAt + 60_000, version: 1, platform: "win32" }));
  const events = [];
  const push = (seq, epoch, type, payload) => events.push({ seq, t: epoch - startedAt, epoch, type, source: "collector", payload });
  push(0, startedAt + 1000, "session.start", { mode: "full" }); // structural: filtered by default
  push(1, startedAt + 2000, "app.activate", { app: "Microsoft Edge" });
  push(2, startedAt + 5000, "browser.url", { url: "https://github.com/microsoft/skill-recorder" });
  push(3, startedAt + 9000, "clipboard.change", { text: "x".repeat(3000) }); // long payload -> truncated
  push(4, startedAt + 12_000, "app.title-change", { app: "Microsoft Edge", title: "Skill Recorder - GitHub" });
  writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(path.join(dir, "bundle.json"), JSON.stringify({
    version: 1,
    session: { id, startedAt, stoppedAt: startedAt + 60_000, durationMs: 60_000, platform: "win32", appVersion: "0.5.0" },
    steps: [
      { index: 0, startMs: startedAt + 2000, endMs: startedAt + 8000, durationMs: 6000, boundary: "start", app: "Microsoft Edge", titles: ["Edge"], hosts: ["github.com"], urls: ["https://github.com/microsoft/skill-recorder"], commands: [], clipboardCount: 1, markers: [], eventSeqs: [1, 2], frames: ["f0.jpg"], summary: "Browsed to the repo" },
    ],
    stats: { eventCount: 5, meaningfulEventCount: 4, stepCount: 1, frameCount: 2, unexplainedFrameCount: 0, silentEventCount: 0 },
  }));
  writeFileSync(path.join(dir, "frames", "frames.json"), JSON.stringify({
    version: 1, format: "jpeg", heartbeatMs: 2000,
    frames: [
      { file: "f0.jpg", tMs: startedAt + 3000, offsetSec: 3, source: "event", phash: "abcdef0123456789", reason: "app.activate" },
      { file: "f1.jpg", tMs: startedAt + 9000, offsetSec: 9, source: "scene", phash: "0123456789abcdef", reason: "scene>0.40" },
    ],
  }));
  writeFileSync(path.join(dir, "READY.json"), JSON.stringify({ sessionId: id, readyAt: Date.now() }));
}

seed(S1, "20260914-100000-aaaaaaa", T0);
seed(S2, "20260914-110000-bbbbbbb", T1);

const plugin = await RecorderDemoPlugin({});
const tools = plugin.tool;
const J = (s) => JSON.parse(s);

test("timeline resolves NEWEST session", async () => {
  const v = J(await tools.recorder_get_timeline.execute({}, {}));
  assert.equal(v.sessionId, "20260914-110000-bbbbbbb");
  const s = v.steps[0];
  assert.equal(s.atMs, 2000);
  assert.equal(s.durationMs, 6000);
  assert.equal(s.app, "Microsoft Edge");
  assert.equal(s.urls.length, 1);
  assert.equal(s.frameCount, 1);
  assert.equal(typeof s.summary, "string");
  assert.equal(v.stats.stepCount, 1);
  assert.equal(v.platform, "win32");
});

test("timeline explicit sessionId", async () => {
  const v = J(await tools.recorder_get_timeline.execute({ sessionId: "20260914-100000-aaaaaaa" }, {}));
  assert.equal(v.sessionId, "20260914-100000-aaaaaaa");
});

test("timeline unknown id -> ok:false", async () => {
  const v = J(await tools.recorder_get_timeline.execute({ sessionId: "nope" }, {}));
  assert.equal(v.ok, false);
});

test("events default filter drops structural + truncates long payloads", async () => {
  const v = J(await tools.recorder_get_events.execute({}, {}));
  assert.equal(v.total, 4);
  assert.ok(!v.events.some((e) => e.type === "session.start"));
  const clip = v.events.find((e) => e.type === "clipboard.change");
  assert.ok(clip);
  assert.equal(clip.text.length, 2012);
  assert.ok(clip.text.endsWith("…[truncated]"));
  assert.equal(v.events[0].atMs, 2000);
});

test("events types filter", async () => {
  const v = J(await tools.recorder_get_events.execute({ types: ["browser.url"] }, {}));
  assert.equal(v.total, 1);
  assert.equal(v.events[0].url, "https://github.com/microsoft/skill-recorder");
});

test("events window filter", async () => {
  const v = J(await tools.recorder_get_events.execute({ fromMs: 5000, toMs: 9000 }, {}));
  assert.equal(v.total, 2);
  assert.equal(v.events[0].type, "browser.url");
});

test("events cap+truncated flag (600 clipboard events -> 500 rows)", async () => {
  const dir = path.join(DATA, "sessions", "20260914-120000-ccccccc");
  seed(dir, "20260914-120000-ccccccc", T1 + 60_000);
  const rows = [];
  for (let i = 0; i < 600; i++) rows.push({ seq: i, t: i, epoch: T1 + 60_000 + i, type: "clipboard.change", source: "collector", payload: { n: i } });
  writeFileSync(path.join(dir, "events.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const v = J(await tools.recorder_get_events.execute({ sessionId: "20260914-120000-ccccccc" }, {}));
  assert.equal(v.count, 500);
  assert.equal(v.total, 600);
  assert.equal(v.truncated, true);
});

test("frames explicit session + atMs + path join + phash passthrough", async () => {
  const v = J(await tools.recorder_list_frames.execute({ sessionId: "20260914-110000-bbbbbbb" }, {}));
  assert.equal(v.sessionId, "20260914-110000-bbbbbbb");
  assert.equal(v.frames[0].atMs, 3000);
  assert.ok(v.frames[0].path.endsWith(path.join("frames", "f0.jpg")));
  assert.ok(existsSync(path.dirname(v.frames[0].path)));
  assert.equal(v.frames[1].phash, "0123456789abcdef");
  assert.equal(v.frames[1].reason, "scene>0.40");
});

test("save_skill slug + SKILL.md render", async () => {
  const v = J(await tools.recorder_save_skill.execute({
    name: "My Cool Skill!!",
    description: "Submits expense records when asked to file expenses.",
    body: "Read the sheet, then for each row:\n1. open {{portal_url}}\n2. submit",
    allowedTools: ["Bash(gh *)", " webfetch ", ""],
  }, {}));
  assert.equal(v.ok, true);
  assert.equal(v.skill, "my-cool-skill");
  const md = readFileSync(v.path, "utf8");
  const expected = [
    "---",
    "name: my-cool-skill",
    'description: "Submits expense records when asked to file expenses."',
    "allowed-tools:",
    "  - Bash(gh *)",
    "  - webfetch",
    "---",
    "",
    "Read the sheet, then for each row:",
    "1. open {{portal_url}}",
    "2. submit",
    "",
  ].join("\n");
  assert.equal(md, expected);
});

test("sessions newest-first + ready flag", async () => {
  const v = J(await tools.recorder_sessions.execute({}, {}));
  assert.equal(v.count, 3);
  assert.equal(v.sessions[0].sessionId, "20260914-120000-ccccccc");
  assert.ok(v.sessions.every((s) => s.ready === true));
});

test("timeline missing bundle error path", async () => {
  const v = J(await tools.recorder_get_timeline.execute({ sessionId: "missing-1" }, {}));
  assert.equal(v.ok, false);
});
