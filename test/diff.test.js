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

test("diff: type extraction handles anyOf/oneOf unions", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      id: {
        anyOf: [{ type: "string" }, { type: "number" }],
      },
    },
    required: ["id"],
  });

  // Narrow to one of the base types (non-breaking).
  const nextNarrow = normalizeToJsonSchema({
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  });

  const r1 = summarizeDiff(base, nextNarrow);
  assert.equal(r1.breakingCount, 0);

  // Widen beyond the base union (breaking).
  const nextWiden = normalizeToJsonSchema({
    type: "object",
    properties: {
      id: {
        oneOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
      },
    },
    required: ["id"],
  });

  const r2 = summarizeDiff(base, nextWiden);
  assert.equal(r2.breakingCount > 0, true);
  assert.equal(r2.breaking.typeChanged.length, 1);
  assert.match(r2.breaking.typeChanged[0], /^\/id/);
});

test("diff: type extraction handles allOf intersections (basic)", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      id: {
        allOf: [{ type: "string" }, { minLength: 1 }],
      },
      amount: {
        allOf: [{ type: "number" }, { type: "integer" }],
      },
    },
    required: ["id", "amount"],
  });

  const nextOk = normalizeToJsonSchema({
    type: "object",
    properties: {
      id: { type: "string" },
      amount: { type: "integer" },
    },
    required: ["id", "amount"],
  });

  const r1 = summarizeDiff(base, nextOk);
  assert.equal(r1.breakingCount, 0);

  const nextBreak = normalizeToJsonSchema({
    type: "object",
    properties: {
      id: { type: ["string", "null"] },
      amount: { type: "integer" },
    },
    required: ["id", "amount"],
  });

  const r2 = summarizeDiff(base, nextBreak);
  assert.equal(r2.breakingCount > 0, true);
  assert.equal(r2.breaking.typeChanged.some((x) => x.startsWith("/id")), true);
});

test("diff: type extraction handles OpenAPI nullable: true", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
  });

  const nextNullable = normalizeToJsonSchema({
    type: "object",
    properties: {
      id: { type: "string", nullable: true },
    },
    required: ["id"],
  });

  const r = summarizeDiff(base, nextNullable);
  assert.equal(r.breakingCount > 0, true);
  assert.equal(r.breaking.typeChanged.length, 1);
  assert.match(r.breaking.typeChanged[0], /^\/id/);
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

test("diff: base enum vs next const (inferred) is only breaking when the value is outside the enum", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: { status: { type: "string", enum: ["a", "b"] } },
    required: ["status"],
  });

  const nextConstOk = normalizeToJsonSchema({
    type: "object",
    properties: { status: { type: "string", const: "a" } },
    required: ["status"],
  });

  const r1 = summarizeDiff(base, nextConstOk);
  assert.equal(r1.breakingCount, 0);

  const nextConstBad = normalizeToJsonSchema({
    type: "object",
    properties: { status: { type: "string", const: "c" } },
    required: ["status"],
  });

  const r2 = summarizeDiff(base, nextConstBad);
  assert.equal(r2.breakingCount > 0, true);
  assert.equal(r2.breaking.constraintsChanged.length, 1);
  assert.match(r2.breaking.constraintsChanged[0], /^\/status/);
});

test("diff: base const vs next enum is only non-breaking when enum contains ONLY the const", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: { status: { type: "string", const: "a" } },
    required: ["status"],
  });

  const nextSame = normalizeToJsonSchema({
    type: "object",
    properties: { status: { type: "string", enum: ["a"] } },
    required: ["status"],
  });

  const r1 = summarizeDiff(base, nextSame);
  assert.equal(r1.breakingCount, 0);

  const nextWiden = normalizeToJsonSchema({
    type: "object",
    properties: { status: { type: "string", enum: ["a", "b"] } },
    required: ["status"],
  });

  const r2 = summarizeDiff(base, nextWiden);
  assert.equal(r2.breakingCount > 0, true);
  assert.equal(r2.breaking.constraintsChanged.length, 1);
  assert.match(r2.breaking.constraintsChanged[0], /^\/status/);
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

test("diff: adding a property under a closed object (additionalProperties:false) is breaking", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      newField: { type: "string" },
    },
    required: ["id", "newField"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount > 0, true);
  assert.equal(r.breaking.constraintsChanged.some((x) => x.startsWith("/newField")), true);
});

test("diff: base additionalProperties:false -> next allows extras (schema) is breaking", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    additionalProperties: { type: "string" },
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount > 0, true);
  assert.equal(r.breaking.constraintsChanged.some((x) => x.includes("additionalProperties opened")), true);
});

