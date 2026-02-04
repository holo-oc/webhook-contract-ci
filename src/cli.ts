#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import Ajv, { type ErrorObject } from "ajv";
import toJsonSchema from "to-json-schema";
import schemaDiff from "json-schema-diff";

type Cmd = "infer" | "check" | "diff";

type TypeName =
  | "null"
  | "boolean"
  | "number"
  | "integer"
  | "string"
  | "array"
  | "object";

type NodeInfo = {
  pointer: string; // JSON pointer-ish ("/a/b")
  type?: TypeName | TypeName[];
  required: boolean;
};

function usage(): never {
  console.error(
    `wcci - webhook contract CI (WIP)\n\nCommands:\n  infer --in <payload.json> --out <schema.json>\n  check --schema <schema.json> --in <payload.json>\n  diff --base <schema.json> --next <payload.json>\n\nNotes:\n  - diff infers a schema from --next payload and compares it to --base.\n  - exits 1 if breaking changes are detected.\n`
  );
  process.exit(2);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

function argFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function readJson(file: string): unknown {
  const text = fs.readFileSync(file, "utf8");
  return JSON.parse(text);
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
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
function normalizeToJsonSchema(input: any): any {
  if (!input || typeof input !== "object") return input;

  if (Array.isArray(input)) return input.map(normalizeToJsonSchema);

  const out: any = { ...input };
  const booleanRequired = out.required === true;

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
      out.required = requiredKeys;
    } else if (booleanRequired) {
      // interpret "required: true" as "all object properties are required"
      out.required = Object.keys(newProps);
    } else {
      delete out.required;
    }
  }

  // root-level `required: true` (boolean) is not meaningful in JSON Schema.
  if (out.required === true) delete out.required;

  return out;
}

function inferSchemaFromPayload(payload: unknown): any {
  const rawSchema = toJsonSchema(payload, { required: true, arrays: { mode: "all" } });
  return normalizeToJsonSchema(rawSchema);
}

function toTypeList(t: any): TypeName[] | undefined {
  if (!t) return undefined;
  if (typeof t === "string") return [t as TypeName];
  if (Array.isArray(t)) return t as TypeName[];
  return undefined;
}

function typeCompatible(base?: TypeName | TypeName[], next?: TypeName | TypeName[]): boolean {
  // If either side doesn't specify a type, we can't confidently call it breaking.
  if (!base || !next) return true;
  const b = new Set(toTypeList(base));
  const n = new Set(toTypeList(next));

  // compatible if intersection is non-empty
  for (const bt of b) {
    if (n.has(bt)) return true;
  }
  return false;
}

function escapePointerToken(token: string): string {
  // RFC6901-ish
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function indexSchema(schema: any): Map<string, NodeInfo> {
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

function summarizeDiff(baseSchema: any, nextSchema: any) {
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

    if (!typeCompatible(b.type, n.type)) {
      typeChanged.push(`${ptr} (${JSON.stringify(b.type)} -> ${JSON.stringify(n.type)})`);
    }
  }

  for (const [ptr] of nextIdx.entries()) {
    if (!baseIdx.has(ptr)) added.push(ptr);
  }

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

async function main() {
  const cmd = process.argv[2] as Cmd | undefined;
  if (!cmd || (cmd !== "infer" && cmd !== "check" && cmd !== "diff")) usage();

  if (cmd === "infer") {
    const inFile = argValue("--in");
    const outFile = argValue("--out");
    if (!inFile || !outFile) usage();

    const payload = readJson(inFile);
    const schema = inferSchemaFromPayload(payload);

    writeJson(outFile, schema);
    console.log(`wrote schema -> ${outFile}`);
    return;
  }

  if (cmd === "check") {
    const schemaFile = argValue("--schema");
    const inFile = argValue("--in");
    if (!schemaFile || !inFile) usage();

    const schema = normalizeToJsonSchema(readJson(schemaFile));
    const payload = readJson(inFile);

    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema as any);
    const ok = validate(payload);

    if (ok) {
      console.log("ok");
      return;
    }

    console.error("payload does not match schema:\n" + formatAjvErrors(validate.errors));
    process.exit(1);
  }

  if (cmd === "diff") {
    const baseFile = argValue("--base");
    const nextFile = argValue("--next");
    if (!baseFile || !nextFile) usage();

    const baseSchema = normalizeToJsonSchema(readJson(baseFile));

    // diff semantics: take a next *payload sample*, infer its schema, and compare.
    const nextPayload = readJson(nextFile);
    const nextSchema = inferSchemaFromPayload(nextPayload);

    const { breaking, nonBreaking, breakingCount } = summarizeDiff(baseSchema, nextSchema);

    // Optional: keep json-schema-diff output available for debugging.
    if (argFlag("--debug-schema-diff")) {
      const res: any = await schemaDiff.diffSchemas({
        sourceSchema: baseSchema,
        destinationSchema: nextSchema,
      });
      console.log(JSON.stringify(res, null, 2));
    }

    const printList = (title: string, items: string[]) => {
      if (items.length === 0) return;
      console.log(`${title}:`);
      for (const x of items) console.log(`- ${x}`);
    };

    if (breakingCount > 0) {
      console.error("breaking webhook payload changes detected:");
      // use stderr for breaking lists
      const eprintList = (title: string, items: string[]) => {
        if (items.length === 0) return;
        console.error(`${title}:`);
        for (const x of items) console.error(`- ${x}`);
      };
      eprintList("removed required paths", breaking.removedRequired);
      eprintList("required became optional", breaking.requiredBecameOptional);
      eprintList("type changed", breaking.typeChanged);

      if (argFlag("--show-nonbreaking")) {
        printList("added paths", nonBreaking.added);
        printList("removed optional paths", nonBreaking.removedOptional);
      }

      process.exit(1);
    }

    console.log("no breaking changes detected");
    if (argFlag("--show-nonbreaking")) {
      printList("added paths", nonBreaking.added);
      printList("removed optional paths", nonBreaking.removedOptional);
    }
    return;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
