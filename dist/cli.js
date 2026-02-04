#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import schemaDiff from "json-schema-diff";
import { formatAjvErrors, inferSchemaFromPayload, normalizeToJsonSchema, summarizeDiff, validateAgainstSchema, } from "./lib.js";
function usage(code = 2) {
    const out = code === 0 ? console.log : console.error;
    out(`wcci - webhook contract CI\n\nUsage:\n  wcci infer --in <payload.json> --out <schema.json>\n  wcci check --schema <schema.json> --in <payload.json> [--json]\n  wcci diff --base <schema.json> (--next <payload.json> | --next-schema <schema.json>) [--show-nonbreaking] [--json]\n\nOptions:\n  -h, --help              Show help\n  --show-nonbreaking      Also print non-breaking adds/removals (diff mode)\n  --json                  Print machine-readable JSON output\n  --debug-schema-diff     Print json-schema-diff output (diff mode)\n\nExit codes:\n  0  success / no breaking changes\n  1  breaking changes (diff) or validation failure (check)\n  2  usage / input error\n`);
    process.exit(code);
}
function argValue(flag) {
    const i = process.argv.indexOf(flag);
    if (i === -1)
        return undefined;
    return process.argv[i + 1];
}
function argFlag(flag) {
    return process.argv.includes(flag);
}
function readJson(file) {
    try {
        const text = fs.readFileSync(file, "utf8");
        try {
            return JSON.parse(text);
        }
        catch (e) {
            console.error(`invalid JSON in ${file}: ${e?.message ?? String(e)}`);
            process.exit(2);
        }
    }
    catch (e) {
        if (e?.code === "ENOENT") {
            console.error(`file not found: ${file}`);
            process.exit(2);
        }
        console.error(`failed to read ${file}: ${e?.message ?? String(e)}`);
        process.exit(2);
    }
}
function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
async function main() {
    if (process.argv.includes("-h") || process.argv.includes("--help"))
        usage(0);
    const cmd = process.argv[2];
    if (!cmd || (cmd !== "infer" && cmd !== "check" && cmd !== "diff"))
        usage(2);
    if (cmd === "infer") {
        const inFile = argValue("--in");
        const outFile = argValue("--out");
        if (!inFile || !outFile)
            usage(2);
        const payload = readJson(inFile);
        const schema = inferSchemaFromPayload(payload);
        writeJson(outFile, schema);
        console.log(`wrote schema -> ${outFile}`);
        return;
    }
    if (cmd === "check") {
        const schemaFile = argValue("--schema");
        const inFile = argValue("--in");
        if (!schemaFile || !inFile)
            usage(2);
        const schema = normalizeToJsonSchema(readJson(schemaFile));
        const payload = readJson(inFile);
        const { ok, errors } = validateAgainstSchema(schema, payload);
        if (argFlag("--json")) {
            const out = {
                ok: Boolean(ok),
                errors: errors ?? [],
                formattedErrors: ok ? "" : formatAjvErrors(errors),
            };
            console.log(JSON.stringify(out, null, 2));
            if (!ok)
                process.exit(1);
            return;
        }
        if (ok) {
            console.log("ok");
            return;
        }
        console.error("payload does not match schema:\n" + formatAjvErrors(errors));
        process.exit(1);
    }
    if (cmd === "diff") {
        const baseFile = argValue("--base");
        const nextPayloadFile = argValue("--next");
        const nextSchemaFile = argValue("--next-schema");
        if (!baseFile)
            usage(2);
        if ((nextPayloadFile ? 1 : 0) + (nextSchemaFile ? 1 : 0) !== 1)
            usage(2);
        const baseSchema = normalizeToJsonSchema(readJson(baseFile));
        // diff semantics:
        // - default: take a next *payload sample*, infer its schema, and compare.
        // - optionally: compare against an explicit next schema.
        const nextSchema = nextSchemaFile
            ? normalizeToJsonSchema(readJson(nextSchemaFile))
            : inferSchemaFromPayload(readJson(nextPayloadFile));
        const { breaking, nonBreaking, breakingCount } = summarizeDiff(baseSchema, nextSchema);
        // Optional: keep json-schema-diff output available for debugging.
        if (argFlag("--debug-schema-diff")) {
            const res = await schemaDiff.diffSchemas({
                sourceSchema: baseSchema,
                destinationSchema: nextSchema,
            });
            console.log(JSON.stringify(res, null, 2));
        }
        if (argFlag("--json")) {
            // Convenience: include flattened path lists for consumers that don't want to
            // inspect each category.
            const splitDetail = (entry) => {
                // Our human-readable entries are either:
                // - "/path"
                // - "/path (details...)"
                // - "/path (old -> new)"
                //
                // Keep this parsing strict + deterministic for downstream machine consumers.
                const m = entry.match(/^(.*) \((.*)\)$/);
                if (!m)
                    return { pointer: entry };
                return { pointer: m[1], detail: m[2] };
            };
            const breakingPathsRaw = [
                ...breaking.removedRequired.map((p) => ({ kind: "removedRequired", pointer: p })),
                ...breaking.requiredBecameOptional.map((p) => ({ kind: "requiredBecameOptional", pointer: p })),
                ...breaking.typeChanged.map((p) => ({ kind: "typeChanged", ...splitDetail(p) })),
                ...breaking.constraintsChanged.map((p) => ({ kind: "constraintsChanged", ...splitDetail(p) })),
            ];
            // Determinism for machine consumers: provide stable ordering across kinds.
            // (The category lists are individually sorted, but concatenation is not.)
            const byPointerThenKind = (a, b) => {
                const ap = String(a.pointer ?? "");
                const bp = String(b.pointer ?? "");
                if (ap !== bp)
                    return ap.localeCompare(bp);
                const ak = String(a.kind ?? "");
                const bk = String(b.kind ?? "");
                if (ak !== bk)
                    return ak.localeCompare(bk);
                const ad = String(a.detail ?? "");
                const bd = String(b.detail ?? "");
                return ad.localeCompare(bd);
            };
            const breakingPaths = breakingPathsRaw.slice().sort(byPointerThenKind);
            const nonBreakingPaths = argFlag("--show-nonbreaking")
                ? [
                    ...nonBreaking.added.map((p) => ({ kind: "added", pointer: p })),
                    ...nonBreaking.removedOptional.map((p) => ({ kind: "removedOptional", pointer: p })),
                ].sort(byPointerThenKind)
                : undefined;
            const out = {
                ok: breakingCount === 0,
                breakingCount,
                breaking,
                nonBreaking: argFlag("--show-nonbreaking") ? nonBreaking : undefined,
                breakingPaths,
                nonBreakingPaths,
            };
            console.log(JSON.stringify(out, null, 2));
            if (breakingCount > 0)
                process.exit(1);
            return;
        }
        const printList = (title, items) => {
            if (items.length === 0)
                return;
            console.log(`${title}:`);
            for (const x of items)
                console.log(`- ${x}`);
        };
        if (breakingCount > 0) {
            console.error("breaking webhook payload changes detected:");
            // use stderr for breaking lists
            const eprintList = (title, items) => {
                if (items.length === 0)
                    return;
                console.error(`${title}:`);
                for (const x of items)
                    console.error(`- ${x}`);
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
//# sourceMappingURL=cli.js.map