import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const doctor = path.join(repo, "scripts", "skill-doctor.mjs");

function runDoctor(args) {
  const r = spawnSync(process.execPath, [doctor, ...args], { encoding: "utf8" });
  const results = r.stdout
    .split(/\n(?=\{)/)
    .map((chunk) => {
      try {
        return JSON.parse(chunk);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { code: r.status, results, stderr: r.stderr };
}

test("skill-doctor passes the bundled skill and every example skill", () => {
  const r = runDoctor([path.join(repo, "skill", "recorder2skill"), path.join(repo, "examples", "skills")]);
  assert.equal(r.code, 0, r.results.map((x) => x.errors.join("; ")).join("|"));
  assert.ok(r.results.length >= 3, "bundled skill + 2 example skills");
  assert.ok(r.results.every((x) => x.ok));
});

test("skill-doctor round-trips save-skill output", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "r2s-doctor-rt-"));
  mkdirSync(path.join(dir, "skills"), { recursive: true });
  const body = path.join(dir, "body.md");
  writeFileSync(body, "Do the thing, then verify it.");
  const save = spawnSync(
    process.execPath,
    [path.join(repo, "scripts", "recorder-cli.mjs"), "save-skill", "roundtrip skill", "--description", "Validates the generated skill end to end.", "--body-file", body],
    { env: { ...process.env, RECORDER2SKILL_DATA_DIR: dir }, encoding: "utf8" },
  );
  assert.equal(save.status, 0, save.stderr);
  const r = runDoctor([path.join(dir, "skills", "roundtrip-skill")]);
  assert.equal(r.code, 0);
  assert.equal(r.results[0].ok, true);
});

test("skill-doctor rejects broken skills with non-zero exit", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "r2s-doctor-bad-"));
  const cases = [
    ["no-frontmatter", "name: x\ndescription: y\n---\nbody without opening fence\n"],
    ["bad-name", '---\nname: Bad Name!\ndescription: "ok"\n---\ndo it\n'],
    ["no-description", "---\nname: missing-desc\n---\ndo it\n"],
    ["escaped-newline-desc", '---\nname: esc-desc\ndescription: "a\\nb"\n---\nbody\n'],
  ];
  const paths = [];
  for (const [name, content] of cases) {
    const skillDir = path.join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), content);
    paths.push(skillDir);
  }
  const r = runDoctor(paths);
  assert.equal(r.code, 1);
  const flat = r.results.map((x) => x.errors.join("; ")).join("|");
  assert.match(flat, /frontmatter block/);
  assert.match(flat, /slug-safe/);
  assert.match(flat, /missing required field: description/);
  assert.match(flat, /escaped newline/);
});

test("skill-doctor exits 2 with usage when given no targets", () => {
  const r = spawnSync(process.execPath, [doctor], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage:/);
});
