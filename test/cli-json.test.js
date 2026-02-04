import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const cli = path.join(repoRoot, "dist", "cli.js");

function run(args) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
  });
  return r;
}

test("cli: diff --json emits machine-readable output and exit 0 on ok", () => {
  const base = path.join(repoRoot, "examples", "schema.json");
  const next = path.join(repoRoot, "examples", "payload.json");

  const r = run(["diff", "--base", base, "--next", next, "--json"]);
  assert.equal(r.status, 0, r.stderr);

  const obj = JSON.parse(r.stdout);
  assert.equal(obj.ok, true);
  assert.equal(obj.breakingCount, 0);
  assert.deepEqual(obj.breaking.removedRequired, []);
});

test("cli: diff --json exit 1 on breaking changes and includes nonBreaking only with --show-nonbreaking", () => {
  const base = path.join(repoRoot, "examples", "schema.json");
  const next = path.join(repoRoot, "examples", "payload-breaking.json");

  const r1 = run(["diff", "--base", base, "--next", next, "--json"]);
  assert.equal(r1.status, 1);
  const obj1 = JSON.parse(r1.stdout);
  assert.equal(obj1.ok, false);
  assert.equal(obj1.breakingCount > 0, true);
  assert.equal(obj1.nonBreaking, undefined);

  const r2 = run(["diff", "--base", base, "--next", next, "--json", "--show-nonbreaking"]);
  assert.equal(r2.status, 1);
  const obj2 = JSON.parse(r2.stdout);
  assert.equal(obj2.ok, false);
  assert.equal(typeof obj2.nonBreaking, "object");
  assert(Array.isArray(obj2.nonBreaking.added));
});

test("cli: check --json returns ok=false and formatted errors", () => {
  const schema = path.join(repoRoot, "examples", "schema.json");
  const bad = path.join(repoRoot, "test", "fixtures", "bad.payload.json");

  const r = run(["check", "--schema", schema, "--in", bad, "--json"]);
  assert.equal(r.status, 1);

  const obj = JSON.parse(r.stdout);
  assert.equal(obj.ok, false);
  assert.equal(typeof obj.formattedErrors, "string");
  assert.equal(obj.formattedErrors.length > 0, true);
});
