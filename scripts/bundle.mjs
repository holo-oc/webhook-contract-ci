import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL("../", import.meta.url).pathname);
const entry = path.join(repoRoot, "src", "cli.ts");
const outDir = path.join(repoRoot, "dist", "bundle");
const outFile = path.join(outDir, "cli.cjs");

fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  // No hashbang: GitHub Action invokes the bundle via `node`.
  // Keep output deterministic-ish.
  legalComments: "none",
  logLevel: "info",
});
