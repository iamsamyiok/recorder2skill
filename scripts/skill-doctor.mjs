#!/usr/bin/env node
// skill-doctor: validate generated Agent Skills files (SKILL.md) for
// structural correctness and cross-parser compatibility (Codex CLI / Claude
// Code / OpenCode all read the same frontmatter conventions):
//   - frontmatter delimited by --- ... --- as the first content
//   - name: required, <= 64 chars (Codex MAX_NAME_LEN), slug-safe, and equal
//     to the skill directory name when validating a directory
//   - description: required, single line (strict parsers reject multi-line
//     YAML scalars), <= 1024 chars (marketplace convention)
//   - allowed-tools: optional list of non-empty strings
//   - body: non-empty; placeholder markers are reported as warnings
//
// Usage: node scripts/skill-doctor.mjs <skillDir|SKILL.md> [more...]
// Prints one JSON line per skill: { ok, path, errors, warnings }.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function die(msg) {
  process.stderr.write(`[recorder2skill] ${msg}\n`);
  process.exit(2);
}

function skillFileOf(target) {
  if (statSync(target).isDirectory()) {
    const f = path.join(target, "SKILL.md");
    return existsSync(f) ? f : null;
  }
  return target;
}

function parseFrontmatter(text) {
  if (!text.startsWith("---")) return { error: "file must start with a --- frontmatter block" };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { error: "frontmatter block is never closed (expected a second ---)" };
  const lines = text.slice(3, end).split("\n");
  const meta = {};
  const tools = [];
  let inTools = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s+-\s+/.test(line)) {
      if (inTools) tools.push(line.replace(/^\s+-\s+/, "").trim());
      continue;
    }
    inTools = false;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    inTools = m[1] === "allowed-tools" && m[2].trim() === "";
    meta[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  const body = text.slice(text.indexOf("---", end + 1) + 3).trim();
  return { meta, tools, body };
}

function validate(target) {
  const errors = [];
  const warnings = [];
  let file;
  try {
    file = skillFileOf(target);
  } catch (err) {
    return { ok: false, path: target, errors: [`cannot read target: ${err.message}`], warnings };
  }
  if (!file) {
    return { ok: false, path: target, errors: ["directory has no SKILL.md"], warnings };
  }
  const text = readFileSync(file, "utf8");
  const parsed = parseFrontmatter(text);
  if (parsed.error) errors.push(parsed.error);
  const { meta = {}, tools = [], body = "" } = parsed;

  const name = meta.name ?? "";
  if (!name) errors.push("frontmatter is missing required field: name");
  else {
    if (name.length > 64) errors.push(`name is ${name.length} chars (parsers allow at most 64)`);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) errors.push(`name "${name}" is not slug-safe (lowercase letters, digits, . _ -)`);
    const dirName = path.basename(path.dirname(file));
    if (path.basename(file) === "SKILL.md" && dirName !== name && dirName !== "skills") {
      warnings.push(`directory name "${dirName}" differs from name "${name}"`);
    }
  }

  const description = meta.description ?? "";
  if (!description) errors.push("frontmatter is missing required field: description");
  else {
    // Line-based parsing keeps descriptions on one line; an escaped \n inside
    // the quoted value is the one way a newline can still sneak in.
    if (description.includes("\\n")) errors.push('description contains an escaped newline (\\n); keep it one literal line');
    if (description.length > 1024) errors.push(`description is ${description.length} chars (marketplace convention caps at 1024)`);
  }

  for (const t of tools) {
    if (!t) errors.push("allowed-tools contains an empty entry");
  }

  if (!body) errors.push("SKILL.md has no body after the frontmatter");
  if (/\bTODO\b|\bFIXME\b|\bTBD\b/.test(body)) warnings.push("body contains TODO/FIXME/TBD placeholders");

  return { ok: errors.length === 0, path: file, errors, warnings };
}

const targets = process.argv.slice(2);
if (targets.length === 0) die('Usage: node scripts/skill-doctor.mjs <skillDir|SKILL.md> [more...]\nTip: pass a directory to validate every skill inside it.');

const expanded = [];
for (const t of targets) {
  if (!existsSync(t)) die(`No such path: ${t}`);
  if (statSync(t).isDirectory() && !existsSync(path.join(t, "SKILL.md"))) {
    for (const entry of readdirSync(t).sort()) {
      const sub = path.join(t, entry);
      if (statSync(sub).isDirectory() && existsSync(path.join(sub, "SKILL.md"))) expanded.push(sub);
    }
  } else {
    expanded.push(t);
  }
}

const results = expanded.map(validate);
for (const r of results) {
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
