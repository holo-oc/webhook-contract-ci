import Ajv, { type ErrorObject } from "ajv";
import toJsonSchema from "to-json-schema";

export type TypeName =
  | "null"
  | "boolean"
  | "number"
  | "integer"
  | "string"
  | "array"
  | "object";

export type NodeInfo = {
  pointer: string; // JSON pointer-ish ("/a/b")
  type?: TypeName | TypeName[];
  required: boolean;

  // Common constraint keywords we can reason about deterministically.
  // NOTE: Diff semantics are *producer-change* oriented: if next schema is less restrictive
  // (allows more values) than base, that can be breaking because the producer may start
  // emitting values that existing consumers (validating against base) will reject.
  enum?: unknown[];
  const?: unknown;

  // Object-only constraints
  additionalProperties?: boolean | object;

  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  exclusiveMaximum?: number;

  multipleOf?: number;

  minLength?: number;
  maxLength?: number;

  // String constraints
  pattern?: string;

  // Array constraints
  minItems?: number;
  maxItems?: number;

  // Object constraints
  minProperties?: number;
  maxProperties?: number;
};

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "";
  return errors
    .map((e) => {
      const loc = e.instancePath || "/";
      return `- ${loc} ${e.message ?? "invalid"}`;
    })
    .join("\n");
}

/**
 * `to-json-schema` uses a nonstandard `required: true` boolean on properties.
 * AJV expects JSON Schema's `required: string[]` on the parent object.
 */
export function normalizeToJsonSchema(input: any): any {
  if (!input || typeof input !== "object") return input;

  if (Array.isArray(input)) return input.map(normalizeToJsonSchema);

  const out: any = { ...input };
  const booleanRequired = out.required === true;
  const explicitRequired: string[] | undefined = Array.isArray(out.required) ? out.required : undefined;

  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    const requiredKeys: string[] = [];
    const newProps: any = {};

    // Determinism: sort property keys so inferred/normalized schemas don't depend on
    // JSON insertion order (which can vary across payload samples).
    const keys = Object.keys(out.properties).sort((a, b) => a.localeCompare(b));

    for (const k of keys) {
      const v = (out.properties as any)[k];
      const vv = normalizeToJsonSchema(v);
      if (vv && typeof vv === "object" && vv.required === true) {
        requiredKeys.push(k);
        const { required, ...rest } = vv;
        newProps[k] = rest;
      } else {
        newProps[k] = vv;
      }
    }

    out.properties = newProps;

    if (requiredKeys.length > 0) {
      // If the input already uses standard JSON Schema `required: string[]`, keep it and
      // merge in any `required: true` property hints.
      const merged = new Set<string>([...(explicitRequired ?? []), ...requiredKeys]);
      out.required = Array.from(merged).sort((a, b) => a.localeCompare(b));
    } else if (booleanRequired) {
      // interpret "required: true" as "all object properties are required"
      out.required = Object.keys(newProps).sort((a, b) => a.localeCompare(b));
    } else if (explicitRequired) {
      out.required = explicitRequired;
    } else {
      delete out.required;
    }
  }

  // root-level `required: true` (boolean) is not meaningful in JSON Schema.
  if (out.required === true) delete out.required;

  return out;
}

export function inferSchemaFromPayload(payload: unknown): any {
  const rawSchema = toJsonSchema(payload, { required: true, arrays: { mode: "all" } });
  return normalizeToJsonSchema(rawSchema);
}

function toTypeList(t: any): TypeName[] | undefined {
  if (!t) return undefined;
  if (typeof t === "string") return [t as TypeName];
  if (Array.isArray(t)) return t as TypeName[];
  return undefined;
}