test("diff: adding a key that violates additionalProperties subschema is breaking", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    additionalProperties: { type: "string" },
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    additionalProperties: { type: "string" },
    properties: {
      id: { type: "string" },
      count: { type: "number" },
    },
    required: ["id", "count"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount > 0, true);
  assert.equal(
    r.breaking.constraintsChanged.some((x) => x.includes("violates additionalProperties schema")),
    true
  );
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

test("diff: pattern change is treated as breaking when explicitly present in both schemas", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      id: { type: "string", pattern: "^[a-z]+$" },
    },
    required: ["id"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    properties: {
      id: { type: "string", pattern: "^[a-z0-9]+$" },
    },
    required: ["id"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount > 0, true);
  assert.equal(r.breaking.constraintsChanged.length, 1);
  assert.match(r.breaking.constraintsChanged[0], /^\/id/);
});

test("diff: base pattern vs next missing pattern is ignored (avoid noisy inference gaps)", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      id: { type: "string", pattern: "^[a-z]+$" },
    },
    required: ["id"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount, 0);
});

test("diff: propertyNames pattern changes are treated as breaking when explicitly present in both schemas", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      metadata: {
        type: "object",
        // Only allow lowercase keys in the map.
        propertyNames: { pattern: "^[a-z_]+$" },
        additionalProperties: { type: "string" },
      },
    },
    required: ["metadata"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    properties: {
      metadata: {
        type: "object",
        // Widen: now allow digits too.
        propertyNames: { pattern: "^[a-z0-9_]+$" },
        additionalProperties: { type: "string" },
      },
    },
    required: ["metadata"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount > 0, true);
  assert.equal(r.breaking.constraintsChanged.length, 1);
  assert.match(r.breaking.constraintsChanged[0], /^\/metadata/);
});

test("diff: base propertyNames pattern vs next missing is ignored (avoid noisy inference gaps)", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      metadata: {
        type: "object",
        propertyNames: { pattern: "^[a-z_]+$" },
        additionalProperties: { type: "string" },
      },
    },
    required: ["metadata"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    properties: {
      metadata: {
        type: "object",
        additionalProperties: { type: "string" },
      },
    },
    required: ["metadata"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount, 0);
});

test("diff: exclusive numeric bound changes are compared across maximum/exclusiveMaximum", () => {
  const baseExclusive = normalizeToJsonSchema({
    type: "object",
    properties: { amount: { type: "number", exclusiveMaximum: 10 } },
    required: ["amount"],
  });

  const nextInclusiveSameValue = normalizeToJsonSchema({
    type: "object",
    properties: { amount: { type: "number", maximum: 10 } },
    required: ["amount"],
  });

  const r1 = summarizeDiff(baseExclusive, nextInclusiveSameValue);
  assert.equal(r1.breakingCount > 0, true);
  assert.equal(r1.breaking.constraintsChanged.some((x) => x.startsWith("/amount ")), true);

  const baseInclusive = nextInclusiveSameValue;
  const nextExclusiveSameValue = baseExclusive;

  const r2 = summarizeDiff(baseInclusive, nextExclusiveSameValue);
  assert.equal(r2.breakingCount, 0);
});

test("diff: exclusive numeric bound changes are compared across minimum/exclusiveMinimum", () => {
  const baseExclusive = normalizeToJsonSchema({
    type: "object",
    properties: { amount: { type: "number", exclusiveMinimum: 5 } },
    required: ["amount"],
  });

  const nextInclusiveSameValue = normalizeToJsonSchema({
    type: "object",
    properties: { amount: { type: "number", minimum: 5 } },
    required: ["amount"],
  });

  const r1 = summarizeDiff(baseExclusive, nextInclusiveSameValue);
  assert.equal(r1.breakingCount > 0, true);
  assert.equal(r1.breaking.constraintsChanged.some((x) => x.startsWith("/amount ")), true);

  const baseInclusive = nextInclusiveSameValue;
  const nextExclusiveSameValue = baseExclusive;

  const r2 = summarizeDiff(baseInclusive, nextExclusiveSameValue);
  assert.equal(r2.breakingCount, 0);
});

