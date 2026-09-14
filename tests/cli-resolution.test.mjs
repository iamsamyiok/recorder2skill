import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
