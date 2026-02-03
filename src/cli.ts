#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import Ajv, { type ErrorObject } from "ajv";
import toJsonSchema from "to-json-schema";
import schemaDiff from "json-schema-diff";

type Cmd = "infer" | "check" | "diff";

function usage(): never {
  console.error(`wcci - webhook contract CI (WIP)\n\nCommands:\n  infer --in <payload.json> --out <schema.json>\n  check --schema <schema.json> --in <payload.json>\n  diff --base <schema.json> --next <schema.json>\n`);
  process.exit(2);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  return process.argv[i + 1];
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

async function main() {
  const cmd = process.argv[2] as Cmd | undefined;
  if (!cmd || (cmd !== "infer" && cmd !== "check" && cmd !== "diff")) usage();

  if (cmd === "infer") {
    const inFile = argValue("--in");
    const outFile = argValue("--out");
    if (!inFile || !outFile) usage();

    const payload = readJson(inFile);
    // NOTE: this is intentionally simple for the MVP scaffold.
    // We'll improve schema quality after evaluating more inferrers.
    const rawSchema = toJsonSchema(payload, { required: true, arrays: { mode: "all" } });
    const schema = normalizeToJsonSchema(rawSchema);

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

    const base = normalizeToJsonSchema(readJson(baseFile));
    const next = normalizeToJsonSchema(readJson(nextFile));

    // json-schema-diff returns `{ added, removed }` and will treat removals as breaking.
    const res: any = await schemaDiff.diffSchemas({
      sourceSchema: base,
      destinationSchema: next,
    });

    const removalsFound = Boolean(res?.removalsFound);
    const additionsFound = Boolean(res?.additionsFound);

    if (removalsFound) {
      console.error("breaking schema changes detected (removalsFound=true)");
      if (res?.removedJsonSchema) {
        console.error(JSON.stringify(res.removedJsonSchema, null, 2));
      }
      process.exit(1);
    }

    console.log("no breaking removals detected");
    if (additionsFound && res?.addedJsonSchema) {
      console.log("additions detected:");
      console.log(JSON.stringify(res.addedJsonSchema, null, 2));
    }
    return;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