test("diff: multipleOf changes are breaking unless tightened", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      v: { type: "number", multipleOf: 10 },
    },
    required: ["v"],
  });

  // Tighten: only multiples of 20 (subset of multiples of 10) => non-breaking
  const nextTight = normalizeToJsonSchema({
    type: "object",
    properties: {
      v: { type: "number", multipleOf: 20 },
    },
    required: ["v"],
  });

  const r1 = summarizeDiff(base, nextTight);
  assert.equal(r1.breakingCount, 0);

  // Loosen: multiples of 5 (superset) => breaking
  const nextLoose = normalizeToJsonSchema({
    type: "object",
    properties: {
      v: { type: "number", multipleOf: 5 },
    },
    required: ["v"],
  });

  const r2 = summarizeDiff(base, nextLoose);
  assert.equal(r2.breakingCount > 0, true);
  assert.equal(r2.breaking.constraintsChanged.some((x) => x.startsWith("/v ")), true);

  // Change to non-divisible value: potential widening => breaking
  const nextWeird = normalizeToJsonSchema({
    type: "object",
    properties: {
      v: { type: "number", multipleOf: 6 },
    },
    required: ["v"],
  });

  const r3 = summarizeDiff(base, nextWeird);
  assert.equal(r3.breakingCount > 0, true);
  assert.equal(r3.breaking.constraintsChanged.some((x) => x.startsWith("/v ")), true);
});

test("diff: loosening array bounds is breaking", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      arr: { type: "array", items: { type: "string" }, maxItems: 3, minItems: 1 },
    },
    required: ["arr"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    properties: {
      arr: { type: "array", items: { type: "string" }, maxItems: 10, minItems: 0 },
    },
    required: ["arr"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount, 2);
  assert.equal(r.breaking.constraintsChanged.length, 2);
  assert.deepEqual(r.breaking.constraintsChanged.map((x) => x.split(" ", 1)[0]), ["/arr", "/arr"]);
});

test("diff: loosening object property count bounds is breaking", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    minProperties: 1,
    maxProperties: 2,
    properties: {
      a: { type: "string" },
      b: { type: "string" },
    },
    required: ["a"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    minProperties: 0,
    maxProperties: 3,
    properties: {
      a: { type: "string" },
      b: { type: "string" },
    },
    required: ["a"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount, 2);
  assert.equal(r.breaking.constraintsChanged.length, 2);
  assert.match(r.breaking.constraintsChanged[0], /^\//);
});

test("diff: missing inferred type for a required field is treated as breaking (conservative)", () => {
  const base = normalizeToJsonSchema(readJson("base.schema.json"));
  const next = normalizeToJsonSchema(readJson("next.missing-type.schema.json"));

  const { breaking, breakingCount } = summarizeDiff(base, next);
  assert.equal(breakingCount > 0, true);
  assert.equal(breaking.typeChanged.length, 1);
  assert.match(breaking.typeChanged[0], /^\/id/);
});

test("diff: missing inferred type for an OPTIONAL field is non-breaking (avoid noisy inference gaps)", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      id: { type: "string" },
      opt: { type: "string" },
    },
    required: ["id"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    properties: {
      id: { type: "string" },
      opt: {},
    },
    required: ["id"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount, 0);
  assert.deepEqual(r.breaking.typeChanged, []);
});

test("diff: added fields are non-breaking; optional removals are only reported when next parent is closed", () => {
  const base = normalizeToJsonSchema(readJson("base.schema.json"));

  // Remove optional "opt" from next, add new fields.
  const next = normalizeToJsonSchema(readJson("next.nonbreaking.schema.json"));

  const { breakingCount, nonBreaking } = summarizeDiff(base, next);
  assert.equal(breakingCount, 0);

  // These are new pointers present in next but not in base.
  assert(nonBreaking.added.includes("/addedTop"));
  assert(nonBreaking.added.includes("/nested/newField"));

  // Because next is inferred and the parent object isn't explicitly closed,
  // we do not claim optional keys were "removed".
  assert.deepEqual(nonBreaking.removedOptional, []);
});

test("diff: removed optional key is reported when next parent object is closed", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      opt: { type: "string" },
    },
    required: ["id"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount, 0);
  assert.deepEqual(r.nonBreaking.removedOptional, ["/opt"]);
});

test("diff: adding a property under an additionalProperties:false object is breaking", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      newField: { type: "string" },
    },
    required: ["id", "newField"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount > 0, true);
  assert.equal(r.breaking.constraintsChanged.length, 1);
  assert.match(r.breaking.constraintsChanged[0], /^\/newField/);
});

test("diff: adding a nested property under a closed object is breaking", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      nested: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    required: ["nested"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    properties: {
      nested: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" }, extra: { type: "string" } },
        required: ["id", "extra"],
      },
    },
    required: ["nested"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount > 0, true);
  assert.equal(r.breaking.constraintsChanged.length, 1);
  assert.match(r.breaking.constraintsChanged[0], /^\/nested\/extra/);
});

test("diff: array item type widening is breaking", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      arr: { type: "array", items: { type: "string" } },
    },
    required: ["arr"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    properties: {
      arr: { type: "array", items: { type: ["string", "null"] } },
    },
    required: ["arr"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount > 0, true);
  assert.equal(r.breaking.typeChanged.length, 1);
  assert.match(r.breaking.typeChanged[0], /^\/arr\/\*/);
});

