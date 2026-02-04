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
function isBreakingTypeChange(base, next) {
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
        return true;
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
    // enum widening/removal
    if (Array.isArray(base.enum)) {
        if (!Array.isArray(next.enum)) {
            reasons.push(`enum removed`);
        }
        else {
            const b = new Set(base.enum.map((x) => stableStringify(x)));
            for (const v of next.enum) {
                if (!b.has(stableStringify(v))) {
                    reasons.push(`enum widened`);
                    break;
                }
            }
        }
    }
    // const removal/change
    if (base.const !== undefined) {
        if (next.const === undefined)
            reasons.push(`const removed`);
        else if (stableStringify(base.const) !== stableStringify(next.const))
            reasons.push(`const changed`);
    }
    // additionalProperties
    // If base was a "closed" object (no extra fields allowed), and next opens it up, that is a
    // producer-widening change: the producer can start sending new fields that consumers (validating
    // against the base schema) will reject.
    if (base.additionalProperties === false && next.additionalProperties !== false) {
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
        else {
            reasons.push(`additionalProperties schema loosened`);
        }
    }
    const cmpNum = (key, kind) => {
        const b = base[key];
        if (typeof b !== "number")
            return;
        const n = next[key];
        if (typeof n !== "number") {
            reasons.push(`${key} removed`);
            return;
        }
        if (kind === "max" && n > b)
            reasons.push(`${key} loosened (${b} -> ${n})`);
        if (kind === "min" && n < b)
            reasons.push(`${key} loosened (${b} -> ${n})`);
    };
    // Numeric bounds
    cmpNum("maximum", "max");
    cmpNum("exclusiveMaximum", "max");
    cmpNum("minimum", "min");
    cmpNum("exclusiveMinimum", "min");
    const cmp = (key, label, kind) => {
        const b = base[key];
        if (typeof b !== "number")
            return;
        const n = next[key];
        if (typeof n !== "number") {
            reasons.push(`${label} removed`);
            return;
        }
        if (kind === "max" && n > b)
            reasons.push(`${label} loosened (${b} -> ${n})`);
        if (kind === "min" && n < b)
            reasons.push(`${label} loosened (${b} -> ${n})`);
    };
    cmp("maxLength", "maxLength", "max");
    cmp("minLength", "minLength", "min");
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
const WCCI_ADDITIONAL_PROPERTIES_TOKEN = "__wcci_additionalProperties";
export function indexSchema(schema) {
    const out = new Map();
    function walk(node, pointer, required) {
        if (!node || typeof node !== "object")
            return;
        const info = {
            pointer,
            type: node.type,
            required,
            enum: Array.isArray(node.enum) ? node.enum : undefined,
            const: node.const,
            additionalProperties: node.type === "object" ? node.additionalProperties : undefined,
            minimum: typeof node.minimum === "number" ? node.minimum : undefined,
            exclusiveMinimum: typeof node.exclusiveMinimum === "number" ? node.exclusiveMinimum : undefined,
            maximum: typeof node.maximum === "number" ? node.maximum : undefined,
            exclusiveMaximum: typeof node.exclusiveMaximum === "number" ? node.exclusiveMaximum : undefined,
            minLength: typeof node.minLength === "number" ? node.minLength : undefined,
            maxLength: typeof node.maxLength === "number" ? node.maxLength : undefined,
            minItems: typeof node.minItems === "number" ? node.minItems : undefined,
            maxItems: typeof node.maxItems === "number" ? node.maxItems : undefined,
            minProperties: typeof node.minProperties === "number" ? node.minProperties : undefined,
            maxProperties: typeof node.maxProperties === "number" ? node.maxProperties : undefined,
        };
        // Store even intermediate nodes so we can detect type changes at objects/arrays too.
        out.set(pointer, info);
        if (node.type === "object") {
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
        if (node.type === "array" && node.items) {
            // Use an internal token to represent the "element" schema.
            // NOTE: We intentionally avoid the plain token "items" because it can collide with a real
            // object property named "items" (and likewise for additionalProperties).
            const childPtr = pointer === "/" ? `/${WCCI_ITEMS_TOKEN}` : `${pointer}/${WCCI_ITEMS_TOKEN}`;
            walk(node.items, childPtr, required);
        }
    }
    walk(schema, "/", true);
    return out;
}
export function summarizeDiff(baseSchema, nextSchema) {
    const baseIdx = indexSchema(baseSchema);
    const nextIdx = indexSchema(nextSchema);
    const added = [];
    const removedRequired = [];
    const removedOptional = [];
    const requiredBecameOptional = [];
    const typeChanged = [];
    const constraintsChanged = [];
    for (const [ptr, b] of baseIdx.entries()) {
        const n = nextIdx.get(ptr);
        if (!n) {
            if (b.required)
                removedRequired.push(ptr);
            else
                removedOptional.push(ptr);
            continue;
        }
        if (b.required && !n.required) {
            requiredBecameOptional.push(ptr);
        }
        if (isBreakingTypeChange(b.type, n.type)) {
            typeChanged.push(`${ptr} (${JSON.stringify(b.type)} -> ${JSON.stringify(n.type)})`);
        }
        const cs = isBreakingConstraintChanges(b, n);
        for (const c of cs)
            constraintsChanged.push(`${ptr} (${c})`);
    }
    for (const [ptr] of nextIdx.entries()) {
        if (baseIdx.has(ptr))
            continue;
        // If the base schema declares an object as "closed" (additionalProperties:false), then adding a
        // new property under that object is breaking: a consumer validating against the base schema
        // will reject payloads containing the new property.
        const lastSlash = ptr.lastIndexOf("/");
        const parentPtr = lastSlash <= 0 ? "/" : ptr.slice(0, lastSlash);
        const parentBase = baseIdx.get(parentPtr);
        const lastToken = ptr === "/" ? "" : ptr.slice(ptr.lastIndexOf("/") + 1);
        const isPropertyPointer = lastToken !== WCCI_ITEMS_TOKEN &&
            lastToken !== WCCI_ADDITIONAL_PROPERTIES_TOKEN;
        if (isPropertyPointer && parentBase?.type === "object" && parentBase.additionalProperties === false) {
            constraintsChanged.push(`${ptr} (added under closed object ${parentPtr})`);
            continue;
        }
        added.push(ptr);
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
