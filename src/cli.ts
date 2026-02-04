#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import schemaDiff from "json-schema-diff";

import {
  formatAjvErrors,
  inferSchemaFromPayload,
  normalizeToJsonSchema,
  summarizeDiff,
  validateAgainstSchema,
} from "./lib.js";

type Cmd = "infer" | "check" | "diff";

type ExitCode = 0 | 1 | 2;

function usage(code: ExitCode = 2): never {
  const out = code === 0 ? console.log : console.error;
  out(
    `wcci - webhook contract CI\n\nUsage:\n  wcci infer --in <payload.json> --out <schema.json>\n  wcci check --schema <schema.json> --in <payload.json>\n  wcci diff --base <schema.json> --next <payload.json> [--show-nonbreaking]\n\nOptions:\n  -h, --help              Show help\n  --show-nonbreaking      Also print non-breaking adds/removals (diff mode)\n  --debug-schema-diff     Print json-schema-diff output (diff mode)\n\nExit codes:\n  0  success / no breaking changes\n  1  breaking changes (diff) or validation failure (check)\n  2  usage / input error\n`
  );
  process.exit(code);
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
  try {
    const text = fs.readFileSync(file, "utf8");
    try {
      return JSON.parse(text);
    } catch (e: any) {
      console.error(`invalid JSON in ${file}: ${e?.message ?? String(e)}`);
      process.exit(2);
    }
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      console.error(`file not found: ${file}`);
      process.exit(2);
    }
    console.error(`failed to read ${file}: ${e?.message ?? String(e)}`);
    process.exit(2);
  }
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

async function main() {
  if (process.argv.includes("-h") || process.argv.includes("--help")) usage(0);

  const cmd = process.argv[2] as Cmd | undefined;
  if (!cmd || (cmd !== "infer" && cmd !== "check" && cmd !== "diff")) usage(2);

  if (cmd === "infer") {
    const inFile = argValue("--in");
    const outFile = argValue("--out");
    if (!inFile || !outFile) usage(2);

    const payload = readJson(inFile);
    const schema = inferSchemaFromPayload(payload);

    writeJson(outFile, schema);
    console.log(`wrote schema -> ${outFile}`);
    return;
  }

  if (cmd === "check") {
    const schemaFile = argValue("--schema");
    const inFile = argValue("--in");
    if (!schemaFile || !inFile) usage(2);

    const schema = normalizeToJsonSchema(readJson(schemaFile));
    const payload = readJson(inFile);

    const { ok, errors } = validateAgainstSchema(schema, payload);
    if (ok) {
      console.log("ok");
      return;
    }

    console.error("payload does not match schema:\n" + formatAjvErrors(errors));
    process.exit(1);
  }

  if (cmd === "diff") {
    const baseFile = argValue("--base");
    const nextFile = argValue("--next");
    if (!baseFile || !nextFile) usage(2);

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
      eprintList("constraints changed", breaking.constraintsChanged);

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
