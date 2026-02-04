import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
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

test("cli: diff --json breakingPaths includes pointer+detail for typeChanged/constraintsChanged", () => {
  // typeChanged
  {
    const base = path.join(repoRoot, "examples", "schema.json");
    const next = path.join(repoRoot, "examples", "payload-typechange.json");

    const r = run(["diff", "--base", base, "--next", next, "--json"]);
    assert.equal(r.status, 1);

    const obj = JSON.parse(r.stdout);
    assert.equal(obj.ok, false);
    assert.equal(obj.breaking.typeChanged.length, 1);

    const typeEntry = obj.breakingPaths.find((x) => x.kind === "typeChanged");
    assert.equal(typeof typeEntry.pointer, "string");
    assert.equal(typeEntry.pointer, "/id");
    assert.equal(typeof typeEntry.detail, "string");
    assert.match(typeEntry.detail, /->/);
    assert.equal(typeEntry.detail.endsWith(")"), false);
  }

  // constraintsChanged (added under closed object)
  {
    const base = path.join(repoRoot, "test", "fixtures", "base.closed.schema.json");
    const next = path.join(repoRoot, "test", "fixtures", "next.closed-added.payload.json");

    const r = run(["diff", "--base", base, "--next", next, "--json"]);
    assert.equal(r.status, 1);

    const obj = JSON.parse(r.stdout);
    assert.equal(obj.ok, false);
    assert.equal(obj.breaking.constraintsChanged.length, 1);

    const entry = obj.breakingPaths.find((x) => x.kind === "constraintsChanged");
    assert.equal(entry.pointer, "/b");
    assert.equal(typeof entry.detail, "string");
    assert.match(entry.detail, /closed object/);
    assert.equal(entry.detail.endsWith(")"), false);
  }
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

test("cli: diff --json breakingPaths are deterministically sorted by pointer+kind", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wcci-test-"));

  const baseFile = path.join(tmpDir, "base.schema.json");
  const nextFile = path.join(tmpDir, "next.payload.json");

  // Base: closed object with two required fields.
  const baseSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      b: { type: "string" },
      a: { type: "string" },
    },
    required: ["a", "b"],
  };

  // Next payload: missing required 'a' and adds new key 'c' (breaking under closed object).
  const nextPayload = {
    b: "ok",
    c: "new",
  };

  fs.writeFileSync(baseFile, JSON.stringify(baseSchema, null, 2));
  fs.writeFileSync(nextFile, JSON.stringify(nextPayload, null, 2));

  const r = run(["diff", "--base", baseFile, "--next", nextFile, "--json"]);
  assert.equal(r.status, 1);

  const obj = JSON.parse(r.stdout);
  assert.equal(obj.ok, false);
  assert.equal(obj.breakingCount > 0, true);

  const pointers = obj.breakingPaths.map((x) => x.pointer);
  assert.deepEqual(pointers, ["/a", "/c"]);
});

test("cli: diff supports --next-schema for schema-to-schema comparisons", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wcci-test-"));

  const baseFile = path.join(tmpDir, "base.schema.json");
  const nextSchemaFile = path.join(tmpDir, "next.schema.json");

  const baseSchema = {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  };

  const nextSchema = {
    type: "object",
    properties: { id: { type: "number" } },
    required: ["id"],
  };

  fs.writeFileSync(baseFile, JSON.stringify(baseSchema, null, 2));
  fs.writeFileSync(nextSchemaFile, JSON.stringify(nextSchema, null, 2));

  const r = run(["diff", "--base", baseFile, "--next-schema", nextSchemaFile, "--json"]);
  assert.equal(r.status, 1);

  const obj = JSON.parse(r.stdout);
  assert.equal(obj.ok, false);
  assert.equal(obj.breaking.typeChanged.length, 1);
  assert.equal(obj.breakingPaths.some((x) => x.kind === "typeChanged" && x.pointer === "/id"), true);
});
