import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "scripts", "recorder-cli.mjs");

function runCli(args, envOverrides = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ...envOverrides },
    encoding: "utf8",
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // non-JSON output (usage text etc.) is asserted by callers that need it
  }
  return { code: r.status, json, stderr: r.stderr, stdout: r.stdout };
}

test("RECORDER2SKILL_DATA_DIR is the primary override", () => {
  const dir = path.join(os.tmpdir(), `r2s-primary-${process.pid}`);
  const { json } = runCli(["skills"], { RECORDER2SKILL_DATA_DIR: dir, RECORDER_DEMO_DATA_DIR: "/should/not/win" });
  assert.equal(json.skillsDir, path.join(dir, "skills"));
});

test("RECORDER_DEMO_DATA_DIR legacy alias still works", () => {
  const dir = path.join(os.tmpdir(), `r2s-legacy-${process.pid}`);
  const { json } = runCli(["skills"], { RECORDER_DEMO_DATA_DIR: dir });
  assert.equal(json.skillsDir, path.join(dir, "skills"));
});

test("help exits 0 and prints usage", () => {
  const r = runCli(["help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: recorder-cli\.mjs/);
});

test("unknown command exits 2 with usage on stderr", () => {
  const r = runCli(["definitely-not-a-command"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Usage: recorder-cli\.mjs/);
});

if (process.platform !== "win32") {
  // os.homedir() follows $HOME on POSIX; Windows uses USERPROFILE, so the
  // default-dir migration cases below are POSIX-only.
  test("no env: falls back to legacy default dir when it already exists", () => {
    const home = path.join(os.tmpdir(), `r2s-home-migrate-${process.pid}`);
    const legacy = path.join(home, ".recorder-demo");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, ".keep"), "x");
    const { json } = runCli(["skills"], { RECORDER2SKILL_DATA_DIR: "", RECORDER_DEMO_DATA_DIR: "", HOME: home });
    assert.equal(json.skillsDir, path.join(legacy, "skills"));
  });

  test("no env: uses recorder2skill default when no legacy dir exists", () => {
    const home = path.join(os.tmpdir(), `r2s-home-fresh-${process.pid}`);
    mkdirSync(home, { recursive: true });
    const { json } = runCli(["skills"], { RECORDER2SKILL_DATA_DIR: "", RECORDER_DEMO_DATA_DIR: "", HOME: home });
    assert.equal(json.skillsDir, path.join(home, ".recorder2skill", "skills"));
  });
}

test("doctor reports all checks and its exit code matches failures", () => {
  const dir = path.join(os.tmpdir(), `r2s-doctor-${process.pid}`);
  const { code, json } = runCli(["doctor"], { RECORDER2SKILL_DATA_DIR: dir });
  const names = json.checks.map((c) => c.name);
  for (const expected of ["node", "platform", "electron", "vendor-build", "data-root", "sessions"]) {
    assert.ok(names.includes(expected), `missing check: ${expected}`);
  }
  const failed = json.checks.filter((c) => !c.ok).length;
  assert.equal(code, failed === 0 ? 0 : 1);
  assert.equal(json.ok, failed === 0);
});

test("wait-ready refuses a launch record from another data root", () => {
  const dir = path.join(os.tmpdir(), `r2s-launch-a-${process.pid}`);
  const logs = path.join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(
    path.join(logs, "launch.json"),
    JSON.stringify({ startedAt: Date.now(), pid: 1, dataRoot: "/somewhere/else", sessionId: "20260914-100000-aaaaaaa", log: "x" }),
  );
  const r = runCli(["wait-ready", "1", "1"], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /belongs to data root/);
});

test("wait-ready refuses an unconfirmed launch (no sessionId)", () => {
  const dir = path.join(os.tmpdir(), `r2s-launch-b-${process.pid}`);
  const logs = path.join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(
    path.join(logs, "launch.json"),
    JSON.stringify({ startedAt: Date.now(), pid: 1, dataRoot: dir, sessionId: null, log: "x" }),
  );
  const r = runCli(["wait-ready", "1", "1"], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no confirmed session/);
});

test("wait-ready waits for the anchored session and honours the timeout", () => {
  const dir = path.join(os.tmpdir(), `r2s-launch-c-${process.pid}`);
  const logs = path.join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(
    path.join(logs, "launch.json"),
    JSON.stringify({ startedAt: Date.now(), pid: 1, dataRoot: dir, sessionId: "20260914-100000-missing0", log: "x" }),
  );
  const t0 = Date.now();
  const r = runCli(["wait-ready", "1", "1"], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(r.code, 1);
  assert.ok(Date.now() - t0 >= 900, "timeout should actually wait ~1s");
  assert.match(r.stdout, /missing0 has no READY\.json/);
});

test("events command redacts PII previews", () => {
  const dir = path.join(os.tmpdir(), `r2s-events-pii-${process.pid}`);
  const sid = "20260914-165000-pii0000";
  const sessionDir = path.join(dir, "sessions", sid);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(sessionDir, "session.json"), JSON.stringify({ id: sid, startedAt: 1000 }));
  writeFileSync(
    path.join(sessionDir, "events.jsonl"),
    JSON.stringify({ seq: 0, t: 10, epoch: 1010, type: "clipboard.change", source: "clipboard", payload: { text: "card 4111 1111 1111 1111" } }) + "\n",
  );
  const r = runCli(["events", sid], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(r.code, 0);
  const out = r.stdout;
  assert.ok(!out.includes("4111 1111"), "raw card must not appear");
  assert.match(out, /••••/);
  assert.match(out, /redactedFields/);
});

test("summary surfaces description.md when present", () => {
  const dir = path.join(os.tmpdir(), `r2s-summary-desc-${process.pid}`);
  const sid = "20260914-165100-desc0001";
  const sessionDir = path.join(dir, "sessions", sid);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(sessionDir, "session.json"), JSON.stringify({ id: sid, startedAt: 1000 }));
  writeFileSync(path.join(sessionDir, "description.md"), "# Session recording\n\nOver 5s the user verified things.\n");
  const r = runCli(["summary", sid], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /did the user verified things|verified things/);
  assert.match(r.stdout, /descriptionPath/);
});

test("archive moves a session out of the active set (nothing deleted)", () => {
  const dir = path.join(os.tmpdir(), `r2s-archive-${process.pid}`);
  const sid = "20260914-170000-arch0001";
  const sessionDir = path.join(dir, "sessions", sid);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(sessionDir, "session.json"), JSON.stringify({ id: sid, startedAt: 5000 }));
  writeFileSync(path.join(sessionDir, "READY.json"), "{}");

  const r1 = runCli(["archive", "latest"], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(r1.code, 0);
  assert.ok(existsSync(path.join(dir, "archived-sessions", sid, "session.json")), "data must move, not vanish");
  assert.ok(!existsSync(path.join(dir, "sessions", sid)), "active dir must be gone after move");

  const list = runCli(["sessions"], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(list.json.count, 0, "default listing excludes archived");

  const listAll = runCli(["sessions", "--all"], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(listAll.json.count, 1);
  assert.equal(listAll.json.sessions[0].archived, true);

  // Archived sessions remain addressable by explicit id.
  const sum = runCli(["summary", sid], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(sum.code, 0);
  assert.match(sum.stdout, new RegExp(sid));

  // Archiving again is a friendly no-op.
  const r2 = runCli(["archive", sid], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(r2.code, 0);
  assert.equal(r2.json.alreadyArchived, true);
});

test("save-skill collapses multi-line descriptions to one line", () => {
  const dir = path.join(os.tmpdir(), `r2s-skill-oneline-${process.pid}`);
  mkdirSync(path.join(dir, "skills"), { recursive: true });
  const body = path.join(dir, "body.md");
  writeFileSync(body, "Do the thing.");
  const r = runCli(
    ["save-skill", "My Skill", "--description", "Does X\nwhen Y is true.\n  Tabs\ttoo", "--body-file", body],
    { RECORDER2SKILL_DATA_DIR: dir },
  );
  assert.equal(r.code, 0);
  const md = readFileSync(path.join(dir, "skills", "my-skill", "SKILL.md"), "utf8");
  assert.match(md, /^description: "Does X when Y is true\. Tabs too"$/m, "description must be single-line");
});
