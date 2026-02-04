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

  minLength?: number;
  maxLength?: number;
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

function isBreakingTypeChange(base?: TypeName | TypeName[], next?: TypeName | TypeName[]): boolean {
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
  if (!next) return true;

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

function isBreakingConstraintChange(base: NodeInfo, next: NodeInfo): string | null {
  // Return a short reason string if this node's constraints represent a breaking change.
  // Rule: widening (less restrictive) compared to base is breaking.

  // enum widening/removal
  if (Array.isArray(base.enum)) {
    if (!Array.isArray(next.enum)) return `enum removed`;
    const b = new Set(base.enum.map((x) => stableStringify(x)));
    for (const v of next.enum) {
      if (!b.has(stableStringify(v))) return `enum widened`;
    }
  }

  // const removal/change
  if (base.const !== undefined) {
    if (next.const === undefined) return `const removed`;
    if (stableStringify(base.const) !== stableStringify(next.const)) return `const changed`;
  }

  // additionalProperties
  // If base was a "closed" object (no extra fields allowed), and next opens it up, that is a
  // producer-widening change: the producer can start sending new fields that consumers (validating
  // against the base schema) will reject.
  if (base.additionalProperties === false && next.additionalProperties !== false) {
    return `additionalProperties opened`;
  }

  const cmpNum = (
    key: "minimum" | "exclusiveMinimum" | "maximum" | "exclusiveMaximum",
    kind: "min" | "max"
  ) => {
    const b = (base as any)[key];
    if (typeof b !== "number") return null;
    const n = (next as any)[key];
    if (typeof n !== "number") return `${key} removed`;
    if (kind === "max" && n > b) return `${key} loosened (${b} -> ${n})`;
    if (kind === "min" && n < b) return `${key} loosened (${b} -> ${n})`;
    return null;
  };

  // Numeric bounds
  return (
    cmpNum("maximum", "max") ||
    cmpNum("exclusiveMaximum", "max") ||
    cmpNum("minimum", "min") ||
    cmpNum("exclusiveMinimum", "min") ||
    (() => {
      const b = base.maxLength;
      if (typeof b !== "number") return null;
      const n = next.maxLength;
      if (typeof n !== "number") return `maxLength removed`;
      if (n > b) return `maxLength loosened (${b} -> ${n})`;
      return null;
    })() ||
    (() => {
      const b = base.minLength;
      if (typeof b !== "number") return null;
      const n = next.minLength;
      if (typeof n !== "number") return `minLength removed`;
      if (n < b) return `minLength loosened (${b} -> ${n})`;
      return null;
    })()
  );
}

function escapePointerToken(token: string): string {
  // RFC6901-ish
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function indexSchema(schema: any): Map<string, NodeInfo> {
  const out = new Map<string, NodeInfo>();

  function walk(node: any, pointer: string, required: boolean) {
    if (!node || typeof node !== "object") return;

    const info: NodeInfo = {
      pointer,
      type: node.type,
      required,

      enum: Array.isArray(node.enum) ? node.enum : undefined,
      const: node.const,

      additionalProperties:
        node.type === "object" ? (node.additionalProperties as any) : undefined,

      minimum: typeof node.minimum === "number" ? node.minimum : undefined,
      exclusiveMinimum: typeof node.exclusiveMinimum === "number" ? node.exclusiveMinimum : undefined,
      maximum: typeof node.maximum === "number" ? node.maximum : undefined,
      exclusiveMaximum: typeof node.exclusiveMaximum === "number" ? node.exclusiveMaximum : undefined,

      minLength: typeof node.minLength === "number" ? node.minLength : undefined,
      maxLength: typeof node.maxLength === "number" ? node.maxLength : undefined,
    };

    // Store even intermediate nodes so we can detect type changes at objects/arrays too.
    out.set(pointer, info);

    if (node.type === "object" && node.properties && typeof node.properties === "object") {
      const req = new Set<string>(Array.isArray(node.required) ? node.required : []);
      for (const [k, v] of Object.entries<any>(node.properties)) {
        const childPtr = pointer === "/" ? `/${escapePointerToken(k)}` : `${pointer}/${escapePointerToken(k)}`;
        walk(v, childPtr, req.has(k));
      }
    }

    if (node.type === "array" && node.items) {
      // Use a stable token to represent the "element" schema.
      const childPtr = pointer === "/" ? "/items" : `${pointer}/items`;
      walk(node.items, childPtr, required);
    }
  }

  walk(schema, "/", true);
  return out;
}

export function summarizeDiff(baseSchema: any, nextSchema: any) {
  const baseIdx = indexSchema(baseSchema);
  const nextIdx = indexSchema(nextSchema);

  const added: string[] = [];
  const removedRequired: string[] = [];
  const removedOptional: string[] = [];
  const requiredBecameOptional: string[] = [];
  const typeChanged: string[] = [];
  const constraintsChanged: string[] = [];

  for (const [ptr, b] of baseIdx.entries()) {
    const n = nextIdx.get(ptr);
    if (!n) {
      if (b.required) removedRequired.push(ptr);
      else removedOptional.push(ptr);
      continue;
    }

    if (b.required && !n.required) {
      requiredBecameOptional.push(ptr);
    }

    if (isBreakingTypeChange(b.type, n.type)) {
      typeChanged.push(`${ptr} (${JSON.stringify(b.type)} -> ${JSON.stringify(n.type)})`);
    }

    const c = isBreakingConstraintChange(b, n);
    if (c) constraintsChanged.push(`${ptr} (${c})`);
  }

  for (const [ptr] of nextIdx.entries()) {
    if (baseIdx.has(ptr)) continue;

    // If the base schema declares an object as "closed" (additionalProperties:false), then adding a
    // new property under that object is breaking: a consumer validating against the base schema
    // will reject payloads containing the new property.
    const lastSlash = ptr.lastIndexOf("/");
    const parentPtr = lastSlash <= 0 ? "/" : ptr.slice(0, lastSlash);
    const parentBase = baseIdx.get(parentPtr);

    const isPropertyPointer = !ptr.includes("/items") && ptr !== "/items";

    if (isPropertyPointer && parentBase?.type === "object" && parentBase.additionalProperties === false) {
      constraintsChanged.push(`${ptr} (added under closed object ${parentPtr})`);
      continue;
    }

    added.push(ptr);
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
