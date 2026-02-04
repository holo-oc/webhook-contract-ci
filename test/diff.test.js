import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { normalizeToJsonSchema, summarizeDiff } from "../dist/lib.js";

const fixturesDir = path.join(process.cwd(), "test", "fixtures");

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, rel), "utf8"));
}

test("diff: removed required path is breaking", () => {
  const base = normalizeToJsonSchema(readJson("base.schema.json"));

  // next schema with required id removed entirely
  const next = normalizeToJsonSchema({
    type: "object",
    properties: {
      nested: base.properties.nested,
    },
    required: ["nested"],
  });

  const { breaking, breakingCount } = summarizeDiff(base, next);
  assert.equal(breakingCount > 0, true);
  assert.deepEqual(breaking.removedRequired, ["/id"]);
});

test("diff: required became optional is breaking", () => {
  const base = normalizeToJsonSchema(readJson("base.schema.json"));
  const next = normalizeToJsonSchema(readJson("next.required-became-optional.schema.json"));

  const { breaking, breakingCount } = summarizeDiff(base, next);
  assert.equal(breakingCount > 0, true);
  assert.deepEqual(breaking.requiredBecameOptional, ["/id"]);
});

test("diff: type change is breaking", () => {
  const base = normalizeToJsonSchema(readJson("base.schema.json"));
  const next = normalizeToJsonSchema(readJson("next.type-change.schema.json"));

  const { breaking, breakingCount } = summarizeDiff(base, next);
  assert.equal(breakingCount > 0, true);
  assert.equal(breaking.typeChanged.length, 1);
  assert.match(breaking.typeChanged[0], /^\/id/);
});

test("diff: added fields + removed optional fields are non-breaking", () => {
  const base = normalizeToJsonSchema(readJson("base.schema.json"));

  // Remove optional "opt" from next, add new fields.
  const next = normalizeToJsonSchema(readJson("next.nonbreaking.schema.json"));

  const { breakingCount, nonBreaking } = summarizeDiff(base, next);
  assert.equal(breakingCount, 0);

  // These are new pointers present in next but not in base.
  assert(nonBreaking.added.includes("/addedTop"));
  assert(nonBreaking.added.includes("/nested/newField"));

  // Optional removal should be tracked as non-breaking.
  assert.deepEqual(nonBreaking.removedOptional, ["/opt"]);
});
