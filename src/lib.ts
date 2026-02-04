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

    for (const [k, v] of Object.entries<any>(out.properties)) {
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
      out.required = Array.from(merged);
    } else if (booleanRequired) {
      // interpret "required: true" as "all object properties are required"
      out.required = Object.keys(newProps);
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
  if (!base) return false;
  if (!next) return true;

  const b = new Set(toTypeList(base));
  const n = new Set(toTypeList(next));

  // If next has any type not previously allowed, it's breaking.
  for (const nt of n) {
    if (!b.has(nt)) return true;
  }

  return false;
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
  }

  for (const [ptr] of nextIdx.entries()) {
    if (!baseIdx.has(ptr)) added.push(ptr);
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

  const breaking = {
    removedRequired,
    requiredBecameOptional,
    typeChanged,
  };

  const nonBreaking = {
    added,
    removedOptional,
  };

  const breakingCount =
    breaking.removedRequired.length + breaking.requiredBecameOptional.length + breaking.typeChanged.length;

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
