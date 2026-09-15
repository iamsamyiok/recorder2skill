import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

test("sessions skips torn session dirs and reports a partial count", () => {
  const dir = path.join(os.tmpdir(), `r2s-torn-sessions-${process.pid}`);
  const good = path.join(dir, "sessions", "20260914-170000-tornaa1");
  mkdirSync(good, { recursive: true });
  writeFileSync(path.join(good, "session.json"), JSON.stringify({ id: "20260914-170000-tornaa1", startedAt: 5000 }));
  // Codex-style "unsaved or partial" entries must not fail the listing.
  mkdirSync(path.join(dir, "sessions", "20260914-170000-tornbb2"), { recursive: true });
  mkdirSync(path.join(dir, "sessions", "20260914-170000-torncc3"), { recursive: true });
  writeFileSync(path.join(dir, "sessions", "20260914-170000-torncc3", "session.json"), '{"id": torn');

  const r = runCli(["sessions"], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(r.code, 0);
  assert.equal(r.json.count, 1, "only the healthy session is listed");
  assert.equal(r.json.partial, 2, "both partial entries are counted");
  assert.equal(r.json.sessions[0].sessionId, "20260914-170000-tornaa1");
});

test("events tolerates a torn trailing line and reports skippedLines", () => {
  const dir = path.join(os.tmpdir(), `r2s-torn-events-${process.pid}`);
  const sid = "20260914-170000-torndd4";
  const sessionDir = path.join(dir, "sessions", sid);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(sessionDir, "session.json"), JSON.stringify({ id: sid, startedAt: 5000 }));
  writeFileSync(
    path.join(sessionDir, "events.jsonl"),
    [
      JSON.stringify({ seq: 1, t: 1, epoch: 5001, type: "marker", source: "demo", payload: { text: "a" } }),
      JSON.stringify({ seq: 2, t: 2, epoch: 5002, type: "app.activate", source: "demo", payload: {} }),
      '{"seq":3,"t":3,"epoch":5003,"type":"app.activ', // torn tail (crash mid-write)
      "",
    ].join("\n"),
  );

  const r = runCli(["events", sid], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(r.code, 0);
  assert.equal(r.json.count, 2, "the two healthy events survive");
  assert.equal(r.json.skippedLines, 1, "the torn line is counted, not fatal");
});

test("save-skill writes atomically (no .tmp residue in the skills dir)", () => {
  const dir = path.join(os.tmpdir(), `r2s-atomic-skill-${process.pid}`);
  mkdirSync(path.join(dir, "skills"), { recursive: true });
  const body = path.join(dir, "body.md");
  writeFileSync(body, "Do it atomically.");
  const r = runCli(["save-skill", "atomic skill", "--description", "writes via tmp+rename", "--body-file", body], {
    RECORDER2SKILL_DATA_DIR: dir,
  });
  assert.equal(r.code, 0);
  assert.equal(existsSync(path.join(dir, "skills", "atomic-skill", "SKILL.md")), true);
  const residue = readdirSync(path.join(dir, "skills", "atomic-skill")).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(residue, [], "tmp file must be renamed away, never left behind");
});

test("save-skill bundles scripts and reports existed on rewrite", () => {
  const dir = path.join(os.tmpdir(), `r2s-script-${process.pid}`);
  mkdirSync(path.join(dir, "skills"), { recursive: true });
  const body = path.join(dir, "body.md");
  writeFileSync(body, "Run the bundled script.");
  const script = path.join(dir, "shot.mjs");
  writeFileSync(script, 'console.log("ok");\n');
  const r = runCli(
    ["save-skill", "scripted skill", "--description", "Bundles runnable code.", "--body-file", body, "--script", script],
    { RECORDER2SKILL_DATA_DIR: dir },
  );
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.scripts, ["scripts/shot.mjs"]);
  assert.equal(existsSync(path.join(dir, "skills", "scripted-skill", "scripts", "shot.mjs")), true);
  const md = readFileSync(path.join(dir, "skills", "scripted-skill", "SKILL.md"), "utf8");
  assert.match(md, /## Bundled scripts/);
  assert.match(md, /`scripts\/shot\.mjs`/);

  const r2 = runCli(
    ["save-skill", "scripted skill", "--description", "Bundles runnable code.", "--body-file", body],
    { RECORDER2SKILL_DATA_DIR: dir },
  );
  assert.equal(r2.json.existed, true, "rewriting an existing skill is flagged");
});

test("save-skill hints at similar existing skills (non-blocking)", () => {
  const dir = path.join(os.tmpdir(), `r2s-similar-${process.pid}`);
  mkdirSync(path.join(dir, "skills"), { recursive: true });
  const body = path.join(dir, "body.md");
  writeFileSync(body, "Do the deploy flow.");
  const commonDesc = "Deploy a static site to github pages with a custom domain and verify the deployment";
  const r1 = runCli(["save-skill", "deploy-site", "--description", commonDesc, "--body-file", body], {
    RECORDER2SKILL_DATA_DIR: dir,
  });
  assert.equal(r1.code, 0);
  assert.equal(r1.json.similarTo, undefined, "first save has nothing to be similar to");
  const r2 = runCli(["save-skill", "publish-pages", "--description", commonDesc, "--body-file", body], {
    RECORDER2SKILL_DATA_DIR: dir,
  });
  assert.equal(r2.code, 0, "the hint is non-blocking");
  assert.ok(Array.isArray(r2.json.similarTo) && r2.json.similarTo.some((s) => s.id === "deploy-site"), JSON.stringify(r2.json));
  const r3 = runCli(["save-skill", "unrelated-thing", "--description", "Boil water for tea with a kettle", "--body-file", body], {
    RECORDER2SKILL_DATA_DIR: dir,
  });
  assert.equal(r3.json.similarTo, undefined);
});

test("align extracts a common skeleton and lifts differences into parameters", () => {
  const dir = path.join(os.tmpdir(), `r2s-align-${process.pid}`);
  for (const [sid, url, base] of [
    ["20260915-100000-alignaa1", "https://example.com/flights?from=100", 5000],
    ["20260915-100001-alignbb2", "https://example.com/flights?from=200", 6000],
  ]) {
    const sd = path.join(dir, "sessions", sid);
    mkdirSync(sd, { recursive: true });
    writeFileSync(path.join(sd, "session.json"), JSON.stringify({ id: sid, startedAt: base }));
    writeFileSync(
      path.join(sd, "events.jsonl"),
      [
        { seq: 1, t: 1, epoch: base + 100, type: "app.activate", source: "system", payload: { app: "Google Chrome", title: "Flight search" } },
        { seq: 2, t: 2, epoch: base + 200, type: "browser.url", source: "browser", payload: { url } },
        { seq: 3, t: 3, epoch: base + 300, type: "terminal.command", source: "terminal", payload: { text: "python book.py" } },
        { seq: 4, t: 4, epoch: base + 400, type: "marker", source: "hud", payload: { text: "done" } },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
  }
  const r = runCli(["align", "20260915-100000-alignaa1", "20260915-100001-alignbb2"], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.skeletonSteps, 4, "all four steps share one signature");
  assert.equal(r.json.skeleton[1].type, "browser.url");
  assert.deepEqual(r.json.parameters, [
    { slot: "skeleton[1].text", values: ["https://example.com/flights?from=100", "https://example.com/flights?from=200"] },
  ]);

  // One id is the single-recording path now (skeleton + hint, no parameters).
  const single = runCli(["align", "20260915-100000-alignaa1"], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(single.code, 0);
  assert.equal(single.json.skeletonSteps, 4);
  assert.equal(single.json.parameters, undefined);
  assert.ok(single.json.hint);
});

test("align works with a single recording and hints to record again", () => {
  const dir = path.join(os.tmpdir(), `r2s-align-one-${process.pid}`);
  const sid = "20260915-110000-aligncc3";
  const sd = path.join(dir, "sessions", sid);
  mkdirSync(sd, { recursive: true });
  writeFileSync(path.join(sd, "session.json"), JSON.stringify({ id: sid, startedAt: 5000 }));
  writeFileSync(
    path.join(sd, "events.jsonl"),
    [
      { seq: 1, t: 1, epoch: 5100, type: "app.activate", source: "system", payload: { app: "Terminal", title: "work" } },
      { seq: 2, t: 2, epoch: 5200, type: "terminal.command", source: "terminal", payload: { text: "make build" } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  const r = runCli(["align", sid], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.skeletonSteps, 2);
  assert.equal(r.json.skeleton[1].text, "make build");
  assert.equal(r.json.parameters, undefined, "one recording cannot infer parameters");
  assert.match(r.json.hint, /Record the same task once more/);

  // Duplicate ids resolve to one session: no self-alignment, single path.
  const dup = runCli(["align", sid, sid], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(dup.code, 0);
  assert.equal(dup.json.skeletonSteps, 2);
  assert.equal(dup.json.parameters, undefined);
  assert.ok(dup.json.hint);
});

test("last --summary keeps the small fields and drops bundle/correlation", () => {
  const dir = path.join(os.tmpdir(), `r2s-last-${process.pid}`);
  const sid = "20260915-120000-lastsumaa1";
  const sd = path.join(dir, "sessions", sid);
  mkdirSync(sd, { recursive: true });
  writeFileSync(path.join(sd, "session.json"), JSON.stringify({ id: sid, startedAt: 7000, stoppedAt: 8000, platform: process.platform }));
  writeFileSync(path.join(sd, "events.jsonl"), `${JSON.stringify({ seq: 1, t: 1, epoch: 7100, type: "marker", source: "hud", payload: { text: "x" } })}\n`);
  writeFileSync(path.join(sd, "bundle.json"), JSON.stringify({ session: { id: sid, platform: process.platform }, stats: { events: 1 } }));
  const summary = runCli(["last", "--summary"], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(summary.code, 0, summary.stdout + summary.stderr);
  assert.equal(summary.json.sessionId, sid);
  assert.equal(summary.json.eventCount, 1);
  assert.equal(summary.json.stats.events, 1, "stats summary comes from the bundle");
  assert.equal(summary.json.bundle, undefined, "bundle blob stays out of --summary");
  assert.equal(summary.json.correlation, undefined, "correlation blob stays out of --summary");
  const full = runCli(["last"], { RECORDER2SKILL_DATA_DIR: dir });
  assert.equal(full.code, 0);
  assert.ok(full.json.bundle, "plain last keeps the full bundle");
});

test("doctor reports the repo root and agent registration state", () => {
  const home = path.join(os.tmpdir(), `r2s-doc-home-${process.pid}`);
  mkdirSync(home, { recursive: true });
  const r = runCli(["doctor"], { RECORDER2SKILL_DATA_DIR: path.join(os.tmpdir(), `r2s-doc-data-${process.pid}`), HOME: home });
  const repo = r.json.checks.find((c) => c.name === "repo");
  const agents = r.json.checks.find((c) => c.name === "agents");
  assert.ok(repo && repo.detail.includes("recorder-demo"), `repo check prints the checkout path: ${JSON.stringify(repo)}`);
  assert.match(agents.detail, /opencode: not detected/, "fresh HOME has no agent dirs");
});

test("install-skill copies the bundled skill into an agent dir", () => {
  const home = path.join(os.tmpdir(), `r2s-inst-home-${process.pid}`);
  mkdirSync(home, { recursive: true });
  const r = runCli(["install-skill", "opencode"], { HOME: home });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const dest = path.join(home, ".config", "opencode", "skill", "recorder2skill", "SKILL.md");
  assert.equal(existsSync(dest), true, "SKILL.md lands in ~/.config/opencode/skill");
  assert.equal(r.json.installed[0].agent, "opencode");

  const doc = runCli(["doctor"], { RECORDER2SKILL_DATA_DIR: path.join(os.tmpdir(), `r2s-inst-doc-${process.pid}`), HOME: home });
  assert.match(doc.json.checks.find((c) => c.name === "agents").detail, /opencode: installed/, "doctor sees the registration");

  const bad = runCli(["install-skill", "nope"]);
  assert.equal(bad.code, 1, "unknown target dies with an error");
});

test("save-skill --to installs the generated skill into agent dirs", () => {
  const home = path.join(os.tmpdir(), `r2s-to-home-${process.pid}`);
  mkdirSync(home, { recursive: true });
  const dir = path.join(os.tmpdir(), `r2s-to-data-${process.pid}`);
  mkdirSync(path.join(dir, "skills"), { recursive: true });
  const body = path.join(dir, "body.md");
  writeFileSync(body, "Do a thing well.");
  const r = runCli(
    ["save-skill", "to skill", "--description", "Installs into agent dirs on save.", "--body-file", body, "--to", "claude,codex"],
    { RECORDER2SKILL_DATA_DIR: dir, HOME: home },
  );
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(
    r.json.installed.map((p) => p.replace(home, "~")).sort(),
    ["~/.claude/skills/to-skill", "~/.codex/skills/to-skill"],
  );
  assert.equal(r.json.doctorOk, true, "installed copy passes skill-doctor");
  assert.equal(existsSync(path.join(home, ".claude", "skills", "to-skill", "SKILL.md")), true);
  const bad = runCli(["save-skill", "to skill", "--description", "x", "--body-file", body, "--to", "nope"], {
    RECORDER2SKILL_DATA_DIR: dir,
    HOME: home,
  });
  assert.equal(bad.code, 1, "unknown --to target dies with an error");
  assert.match(bad.stderr, /Unknown --to target/);
});
