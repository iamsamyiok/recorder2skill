import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", ".opencode", "plugins", "recorder-demo.ts");
const outdir = path.join(here, "build");

mkdirSync(outdir, { recursive: true });
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["@opencode-ai/plugin"],
  outfile: path.join(outdir, "plugin.mjs"),
  logLevel: "info",
});
