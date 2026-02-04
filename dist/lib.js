import Ajv from "ajv";
import toJsonSchema from "to-json-schema";
export function formatAjvErrors(errors) {
    if (!errors || errors.length === 0)
        return "";
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
export function normalizeToJsonSchema(input) {
    if (!input || typeof input !== "object")
        return input;
    if (Array.isArray(input))
        return input.map(normalizeToJsonSchema);
    const out = { ...input };
    const booleanRequired = out.required === true;
    const explicitRequired = Array.isArray(out.required) ? out.required : undefined;
    if (out.type === "object" && out.properties && typeof out.properties === "object") {
        const requiredKeys = [];
        const newProps = {};
        // Determinism: sort property keys so inferred/normalized schemas don't depend on
        // JSON insertion order (which can vary across payload samples).
        const keys = Object.keys(out.properties).sort((a, b) => a.localeCompare(b));
        for (const k of keys) {
            const v = out.properties[k];
            const vv = normalizeToJsonSchema(v);
            if (vv && typeof vv === "object" && vv.required === true) {
                requiredKeys.push(k);
                const { required, ...rest } = vv;
                newProps[k] = rest;
            }
            else {
                newProps[k] = vv;
            }
        }
        out.properties = newProps;
        if (requiredKeys.length > 0) {
            // If the input already uses standard JSON Schema `required: string[]`, keep it and
            // merge in any `required: true` property hints.
            const merged = new Set([...(explicitRequired ?? []), ...requiredKeys]);
            out.required = Array.from(merged).sort((a, b) => a.localeCompare(b));
        }
        else if (booleanRequired) {
            // interpret "required: true" as "all object properties are required"
            out.required = Object.keys(newProps).sort((a, b) => a.localeCompare(b));
        }
        else if (explicitRequired) {
            out.required = explicitRequired;
        }
        else {
            delete out.required;
        }
    }
    // root-level `required: true` (boolean) is not meaningful in JSON Schema.
    if (out.required === true)
        delete out.required;
    return out;
}
export function inferSchemaFromPayload(payload) {
    const rawSchema = toJsonSchema(payload, { required: true, arrays: { mode: "all" } });
    return normalizeToJsonSchema(rawSchema);
}
function toTypeList(t) {
    if (!t)
        return undefined;
    if (typeof t === "string")
        return [t];
    if (Array.isArray(t))
        return t;
    return undefined;
}
function uniqTypes(types) {
    const out = [];
    const seen = new Set();
    for (const t of types) {
        if (!t)
            continue;
        if (seen.has(t))
            continue;
        seen.add(t);
        out.push(t);
    }
    return out;
}
function extractTypeFromSchemaNode(node) {
    if (!node || typeof node !== "object")
        return undefined;
    // Standard JSON Schema
    if (node.type) {
        // OpenAPI-style nullable: true
        if (node.nullable === true) {
            const ts = toTypeList(node.type) ?? [];
            if (!ts.includes("null"))
                return [...ts, "null"];
        }
        return node.type;
    }
    // OpenAPI nullable without explicit type is too ambiguous.
    // anyOf/oneOf: union the member types (best-effort)
    const branches = Array.isArray(node.anyOf)
        ? node.anyOf
        : Array.isArray(node.oneOf)
            ? node.oneOf
            : undefined;
    if (branches) {
        const collected = [];
        for (const b of branches) {
            const t = extractTypeFromSchemaNode(b);
            const list = toTypeList(t);
            if (list)
                collected.push(...list);
        }
        const u = uniqTypes(collected);
        if (u.length === 0)
            return undefined;
        if (u.length === 1)
            return u[0];
        return u;
    }
    // allOf: intersection.
    // We avoid full semantic evaluation, but we *can* extract a safe type signal when every branch
    // provides type information.
    if (Array.isArray(node.allOf)) {
        const branchesAllOf = node.allOf;
        const typeSets = [];
        for (const b of branchesAllOf) {
            const t = extractTypeFromSchemaNode(b);
            const list = toTypeList(t);
            // It's common to use allOf to attach constraints (minLength, patterns, etc.) without repeating
            // `type`. If a branch doesn't provide type info, ignore it for type extraction.
            if (!list)
                continue;
            const s = new Set(list);
            // In unions, "integer" is a subset of "number"; treat ["number","integer"] as just "number".
            if (s.has("number"))
                s.delete("integer");
            typeSets.push(s);
        }
        if (typeSets.length === 0)
            return undefined;
        const intersectTwo = (a, b) => {
            const out = new Set();
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
            for (const t of ["null", "boolean", "string", "array", "object"]) {
                if (a.has(t) && b.has(t))
                    out.add(t);
            }
            // If integer is present, number is redundant for our purposes.
            if (out.has("integer"))
                out.delete("number");
            return out;
        };
        let acc = typeSets[0] ?? new Set();
        for (let i = 1; i < typeSets.length; i++) {
            acc = intersectTwo(acc, typeSets[i]);
        }
        const u = Array.from(acc);
        if (u.length === 0)
            return undefined;
        if (u.length === 1)
            return u[0];
        return u;
    }
    return undefined;
}
function isBreakingTypeChange(base, next, baseRequired = true) {
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
    if (!base)
        return false;
    if (!next)
        return baseRequired;
    const b = new Set(toTypeList(base));
    const n = new Set(toTypeList(next));
    const baseAllows = (t) => {
        if (b.has(t))
            return true;
        if (t === "integer" && b.has("number"))
            return true;
        return false;
    };
    // If next has any type not previously allowed, it's breaking.
    for (const nt of n) {
        if (!baseAllows(nt))
            return true;
    }
    return false;
}
function stableStringify(value) {
    // Deterministic stringify for comparing enum/const values.
    // JSON.stringify depends on object key insertion order; we sort keys recursively.
    const seen = new WeakSet();
    const walk = (v) => {
        if (v === null)
            return null;
        const t = typeof v;
        if (t === "string" || t === "number" || t === "boolean")
            return v;
        if (t === "bigint")
            return String(v);
        if (t === "undefined")
            return { __wcci_undefined: true };
        if (t === "function" || t === "symbol")
            return { __wcci_unserializable: true };
        if (Array.isArray(v))
            return v.map(walk);
        if (t === "object") {
            if (seen.has(v))
                return { __wcci_cycle: true };
            seen.add(v);
            const out = {};
            const keys = Object.keys(v).sort((a, b) => a.localeCompare(b));
            for (const k of keys)
                out[k] = walk(v[k]);
            return out;
        }
        return v;
    };
    return JSON.stringify(walk(value));
}
function isBreakingConstraintChanges(base, next) {
    // Return 0+ short reason strings if this node's constraints represent breaking changes.
    // Rule: widening (less restrictive) compared to base is breaking.
    const reasons = [];
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
        }
        else if (next.const !== undefined) {
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
            if (stableStringify(base.const) !== stableStringify(next.const))
                reasons.push(`const changed`);
        }
        else if (Array.isArray(next.enum)) {
            // base.const means the producer always emitted a single value. If next allows more than that
            // single value, the producer may start emitting values consumers can't accept.
            const b = stableStringify(base.const);
            const widened = next.enum.some((v) => stableStringify(v) !== b);
            if (widened)
                reasons.push(`const widened`);
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
    if (base.additionalProperties === false &&
        (next.additionalProperties === true ||
            (next.additionalProperties !== null && typeof next.additionalProperties === "object"))) {
        reasons.push(`additionalProperties opened`);
    }
    // If base had a schema for additionalProperties (meaning "extra" keys are allowed but must
    // conform to this subschema), and next removes it / switches to `true`, that's a widening.
    // We also walk & diff the subschema itself separately (see indexSchema), but we need this guard
    // to catch the case where it disappears entirely.
    const baseAPIsSchema = base.additionalProperties !== undefined &&
        base.additionalProperties !== null &&
        typeof base.additionalProperties === "object";
    const nextAPIsSchema = next.additionalProperties !== undefined &&
        next.additionalProperties !== null &&
        typeof next.additionalProperties === "object";
    if (baseAPIsSchema && !nextAPIsSchema) {
        // next.additionalProperties is true/false/undefined
        if (next.additionalProperties === false) {
            // tightening: previously extra keys were allowed (with constraints), now they're forbidden.
            // For producer-change diff, that's not breaking.
        }
        else if (next.additionalProperties === true) {
            // Explicitly switching to `true` removes the subschema constraint.
            reasons.push(`additionalProperties schema loosened`);
        }
        else {
            // `undefined` means "unspecified" (common for inferred schemas) — don't treat as breaking.
        }
    }
    const readLower = (x) => {
        // We only support the numeric forms.
        if (typeof x.exclusiveMinimum === "number")
            return { value: x.exclusiveMinimum, exclusive: true };
        if (typeof x.minimum === "number")
            return { value: x.minimum, exclusive: false };
        return undefined;
    };
    const readUpper = (x) => {
        if (typeof x.exclusiveMaximum === "number")
            return { value: x.exclusiveMaximum, exclusive: true };
        if (typeof x.maximum === "number")
            return { value: x.maximum, exclusive: false };
        return undefined;
    };
    const boundIsLooser = (baseB, nextB, kind) => {
        if (kind === "lower") {
            // Lower bound is looser if it allows smaller numbers, or if it flips exclusive -> inclusive.
            if (nextB.value < baseB.value)
                return true;
            if (nextB.value > baseB.value)
                return false;
            return baseB.exclusive && !nextB.exclusive;
        }
        // Upper bound is looser if it allows larger numbers, or if it flips exclusive -> inclusive.
        if (nextB.value > baseB.value)
            return true;
        if (nextB.value < baseB.value)
            return false;
        return baseB.exclusive && !nextB.exclusive;
    };
    // Numeric bounds (compare effective interval endpoints across min/exclusiveMin and max/exclusiveMax).
    // NOTE: If next is missing bound info entirely, we ignore it to avoid noisy false positives when
    // next is inferred from a sample payload.
    const bLower = readLower(base);
    const nLower = readLower(next);
    if (bLower && nLower && boundIsLooser(bLower, nLower, "lower")) {
        reasons.push(`minimum loosened (${bLower.exclusive ? ">" : ">="}${bLower.value} -> ${nLower.exclusive ? ">" : ">="}${nLower.value})`);
    }
    const bUpper = readUpper(base);
    const nUpper = readUpper(next);
    if (bUpper && nUpper && boundIsLooser(bUpper, nUpper, "upper")) {
        reasons.push(`maximum loosened (${bUpper.exclusive ? "<" : "<="}${bUpper.value} -> ${nUpper.exclusive ? "<" : "<="}${nUpper.value})`);
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
            if (!tightening)
                reasons.push(`multipleOf changed (${b} -> ${n})`);
        }
    }
    const cmp = (key, label, kind) => {
        const b = base[key];
        if (typeof b !== "number")
            return;
        const n = next[key];
        if (typeof n !== "number") {
            // Next schema missing this constraint: ignore to avoid false positives when next is inferred.
            return;
        }
        if (kind === "max" && n > b)
            reasons.push(`${label} loosened (${b} -> ${n})`);
        if (kind === "min" && n < b)
            reasons.push(`${label} loosened (${b} -> ${n})`);
    };
    cmp("maxLength", "maxLength", "max");
    cmp("minLength", "minLength", "min");
    // pattern
    // We cannot decide whether one regex is a strict superset of another in general.
    // Treat explicit pattern changes as breaking; ignore missing `next.pattern` to avoid noisy
    // false positives from inferred schemas.
    if (typeof base.pattern === "string" && typeof next.pattern === "string") {
        if (base.pattern !== next.pattern)
            reasons.push(`pattern changed`);
    }
    // format/contentEncoding/contentMediaType
    // We can't reliably reason about subset/superset between arbitrary formats/encodings.
    // Treat explicit changes as breaking; ignore missing `next.*` to avoid noisy inference gaps.
    if (typeof base.format === "string" && typeof next.format === "string") {
        if (base.format !== next.format)
            reasons.push(`format changed`);
    }
    if (typeof base.contentEncoding === "string" &&
        typeof next.contentEncoding === "string") {
        if (base.contentEncoding !== next.contentEncoding) {
            reasons.push(`contentEncoding changed`);
        }
    }
    if (typeof base.contentMediaType === "string" &&
        typeof next.contentMediaType === "string") {
        if (base.contentMediaType !== next.contentMediaType) {
            reasons.push(`contentMediaType changed`);
        }
    }
    // propertyNames.pattern
    // Similar story: only treat changes as breaking when both are explicitly present.
    if (typeof base.propertyNamesPattern === "string" &&
        typeof next.propertyNamesPattern === "string") {
        if (base.propertyNamesPattern !== next.propertyNamesPattern) {
            reasons.push(`propertyNames pattern changed`);
        }
    }
    cmp("maxItems", "maxItems", "max");
    cmp("minItems", "minItems", "min");
    cmp("maxProperties", "maxProperties", "max");
    cmp("minProperties", "minProperties", "min");
    return reasons;
}
function escapePointerToken(token) {
    // RFC6901-ish
    return token.replace(/~/g, "~0").replace(/\//g, "~1");
}
const WCCI_ITEMS_TOKEN = "__wcci_items";
const WCCI_TUPLE_ITEMS_TOKEN = "__wcci_tupleItems";
const WCCI_ADDITIONAL_PROPERTIES_TOKEN = "__wcci_additionalProperties";
function unescapePointerToken(token) {
    return token.replace(/~1/g, "/").replace(/~0/g, "~");
}
function getByJsonPointer(root, ptr) {
    // Supports pointers like "#/components/schemas/Foo" or "#/definitions/Foo".
    // Returns undefined if any segment is missing.
    if (ptr === "#" || ptr === "#/")
        return root;
    if (!ptr.startsWith("#/"))
        return undefined;
    const tokens = ptr
        .slice(2)
        .split("/")
        .map((t) => unescapePointerToken(t));
    let cur = root;
    for (const t of tokens) {
        if (!cur || typeof cur !== "object")
            return undefined;
        cur = cur[t];
    }
    return cur;
}
function resolveLocalRef(root, node) {
    if (!node || typeof node !== "object")
        return node;
    const ref = node.$ref;
    if (typeof ref !== "string")
        return node;
    // Only resolve local refs ("#...") deterministically. Remote refs are intentionally ignored.
    if (!ref.startsWith("#"))
        return node;
    const seen = new Set();
    let curNode = node;
    while (curNode && typeof curNode === "object" && typeof curNode.$ref === "string" && curNode.$ref.startsWith("#")) {
        const r = curNode.$ref;
        if (seen.has(r))
            break; // cycle
        seen.add(r);
        const target = getByJsonPointer(root, r);
        if (!target || typeof target !== "object")
            break;
        // Merge: referenced schema provides defaults; local keys override.
        const { $ref, ...local } = curNode;
        curNode = { ...target, ...local };
    }
    return curNode;
}
function collapseAllOfForIndexing(rootSchema, node) {
    // Best-effort materialization of `allOf` so we can index properties/constraints that are
    // commonly expressed via composition (OpenAPI, JSON Schema definitions).
    //
    // Goal: make `indexSchema()` see the effective shape of objects/arrays well enough for diffing.
    // We intentionally keep this conservative + deterministic; we do not attempt full JSON Schema
    // evaluation.
    if (!node || typeof node !== "object")
        return node;
    // Resolve refs before collapse so branches can be followed.
    node = resolveLocalRef(rootSchema, node);
    if (!Array.isArray(node.allOf))
        return node;
    // Start from the local node, keeping `allOf` for type extraction, but also fold branch
    // properties/constraints onto the node so indexSchema can see them.
    const allOf = node.allOf;
    const out = { ...node };
    const mergeNum = (branch, key, pick) => {
        const next = branch?.[key];
        if (typeof next !== "number")
            return;
        const cur = out[key];
        if (typeof cur !== "number") {
            out[key] = next;
            return;
        }
        out[key] = pick(cur, next);
    };
    const mergeEqString = (branch, key) => {
        const v = branch?.[key];
        if (typeof v !== "string")
            return;
        if (out[key] === undefined)
            out[key] = v;
        else if (typeof out[key] === "string" && out[key] !== v)
            delete out[key];
    };
    // allOf intersection => stricter constraints.
    // - minimum: max
    // - maximum: min
    // - minLength/minItems/minProperties: max
    // - maxLength/maxItems/maxProperties: min
    // - multipleOf: hard to intersect precisely; keep only if identical across branches.
    // - pattern/format/etc: ambiguous; keep only if identical across branches.
    for (const rawBranch of allOf) {
        const branch = collapseAllOfForIndexing(rootSchema, rawBranch);
        if (!branch || typeof branch !== "object")
            continue;
        // Required: union.
        if (Array.isArray(branch.required)) {
            const cur = new Set(Array.isArray(out.required) ? out.required : []);
            for (const k of branch.required)
                cur.add(k);
            out.required = Array.from(cur).sort((a, b) => a.localeCompare(b));
        }
        // Properties: merge by name.
        if (branch.properties && typeof branch.properties === "object") {
            const curProps = out.properties && typeof out.properties === "object" ? out.properties : {};
            const merged = { ...curProps };
            for (const [k, v] of Object.entries(branch.properties)) {
                if (merged[k] !== undefined) {
                    // Preserve intersection semantics by composing the per-property schemas.
                    merged[k] = { allOf: [merged[k], v] };
                }
                else {
                    merged[k] = v;
                }
            }
            out.properties = merged;
            if (!out.type)
                out.type = "object";
        }
        // additionalProperties: stricter wins (false is strictest). If both are schemas, intersect via allOf.
        if (branch.additionalProperties !== undefined) {
            const cur = out.additionalProperties;
            const next = branch.additionalProperties;
            if (cur === undefined) {
                out.additionalProperties = next;
            }
            else if (cur === false || next === false) {
                out.additionalProperties = false;
            }
            else if (cur && typeof cur === "object" && next && typeof next === "object") {
                out.additionalProperties = { allOf: [cur, next] };
            }
            else {
                // true + schema => schema is stricter than true.
                if (cur === true && next && typeof next === "object")
                    out.additionalProperties = next;
                if (next === true && cur && typeof cur === "object")
                    out.additionalProperties = cur;
            }
        }
        // Numeric bounds
        mergeNum(branch, "minimum", Math.max);
        mergeNum(branch, "exclusiveMinimum", Math.max);
        mergeNum(branch, "maximum", Math.min);
        mergeNum(branch, "exclusiveMaximum", Math.min);
        // Length/count bounds
        mergeNum(branch, "minLength", Math.max);
        mergeNum(branch, "maxLength", Math.min);
        mergeNum(branch, "minItems", Math.max);
        mergeNum(branch, "maxItems", Math.min);
        mergeNum(branch, "minProperties", Math.max);
        mergeNum(branch, "maxProperties", Math.min);
        // multipleOf: keep only if identical.
        if (typeof branch.multipleOf === "number") {
            if (out.multipleOf === undefined)
                out.multipleOf = branch.multipleOf;
            else if (typeof out.multipleOf === "number" && out.multipleOf !== branch.multipleOf) {
                delete out.multipleOf;
            }
        }
        mergeEqString(branch, "pattern");
        mergeEqString(branch, "format");
        mergeEqString(branch, "contentEncoding");
        mergeEqString(branch, "contentMediaType");
        // propertyNames: keep only if we can preserve it exactly.
        if (branch.propertyNames && typeof branch.propertyNames === "object") {
            if (out.propertyNames === undefined)
                out.propertyNames = branch.propertyNames;
            else if (stableStringify(out.propertyNames) !== stableStringify(branch.propertyNames)) {
                delete out.propertyNames;
            }
        }
        // items (array) merging: if both specify items, intersect via allOf; else pick the one that exists.
        if (branch.items !== undefined) {
            if (out.items === undefined)
                out.items = branch.items;
            else {
                // Tuple vs schema: too complex; only merge schema+schema.
                if (!Array.isArray(out.items) && !Array.isArray(branch.items)) {
                    out.items = { allOf: [out.items, branch.items] };
                }
            }
            if (!out.type)
                out.type = "array";
        }
    }
    return out;
}
export function indexSchema(schema) {
    const out = new Map();
    function walk(node, pointer, required) {
        if (!node || typeof node !== "object")
            return;
        // Resolve local $ref indirections so diff semantics work for common OpenAPI/JSON Schema layouts.
        // Note: we intentionally do not resolve remote refs.
        node = resolveLocalRef(schema, node);
        // allOf composition is common in OpenAPI/JSON Schema; collapse it so we can index
        // properties/constraints that live in composed branches.
        node = collapseAllOfForIndexing(schema, node);
        const info = {
            pointer,
            type: extractTypeFromSchemaNode(node),
            required,
            enum: Array.isArray(node.enum) ? node.enum : undefined,
            const: node.const,
            additionalProperties: node.type === "object" || (node.properties && typeof node.properties === "object")
                ? node.additionalProperties
                : undefined,
            propertyNamesPattern: (node.type === "object" || (node.properties && typeof node.properties === "object")) &&
                node.propertyNames &&
                typeof node.propertyNames === "object" &&
                typeof node.propertyNames.pattern === "string"
                ? node.propertyNames.pattern
                : undefined,
            minimum: typeof node.minimum === "number" ? node.minimum : undefined,
            exclusiveMinimum: typeof node.exclusiveMinimum === "number" ? node.exclusiveMinimum : undefined,
            maximum: typeof node.maximum === "number" ? node.maximum : undefined,
            exclusiveMaximum: typeof node.exclusiveMaximum === "number" ? node.exclusiveMaximum : undefined,
            multipleOf: typeof node.multipleOf === "number" ? node.multipleOf : undefined,
            minLength: typeof node.minLength === "number" ? node.minLength : undefined,
            maxLength: typeof node.maxLength === "number" ? node.maxLength : undefined,
            pattern: typeof node.pattern === "string" ? node.pattern : undefined,
            format: typeof node.format === "string" ? node.format : undefined,
            contentEncoding: typeof node.contentEncoding === "string" ? node.contentEncoding : undefined,
            contentMediaType: typeof node.contentMediaType === "string" ? node.contentMediaType : undefined,
            minItems: typeof node.minItems === "number" ? node.minItems : undefined,
            maxItems: typeof node.maxItems === "number" ? node.maxItems : undefined,
            minProperties: typeof node.minProperties === "number" ? node.minProperties : undefined,
            maxProperties: typeof node.maxProperties === "number" ? node.maxProperties : undefined,
        };
        // Store even intermediate nodes so we can detect type changes at objects/arrays too.
        out.set(pointer, info);
        const looksLikeObject = node.type === "object" || (node.properties && typeof node.properties === "object");
        const looksLikeArray = node.type === "array" || node.items !== undefined;
        if (looksLikeObject) {
            if (node.properties && typeof node.properties === "object") {
                const req = new Set(Array.isArray(node.required) ? node.required : []);
                for (const [k, v] of Object.entries(node.properties)) {
                    const childPtr = pointer === "/" ? `/${escapePointerToken(k)}` : `${pointer}/${escapePointerToken(k)}`;
                    walk(v, childPtr, req.has(k));
                }
            }
            // If additionalProperties is a schema object, index it as a child node so we can detect
            // widen/narrow changes to the allowed shape of "extra" keys.
            if (node.additionalProperties && typeof node.additionalProperties === "object") {
                const apPtr = pointer === "/" ? `/${WCCI_ADDITIONAL_PROPERTIES_TOKEN}` : `${pointer}/${WCCI_ADDITIONAL_PROPERTIES_TOKEN}`;
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
                const basePtr = pointer === "/" ? `/${WCCI_TUPLE_ITEMS_TOKEN}` : `${pointer}/${WCCI_TUPLE_ITEMS_TOKEN}`;
                for (let i = 0; i < node.items.length; i++) {
                    const childPtr = `${basePtr}/${i}`;
                    walk(node.items[i], childPtr, required);
                }
            }
            else {
                const childPtr = pointer === "/" ? `/${WCCI_ITEMS_TOKEN}` : `${pointer}/${WCCI_ITEMS_TOKEN}`;
                walk(node.items, childPtr, required);
            }
        }
    }
    walk(schema, "/", true);
    return out;
}
export function summarizeDiff(baseSchema, nextSchema) {
    const baseIdx = indexSchema(baseSchema);
    const nextIdx = indexSchema(nextSchema);
    const displayPointer = (ptr) => {
        if (ptr === "/")
            return "/";
        const tokens = ptr.split("/").slice(1);
        const outTokens = [];
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
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
    const added = [];
    const removedRequired = [];
    const removedOptional = [];
    const requiredBecameOptional = [];
    const typeChanged = [];
    const constraintsChanged = [];
    const lastTokenOf = (p) => (p === "/" ? "" : p.slice(p.lastIndexOf("/") + 1));
    const parentPtrOf = (p) => {
        const i = p.lastIndexOf("/");
        return i <= 0 ? "/" : p.slice(0, i);
    };
    const isPropertyPointer = (p) => {
        const t = lastTokenOf(p);
        const parent = lastTokenOf(parentPtrOf(p));
        // Synthetic nodes we add for schema-indexing.
        if (t === WCCI_ITEMS_TOKEN)
            return false;
        if (t === WCCI_TUPLE_ITEMS_TOKEN)
            return false;
        if (t === WCCI_ADDITIONAL_PROPERTIES_TOKEN)
            return false;
        // Tuple item indices (e.g. /arr/__wcci_tupleItems/0) are not payload properties.
        if (parent === WCCI_TUPLE_ITEMS_TOKEN)
            return false;
        return true;
    };
    const isAdditionalPropertiesSchemaPointer = (p) => lastTokenOf(p) === WCCI_ADDITIONAL_PROPERTIES_TOKEN;
    for (const [ptr, b] of baseIdx.entries()) {
        const n = nextIdx.get(ptr);
        if (!n) {
            if (b.required) {
                removedRequired.push(displayPointer(ptr));
            }
            else {
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
            typeChanged.push(`${displayPointer(ptr)} (${JSON.stringify(b.type)} -> ${JSON.stringify(n.type)})`);
        }
        const cs = isBreakingConstraintChanges(b, n);
        for (const c of cs)
            constraintsChanged.push(`${displayPointer(ptr)} (${c})`);
    }
    for (const [ptr] of nextIdx.entries()) {
        if (baseIdx.has(ptr))
            continue;
        // If the "path" is the synthetic child that represents an additionalProperties *subschema*,
        // don't report it as a newly added path. It's a constraint node, not a payload field.
        if (isAdditionalPropertiesSchemaPointer(ptr))
            continue;
        // If the base schema declares an object as "closed" (additionalProperties:false), then adding a
        // new property under that object is breaking: a consumer validating against the base schema
        // will reject payloads containing the new property.
        const parentPtr = parentPtrOf(ptr);
        const parentBase = baseIdx.get(parentPtr);
        const isPropPtr = isPropertyPointer(ptr);
        if (isPropPtr &&
            parentBase?.type === "object" &&
            parentBase.additionalProperties === false) {
            constraintsChanged.push(`${displayPointer(ptr)} (added under closed object ${displayPointer(parentPtr)})`);
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
        const parentAPIsSchema = isPropPtr &&
            parentBase?.type === "object" &&
            parentBase.additionalProperties !== undefined &&
            parentBase.additionalProperties !== null &&
            typeof parentBase.additionalProperties === "object";
        if (parentAPIsSchema) {
            const apPtr = parentPtr === "/" ? `/${WCCI_ADDITIONAL_PROPERTIES_TOKEN}` : `${parentPtr}/${WCCI_ADDITIONAL_PROPERTIES_TOKEN}`;
            const baseAp = baseIdx.get(apPtr);
            const nextChild = nextIdx.get(ptr);
            if (baseAp && nextChild && isBreakingTypeChange(baseAp.type, nextChild.type, true)) {
                constraintsChanged.push(`${displayPointer(ptr)} (added key violates additionalProperties schema at ${displayPointer(parentPtr)}: ${JSON.stringify(baseAp.type)} -> ${JSON.stringify(nextChild.type)})`);
                continue;
            }
        }
        added.push(displayPointer(ptr));
    }
    // Determinism: always return lists in a stable order so CI output doesn't flap.
    // We sort by pointer, and for typeChanged we sort by the pointer prefix.
    const byPointer = (a, b) => a.localeCompare(b);
    const typeChangedByPointer = (a, b) => a.split(" ", 1)[0].localeCompare(b.split(" ", 1)[0]);
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
    const breakingCount = breaking.removedRequired.length +
        breaking.requiredBecameOptional.length +
        breaking.typeChanged.length +
        breaking.constraintsChanged.length;
    return {
        breaking,
        nonBreaking,
        breakingCount,
    };
}
export function validateAgainstSchema(schema, payload) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const ok = validate(payload);
    return { ok: Boolean(ok), errors: validate.errors };
}
//# sourceMappingURL=lib.js.map