test("diff: tuple array item type widening is breaking and uses /[index] pointers", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      arr: {
        type: "array",
        items: [{ type: "string" }, { type: "number" }],
      },
    },
    required: ["arr"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    properties: {
      arr: {
        type: "array",
        items: [{ type: "string" }, { type: ["number", "null"] }],
      },
    },
    required: ["arr"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount > 0, true);
  assert.equal(r.breaking.typeChanged.length, 1);
  assert.match(r.breaking.typeChanged[0], /^\/arr\/\[1\]/);
});

test("diff: pointer escaping follows RFC6901-ish rules (~ and /)", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    properties: {
      "a/b": { type: "string" },
      "til~de": { type: "string" },
    },
    required: ["a/b", "til~de"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    properties: {
      // Remove both required fields entirely
    },
    required: [],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount > 0, true);
  assert.deepEqual(r.breaking.removedRequired.sort(), ["/a~1b", "/til~0de"].sort());
});

test("diff: opening additionalProperties:false -> true is breaking", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    additionalProperties: true,
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount > 0, true);
  assert.equal(r.breaking.constraintsChanged.length, 1);
  assert.match(r.breaking.constraintsChanged[0], /^\/ \(additionalProperties opened\)$/);
});

test("diff: loosening additionalProperties schema -> true is breaking", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    additionalProperties: { type: "string" },
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    additionalProperties: true,
    properties: {
      id: { type: "string" },
    },
    required: ["id"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount > 0, true);
  assert.equal(r.breaking.constraintsChanged.length, 1);
  assert.match(r.breaking.constraintsChanged[0], /^\/ \(additionalProperties schema loosened\)$/);
});

test("diff: base additionalProperties:false vs next unspecified does not count as opened", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    additionalProperties: false,
    properties: { id: { type: "string" } },
    required: ["id"],
  });

  // Common shape for inferred schemas: omit `additionalProperties`.
  const next = normalizeToJsonSchema({
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount, 0);
});

test("diff: added key under additionalProperties subschema is breaking if value type is incompatible", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    additionalProperties: { type: "string" },
    properties: { id: { type: "string" } },
    required: ["id"],
  });

  const nextBad = normalizeToJsonSchema({
    type: "object",
    additionalProperties: { type: "string" },
    properties: {
      id: { type: "string" },
      // new additionalProperties key with incompatible type
      extra: { type: "number" },
    },
    required: ["id", "extra"],
  });

  const r1 = summarizeDiff(base, nextBad);
  assert.equal(r1.breakingCount > 0, true);
  assert.equal(r1.breaking.constraintsChanged.length, 1);
  assert.match(r1.breaking.constraintsChanged[0], /^\/extra/);

  const nextOk = normalizeToJsonSchema({
    type: "object",
    additionalProperties: { type: "string" },
    properties: {
      id: { type: "string" },
      extra: { type: "string" },
    },
    required: ["id", "extra"],
  });

  const r2 = summarizeDiff(base, nextOk);
  assert.equal(r2.breakingCount, 0);
});

test("diff: widening additionalProperties subschema is breaking", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    additionalProperties: { type: "string" },
    properties: { id: { type: "string" } },
    required: ["id"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    additionalProperties: { type: ["string", "number"] },
    properties: { id: { type: "string" } },
    required: ["id"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount > 0, true);
  assert.equal(r.breaking.typeChanged.length, 1);
  assert.match(r.breaking.typeChanged[0], /^\/\{additionalProperties\}/);
});

test("diff: adding an additionalProperties subschema (tightening) is non-breaking", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    additionalProperties: true,
    properties: { id: { type: "string" } },
    required: ["id"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    additionalProperties: { type: "string" },
    properties: { id: { type: "string" } },
    required: ["id"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount, 0);

  // The additionalProperties subschema is indexed as a synthetic child node, but we don't want to
  // report it as a newly "added" payload path.
  assert.equal(r.nonBreaking.added.includes("/{additionalProperties}"), false);
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

test("diff: property named 'items' does not collide with array items sentinel", () => {
  const base = normalizeToJsonSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      items: { type: "string" },
      arr: { type: "array", items: { type: "string" } },
    },
    required: ["items", "arr"],
  });

  const next = normalizeToJsonSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      items: { type: "string" },
      arr: { type: "array", items: { type: "string" } },
      extra: { type: "string" },
    },
    required: ["items", "arr", "extra"],
  });

  const r = summarizeDiff(base, next);
  assert.equal(r.breakingCount > 0, true);
  assert.equal(r.breaking.constraintsChanged.length, 1);
  assert.match(r.breaking.constraintsChanged[0], /^\/extra/);
});
