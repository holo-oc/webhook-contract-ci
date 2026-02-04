import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { inferSchemaFromPayload, normalizeToJsonSchema, summarizeDiff } from "../dist/lib.js";

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

test("diff: type widening is breaking (e.g., string -> [string, null])", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    properties: { id: { type: ["string", "null"] } },
    required: ["id"],
  });

  const { breaking, breakingCount } = summarizeDiff(base, next);
  assert.equal(breakingCount > 0, true);
  assert.equal(breaking.typeChanged.length, 1);
  assert.match(breaking.typeChanged[0], /^\/id/);
});

test("diff: type narrowing is non-breaking (e.g., [string, number] -> string)", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: { id: { type: ["string", "number"] } },
    required: ["id"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  });

  const { breakingCount, breaking } = summarizeDiff(base, next);
  assert.equal(breakingCount, 0);
  assert.deepEqual(breaking.typeChanged, []);
});

test("diff: integer is a subset of number (number -> integer is non-breaking; integer -> number is breaking)", () => {
  const baseNumber = normalizeToJsonSchema({
    type: "object",
    properties: { amount: { type: "number" } },
    required: ["amount"],
  });

  const nextInteger = normalizeToJsonSchema({
    type: "object",
    properties: { amount: { type: "integer" } },
    required: ["amount"],
  });

  const r1 = summarizeDiff(baseNumber, nextInteger);
  assert.equal(r1.breakingCount, 0);

  const baseInteger = nextInteger;
  const nextNumber = baseNumber;

  const r2 = summarizeDiff(baseInteger, nextNumber);
  assert.equal(r2.breakingCount > 0, true);
  assert.equal(r2.breaking.typeChanged.length, 1);
  assert.match(r2.breaking.typeChanged[0], /^\/amount/);
});

test("diff: type change with no overlap is breaking (e.g., string -> number)", () => {
  const base = normalizeToJsonSchema(readJson("base.schema.json"));
  const next = normalizeToJsonSchema(readJson("next.type-change.schema.json"));

  const { breaking, breakingCount } = summarizeDiff(base, next);
  assert.equal(breakingCount > 0, true);
  assert.equal(breaking.typeChanged.length, 1);
  assert.match(breaking.typeChanged[0], /^\/id/);
});

test("diff: enum widening is breaking; enum narrowing is non-breaking", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: { status: { type: "string", enum: ["a", "b"] } },
    required: ["status"],
  });

  const nextWiden = normalizeToJsonSchema({
    type: "object",
    properties: { status: { type: "string", enum: ["a", "b", "c"] } },
    required: ["status"],
  });

  const r1 = summarizeDiff(base, nextWiden);
  assert.equal(r1.breakingCount > 0, true);
  assert.equal(r1.breaking.constraintsChanged.length, 1);
  assert.match(r1.breaking.constraintsChanged[0], /^\/status/);

  const nextNarrow = normalizeToJsonSchema({
    type: "object",
    properties: { status: { type: "string", enum: ["a"] } },
    required: ["status"],
  });

  const r2 = summarizeDiff(base, nextNarrow);
  assert.equal(r2.breakingCount, 0);
});

test("diff: enum object values compare deterministically (key order doesn't matter)", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      kind: {
        type: "object",
        enum: [{ a: 1, b: 2 }],
      },
    },
    required: ["kind"],
  });

  const nextSameValueDifferentOrder = normalizeToJsonSchema({
    type: "object",
    properties: {
      kind: {
        type: "object",
        enum: [{ b: 2, a: 1 }],
      },
    },
    required: ["kind"],
  });

  const r = summarizeDiff(base, nextSameValueDifferentOrder);
  assert.equal(r.breakingCount, 0);
});

test("diff: const object values compare deterministically (key order doesn't matter)", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      kind: {
        type: "object",
        const: { a: 1, b: 2 },
      },
    },
    required: ["kind"],
  });

  const nextSameValueDifferentOrder = normalizeToJsonSchema({
    type: "object",
    properties: {
      kind: {
        type: "object",
        const: { b: 2, a: 1 },
      },
    },
    required: ["kind"],
  });

  const r = summarizeDiff(base, nextSameValueDifferentOrder);
  assert.equal(r.breakingCount, 0);
});

test("diff: loosening numeric/string bounds is breaking", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      amount: { type: "number", maximum: 10 },
      id: { type: "string", maxLength: 4 },
    },
    required: ["amount", "id"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    properties: {
      amount: { type: "number", maximum: 20 },
      id: { type: "string", maxLength: 8 },
    },
    required: ["amount", "id"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount, 2);
  assert.deepEqual(r.breaking.typeChanged, []);
  assert.equal(r.breaking.constraintsChanged.length, 2);
  assert.deepEqual(r.breaking.constraintsChanged.map((x) => x.split(" ", 1)[0]), ["/amount", "/id"]);
});

test("diff: missing inferred type for a required field is treated as breaking (conservative)", () => {
  const base = normalizeToJsonSchema(readJson("base.schema.json"));
  const next = normalizeToJsonSchema(readJson("next.missing-type.schema.json"));

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

test("diff: output lists are deterministically sorted by pointer", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {},
    required: [],
  });

  // Intentionally insert properties in reverse order.
  const next = normalizeToJsonSchema({
    type: "object",
    properties: {
      zzz: { type: "string" },
      aaa: { type: "string" },
    },
    required: ["zzz", "aaa"],
  });

  const { breakingCount, nonBreaking } = summarizeDiff(base, next);
  assert.equal(breakingCount, 0);
  assert.deepEqual(nonBreaking.added, ["/aaa", "/zzz"]);
});

test("infer: inferred schema has deterministically sorted object properties + required arrays", () => {
  const payload = {
    zzz: "hi",
    aaa: "bye",
  };

  const schema = inferSchemaFromPayload(payload);

  assert.deepEqual(Object.keys(schema.properties), ["aaa", "zzz"]);
  assert.deepEqual(schema.required, ["aaa", "zzz"]);
});