function uniqTypes(types: (TypeName | undefined)[]): TypeName[] {
  const out: TypeName[] = [];
  const seen = new Set<string>();
  for (const t of types) {
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function extractTypeFromSchemaNode(node: any): TypeName | TypeName[] | undefined {
  if (!node || typeof node !== "object") return undefined;

  // Standard JSON Schema
  if (node.type) {
    // OpenAPI-style nullable: true
    if (node.nullable === true) {
      const ts = toTypeList(node.type) ?? [];
      if (!ts.includes("null")) return [...ts, "null"];
    }
    return node.type as any;
  }

  // OpenAPI nullable without explicit type is too ambiguous.

  // anyOf/oneOf: union the member types (best-effort)
  const branches = Array.isArray(node.anyOf)
    ? node.anyOf
    : Array.isArray(node.oneOf)
      ? node.oneOf
      : undefined;

  if (branches) {
    const collected: TypeName[] = [];
    for (const b of branches) {
      const t = extractTypeFromSchemaNode(b);
      const list = toTypeList(t);
      if (list) collected.push(...list);
    }
    const u = uniqTypes(collected);
    if (u.length === 0) return undefined;
    if (u.length === 1) return u[0];
    return u;
  }

  // allOf: intersection.
  // We avoid full semantic evaluation, but we *can* extract a safe type signal when every branch
  // provides type information.
  if (Array.isArray((node as any).allOf)) {
    const branchesAllOf = (node as any).allOf as any[];
    const typeSets: Set<TypeName>[] = [];

    for (const b of branchesAllOf) {
      const t = extractTypeFromSchemaNode(b);
      const list = toTypeList(t);
      // It's common to use allOf to attach constraints (minLength, patterns, etc.) without repeating
      // `type`. If a branch doesn't provide type info, ignore it for type extraction.
      if (!list) continue;
      const s = new Set<TypeName>(list);
      // In unions, "integer" is a subset of "number"; treat ["number","integer"] as just "number".
      if (s.has("number")) s.delete("integer");
      typeSets.push(s);
    }

    if (typeSets.length === 0) return undefined;

    const intersectTwo = (a: Set<TypeName>, b: Set<TypeName>): Set<TypeName> => {
      const out = new Set<TypeName>();

      // Handle number/integer specially (integer ⊂ number)
      const aHasNum = a.has("number");
      const bHasNum = b.has("number");
      const aHasInt = a.has("integer");
      const bHasInt = b.has("integer");

      // Intersection(number, integer) => integer
      if ((aHasInt && (bHasInt || bHasNum)) || (bHasInt && (aHasInt || aHasNum))) {
        out.add("integer");
      }

      // Intersection(number, number) => number (but not if either side forces integer only)
      if (aHasNum && bHasNum) {
        out.add("number");
      }

      for (const t of ["null", "boolean", "string", "array", "object"] as const) {
        if (a.has(t) && b.has(t)) out.add(t);
      }

      // If integer is present, number is redundant for our purposes.
      if (out.has("integer")) out.delete("number");

      return out;
    };

    let acc = typeSets[0] ?? new Set<TypeName>();
    for (let i = 1; i < typeSets.length; i++) {
      acc = intersectTwo(acc, typeSets[i]!);
    }

    const u = Array.from(acc);
    if (u.length === 0) return undefined;
    if (u.length === 1) return u[0]!;
    return u;
  }

  return undefined;
}

function isBreakingTypeChange(
  base?: TypeName | TypeName[],
  next?: TypeName | TypeName[],
  baseRequired: boolean = true
): boolean {
  // Diff semantics are *consumer*-oriented: a webhook producer changes its payload, and we want to
  // flag changes that can cause existing consumers (validating/parsing against the base schema) to
  // reject or mis-handle the new payload.
  //
  // Therefore:
  // - If base had a type but next is missing one, treat as breaking (conservative: we can't prove it's safe).
  // - If base had no type info, we don't call a type change breaking.
  // - If next's type set is a SUBSET of base's type set ("narrowing"), it's non-breaking.
  //   (Consumers that accepted the broader base types will still accept the narrowed next type.)
  // - If next's type set introduces any NEW type not present in base ("widening"), it's breaking.
  //   (Consumers that assumed the base type(s) may fail when receiving the new type.)
  //
  // JSON Schema nuance: "integer" is a subset of "number".
  // - base=number, next=integer is *not* breaking (narrowing)
  // - base=integer, next=number *is* breaking (widening)
  if (!base) return false;
  if (!next) return baseRequired;

  const b = new Set(toTypeList(base));
  const n = new Set(toTypeList(next));

  const baseAllows = (t: TypeName) => {
    if (b.has(t)) return true;
    if (t === "integer" && b.has("number")) return true;
    return false;
  };

  // If next has any type not previously allowed, it's breaking.
  for (const nt of n) {
    if (!baseAllows(nt)) return true;
  }

  return false;
}

function stableStringify(value: unknown): string {
  // Deterministic stringify for comparing enum/const values.
  // JSON.stringify depends on object key insertion order; we sort keys recursively.
  const seen = new WeakSet<object>();

  const walk = (v: any): any => {
    if (v === null) return null;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return v;
    if (t === "bigint") return String(v);
    if (t === "undefined") return { __wcci_undefined: true };
    if (t === "function" || t === "symbol") return { __wcci_unserializable: true };

    if (Array.isArray(v)) return v.map(walk);

    if (t === "object") {
      if (seen.has(v)) return { __wcci_cycle: true };
      seen.add(v);

      const out: any = {};
      const keys = Object.keys(v).sort((a, b) => a.localeCompare(b));
      for (const k of keys) out[k] = walk(v[k]);
      return out;
    }

    return v;
  };

  return JSON.stringify(walk(value));
}

function isBreakingConstraintChanges(base: NodeInfo, next: NodeInfo): string[] {
  // Return 0+ short reason strings if this node's constraints represent breaking changes.
  // Rule: widening (less restrictive) compared to base is breaking.

  const reasons: string[] = [];

  // enum widening
  // Note: when `next` is inferred from a single payload sample, it will often use `const`
  // rather than `enum`. Treat base.enum vs next.const as:
  // - non-breaking if next.const is a member of base.enum
  // - breaking if next.const is NOT a member of base.enum
  // - otherwise (no next.enum + no next.const) ignore to avoid noisy false positives.
  if (Array.isArray(base.enum)) {
    if (Array.isArray(next.enum)) {
      const b = new Set(base.enum.map((x) => stableStringify(x)));
      for (const v of next.enum) {
        if (!b.has(stableStringify(v))) {
          reasons.push(`enum widened`);
          break;
        }
      }
    } else if (next.const !== undefined) {
      const b = new Set(base.enum.map((x) => stableStringify(x)));
      if (!b.has(stableStringify(next.const))) {
        reasons.push(`enum widened`);
      }
    }
  }

  // const change / const-vs-enum widening
  // Avoid treating "next missing const" as breaking because inferred schemas can drop const
  // for non-primitive nodes.
  if (base.const !== undefined) {
    if (next.const !== undefined) {
      if (stableStringify(base.const) !== stableStringify(next.const)) reasons.push(`const changed`);
    } else if (Array.isArray(next.enum)) {
      // base.const means the producer always emitted a single value. If next allows more than that
      // single value, the producer may start emitting values consumers can't accept.
      const b = stableStringify(base.const);
      const widened = next.enum.some((v) => stableStringify(v) !== b);
      if (widened) reasons.push(`const widened`);
      // If next.enum is exactly [base.const], it's effectively the same constraint.
    }
  }

  // additionalProperties
  // If base was a "closed" object (no extra fields allowed), and next explicitly opens it up,
  // that is a producer-widening change: the producer can start sending new fields that consumers
  // (validating against the base schema) will reject.
  //
  // IMPORTANT: when `next` is *inferred* from a payload sample, the inference process typically
  // omits `additionalProperties` entirely. Treating `undefined` as "opened" would create noisy
  // false positives for any base schema that uses `additionalProperties:false`.
  if (
    base.additionalProperties === false &&
    (next.additionalProperties === true ||
      (next.additionalProperties !== null && typeof next.additionalProperties === "object"))
  ) {
    reasons.push(`additionalProperties opened`);
  }

  // If base had a schema for additionalProperties (meaning "extra" keys are allowed but must
  // conform to this subschema), and next removes it / switches to `true`, that's a widening.
  // We also walk & diff the subschema itself separately (see indexSchema), but we need this guard
  // to catch the case where it disappears entirely.
  const baseAPIsSchema =
    base.additionalProperties !== undefined &&
    base.additionalProperties !== null &&
    typeof base.additionalProperties === "object";
  const nextAPIsSchema =
    next.additionalProperties !== undefined &&
    next.additionalProperties !== null &&
    typeof next.additionalProperties === "object";

  if (baseAPIsSchema && !nextAPIsSchema) {
    // next.additionalProperties is true/false/undefined
    if (next.additionalProperties === false) {
      // tightening: previously extra keys were allowed (with constraints), now they're forbidden.
      // For producer-change diff, that's not breaking.
    } else if (next.additionalProperties === true) {
      // Explicitly switching to `true` removes the subschema constraint.
      reasons.push(`additionalProperties schema loosened`);
    } else {
      // `undefined` means "unspecified" (common for inferred schemas) — don't treat as breaking.
    }
  }

  type NumBound = { value: number; exclusive: boolean };

  const readLower = (x: NodeInfo): NumBound | undefined => {
    // We only support the numeric forms.
    if (typeof x.exclusiveMinimum === "number") return { value: x.exclusiveMinimum, exclusive: true };
    if (typeof x.minimum === "number") return { value: x.minimum, exclusive: false };
    return undefined;
  };

  const readUpper = (x: NodeInfo): NumBound | undefined => {
    if (typeof x.exclusiveMaximum === "number") return { value: x.exclusiveMaximum, exclusive: true };
    if (typeof x.maximum === "number") return { value: x.maximum, exclusive: false };
    return undefined;
  };

  const boundIsLooser = (baseB: NumBound, nextB: NumBound, kind: "lower" | "upper"): boolean => {
    if (kind === "lower") {
      // Lower bound is looser if it allows smaller numbers, or if it flips exclusive -> inclusive.
      if (nextB.value < baseB.value) return true;
      if (nextB.value > baseB.value) return false;
      return baseB.exclusive && !nextB.exclusive;
    }

    // Upper bound is looser if it allows larger numbers, or if it flips exclusive -> inclusive.
    if (nextB.value > baseB.value) return true;
    if (nextB.value < baseB.value) return false;
    return baseB.exclusive && !nextB.exclusive;
  };

  // Numeric bounds (compare effective interval endpoints across min/exclusiveMin and max/exclusiveMax).
  // NOTE: If next is missing bound info entirely, we ignore it to avoid noisy false positives when
  // next is inferred from a sample payload.
  const bLower = readLower(base);
  const nLower = readLower(next);
  if (bLower && nLower && boundIsLooser(bLower, nLower, "lower")) {
    reasons.push(
      `minimum loosened (${bLower.exclusive ? ">" : ">="}${bLower.value} -> ${nLower.exclusive ? ">" : ">="}${nLower.value})`
    );
  }

  const bUpper = readUpper(base);
  const nUpper = readUpper(next);
  if (bUpper && nUpper && boundIsLooser(bUpper, nUpper, "upper")) {
    reasons.push(
      `maximum loosened (${bUpper.exclusive ? "<" : "<="}${bUpper.value} -> ${nUpper.exclusive ? "<" : "<="}${nUpper.value})`
    );
  }

  // multipleOf
  // Tightening (next multipleOf is a multiple of base) is non-breaking.
  // Any other change can allow values consumers reject => breaking.
  if (typeof base.multipleOf === "number" && typeof next.multipleOf === "number") {
    const b = base.multipleOf;
    const n = next.multipleOf;
    if (n !== b) {
      // next is a tightening only if every number that is a multiple of `n` is also a multiple of `b`
      // i.e., n is a multiple of b.
      const tightening = Number.isFinite(b) && Number.isFinite(n) && n > 0 && b > 0 && n % b === 0;
      if (!tightening) reasons.push(`multipleOf changed (${b} -> ${n})`);
    }
  }

  const cmp = (key: keyof NodeInfo, label: string, kind: "min" | "max") => {
    const b = (base as any)[key];
    if (typeof b !== "number") return;
    const n = (next as any)[key];
    if (typeof n !== "number") {
      // Next schema missing this constraint: ignore to avoid false positives when next is inferred.
      return;
    }
    if (kind === "max" && n > b) reasons.push(`${label} loosened (${b} -> ${n})`);
    if (kind === "min" && n < b) reasons.push(`${label} loosened (${b} -> ${n})`);
  };

  cmp("maxLength", "maxLength", "max");
  cmp("minLength", "minLength", "min");

  // pattern
  // We cannot decide whether one regex is a strict superset of another in general.
  // Treat explicit pattern changes as breaking; ignore missing `next.pattern` to avoid noisy
  // false positives from inferred schemas.
  if (typeof base.pattern === "string" && typeof next.pattern === "string") {
    if (base.pattern !== next.pattern) reasons.push(`pattern changed`);
  }
  cmp("maxItems", "maxItems", "max");
  cmp("minItems", "minItems", "min");
  cmp("maxProperties", "maxProperties", "max");
  cmp("minProperties", "minProperties", "min");

  return reasons;
}

function escapePointerToken(token: string): string {
  // RFC6901-ish
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

const WCCI_ITEMS_TOKEN = "__wcci_items";
const WCCI_TUPLE_ITEMS_TOKEN = "__wcci_tupleItems";
const WCCI_ADDITIONAL_PROPERTIES_TOKEN = "__wcci_additionalProperties";

export function indexSchema(schema: any): Map<string, NodeInfo> {
  const out = new Map<string, NodeInfo>();

  function walk(node: any, pointer: string, required: boolean) {
    if (!node || typeof node !== "object") return;

    const info: NodeInfo = {
      pointer,
      type: extractTypeFromSchemaNode(node),
      required,

      enum: Array.isArray(node.enum) ? node.enum : undefined,
      const: node.const,

      additionalProperties:
        node.type === "object" || (node.properties && typeof node.properties === "object")
          ? (node.additionalProperties as any)
          : undefined,

      minimum: typeof node.minimum === "number" ? node.minimum : undefined,
      exclusiveMinimum: typeof node.exclusiveMinimum === "number" ? node.exclusiveMinimum : undefined,
      maximum: typeof node.maximum === "number" ? node.maximum : undefined,
      exclusiveMaximum: typeof node.exclusiveMaximum === "number" ? node.exclusiveMaximum : undefined,

      multipleOf: typeof node.multipleOf === "number" ? node.multipleOf : undefined,

      minLength: typeof node.minLength === "number" ? node.minLength : undefined,
      maxLength: typeof node.maxLength === "number" ? node.maxLength : undefined,
      pattern: typeof node.pattern === "string" ? node.pattern : undefined,

      minItems: typeof node.minItems === "number" ? node.minItems : undefined,
      maxItems: typeof node.maxItems === "number" ? node.maxItems : undefined,

      minProperties: typeof node.minProperties === "number" ? node.minProperties : undefined,
      maxProperties: typeof node.maxProperties === "number" ? node.maxProperties : undefined,
    };

    // Store even intermediate nodes so we can detect type changes at objects/arrays too.
    out.set(pointer, info);

    const looksLikeObject =
      node.type === "object" || (node.properties && typeof node.properties === "object");
    const looksLikeArray = node.type === "array" || node.items !== undefined;

    if (looksLikeObject) {
      if (node.properties && typeof node.properties === "object") {
        const req = new Set<string>(Array.isArray(node.required) ? node.required : []);
        for (const [k, v] of Object.entries<any>(node.properties)) {
          const childPtr =
            pointer === "/" ? `/${escapePointerToken(k)}` : `${pointer}/${escapePointerToken(k)}`;
          walk(v, childPtr, req.has(k));
        }
      }

      // If additionalProperties is a schema object, index it as a child node so we can detect
      // widen/narrow changes to the allowed shape of "extra" keys.
      if (node.additionalProperties && typeof node.additionalProperties === "object") {
        const apPtr =
          pointer === "/" ? `/${WCCI_ADDITIONAL_PROPERTIES_TOKEN}` : `${pointer}/${WCCI_ADDITIONAL_PROPERTIES_TOKEN}`;
        walk(node.additionalProperties, apPtr, required);
      }
    }

    if (looksLikeArray && node.items) {
      // JSON Schema supports two common shapes:
      // - items: { ... }          (homogeneous array)
      // - items: [{...}, {...}]   (tuple validation)
      //
      // We index both in a way that won't collide with a real object property named "items".
      if (Array.isArray(node.items)) {
        const basePtr =
          pointer === "/" ? `/${WCCI_TUPLE_ITEMS_TOKEN}` : `${pointer}/${WCCI_TUPLE_ITEMS_TOKEN}`;
        for (let i = 0; i < node.items.length; i++) {
          const childPtr = `${basePtr}/${i}`;
          walk(node.items[i], childPtr, required);
        }
      } else {
        const childPtr = pointer === "/" ? `/${WCCI_ITEMS_TOKEN}` : `${pointer}/${WCCI_ITEMS_TOKEN}`;
        walk(node.items, childPtr, required);
      }
    }
  }

  walk(schema, "/", true);
  return out;
}

export function summarizeDiff(baseSchema: any, nextSchema: any) {
  const baseIdx = indexSchema(baseSchema);
  const nextIdx = indexSchema(nextSchema);

  const displayPointer = (ptr: string) => {
    if (ptr === "/") return "/";

    const tokens = ptr.split("/").slice(1);
    const outTokens: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;

      if (t === WCCI_ITEMS_TOKEN) {
        outTokens.push("*");
        continue;
      }

      if (t === WCCI_ADDITIONAL_PROPERTIES_TOKEN) {
        outTokens.push("{additionalProperties}");
        continue;
      }

      if (t === WCCI_TUPLE_ITEMS_TOKEN) {
        const next = tokens[i + 1];
        if (next !== undefined && /^\d+$/.test(next)) {
          outTokens.push(`[${next}]`);
          i++; // consume index
          continue;
        }
        // Fallback for weird schemas: treat as wildcard tuple.
        outTokens.push("[*]");
        continue;
      }

      outTokens.push(t);
    }

    return "/" + outTokens.join("/");
  };

  const added: string[] = [];
  const removedRequired: string[] = [];
  const removedOptional: string[] = [];
  const requiredBecameOptional: string[] = [];
  const typeChanged: string[] = [];
  const constraintsChanged: string[] = [];

  const lastTokenOf = (p: string) => (p === "/" ? "" : p.slice(p.lastIndexOf("/") + 1));
  const parentPtrOf = (p: string) => {
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
  };
  const isPropertyPointer = (p: string) => {
    const t = lastTokenOf(p);
    const parent = lastTokenOf(parentPtrOf(p));

    // Synthetic nodes we add for schema-indexing.
    if (t === WCCI_ITEMS_TOKEN) return false;
    if (t === WCCI_TUPLE_ITEMS_TOKEN) return false;
    if (t === WCCI_ADDITIONAL_PROPERTIES_TOKEN) return false;

    // Tuple item indices (e.g. /arr/__wcci_tupleItems/0) are not payload properties.
    if (parent === WCCI_TUPLE_ITEMS_TOKEN) return false;

    return true;
  };

  const isAdditionalPropertiesSchemaPointer = (p: string) => lastTokenOf(p) === WCCI_ADDITIONAL_PROPERTIES_TOKEN;

  for (const [ptr, b] of baseIdx.entries()) {
    const n = nextIdx.get(ptr);
    if (!n) {
      if (b.required) {
        removedRequired.push(displayPointer(ptr));
      } else {
        // Optional removals are ambiguous when `next` is inferred from a single payload sample:
        // the producer might still send the optional key in other events.
        //
        // We only report "removed optional" when the *next* parent object is explicitly closed
        // (`additionalProperties:false`), meaning the key is no longer allowed.
        if (isPropertyPointer(ptr)) {
          const parentPtr = parentPtrOf(ptr);
          const nextParent = nextIdx.get(parentPtr);
          if (nextParent?.type === "object" && nextParent.additionalProperties === false) {
            removedOptional.push(displayPointer(ptr));
          }
        }
      }
      continue;
    }

    if (b.required && !n.required) {
      requiredBecameOptional.push(displayPointer(ptr));
    }

    if (isBreakingTypeChange(b.type, n.type, b.required)) {
      typeChanged.push(
        `${displayPointer(ptr)} (${JSON.stringify(b.type)} -> ${JSON.stringify(n.type)})`
      );
    }

    const cs = isBreakingConstraintChanges(b, n);
    for (const c of cs) constraintsChanged.push(`${displayPointer(ptr)} (${c})`);
  }

  for (const [ptr] of nextIdx.entries()) {
    if (baseIdx.has(ptr)) continue;

    // If the "path" is the synthetic child that represents an additionalProperties *subschema*,
    // don't report it as a newly added path. It's a constraint node, not a payload field.
    if (isAdditionalPropertiesSchemaPointer(ptr)) continue;

    // If the base schema declares an object as "closed" (additionalProperties:false), then adding a
    // new property under that object is breaking: a consumer validating against the base schema
    // will reject payloads containing the new property.
    const parentPtr = parentPtrOf(ptr);
    const parentBase = baseIdx.get(parentPtr);

    const isPropPtr = isPropertyPointer(ptr);

    if (
      isPropPtr &&
      parentBase?.type === "object" &&
      parentBase.additionalProperties === false
    ) {
      constraintsChanged.push(
        `${displayPointer(ptr)} (added under closed object ${displayPointer(parentPtr)})`
      );
      continue;
    }

    // If base allows additionalProperties but constrains them with a subschema, then adding a new
    // property key is only safe if the *value type* is compatible with that subschema.
    //
    // We intentionally keep this check type-only:
    // - the inferred schema for the new key is derived from a single sample, and will not contain
    //   many constraints (maxLength, patterns, etc.), so comparing constraints would be noisy.
    // - a type incompatibility is a strong signal that the sample would fail validation under the
    //   base schema's additionalProperties subschema.
    const parentAPIsSchema =
      isPropPtr &&
      parentBase?.type === "object" &&
      parentBase.additionalProperties !== undefined &&
      parentBase.additionalProperties !== null &&
      typeof parentBase.additionalProperties === "object";

    if (parentAPIsSchema) {
      const apPtr =
        parentPtr === "/" ? `/${WCCI_ADDITIONAL_PROPERTIES_TOKEN}` : `${parentPtr}/${WCCI_ADDITIONAL_PROPERTIES_TOKEN}`;
      const baseAp = baseIdx.get(apPtr);
      const nextChild = nextIdx.get(ptr);

      if (baseAp && nextChild && isBreakingTypeChange(baseAp.type, nextChild.type, true)) {
        constraintsChanged.push(
          `${displayPointer(ptr)} (added key violates additionalProperties schema at ${displayPointer(
            parentPtr
          )}: ${JSON.stringify(baseAp.type)} -> ${JSON.stringify(nextChild.type)})`
        );
        continue;
      }
    }

    added.push(displayPointer(ptr));
  }

  // Determinism: always return lists in a stable order so CI output doesn't flap.
  // We sort by pointer, and for typeChanged we sort by the pointer prefix.
  const byPointer = (a: string, b: string) => a.localeCompare(b);
  const typeChangedByPointer = (a: string, b: string) => a.split(" ", 1)[0]!.localeCompare(b.split(" ", 1)[0]!);

  added.sort(byPointer);
  removedRequired.sort(byPointer);
  removedOptional.sort(byPointer);
  requiredBecameOptional.sort(byPointer);
  typeChanged.sort(typeChangedByPointer);
  constraintsChanged.sort(typeChangedByPointer);

  const breaking = {
    removedRequired,
    requiredBecameOptional,
    typeChanged,
    constraintsChanged,
  };

  const nonBreaking = {
    added,
    removedOptional,
  };

  const breakingCount =
    breaking.removedRequired.length +
    breaking.requiredBecameOptional.length +
    breaking.typeChanged.length +
    breaking.constraintsChanged.length;

  return {
    breaking,
    nonBreaking,
    breakingCount,
  };
}

export function validateAgainstSchema(schema: any, payload: any) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema as any);
  const ok = validate(payload);
  return { ok: Boolean(ok), errors: validate.errors };
}
