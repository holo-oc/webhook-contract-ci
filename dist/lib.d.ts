import { type ErrorObject } from "ajv";
export type TypeName = "null" | "boolean" | "number" | "integer" | "string" | "array" | "object";
export type NodeInfo = {
    pointer: string;
    type?: TypeName | TypeName[];
    required: boolean;
    enum?: unknown[];
    const?: unknown;
    additionalProperties?: boolean | object;
    minimum?: number;
    exclusiveMinimum?: number;
    maximum?: number;
    exclusiveMaximum?: number;
    minLength?: number;
    maxLength?: number;
    minItems?: number;
    maxItems?: number;
    minProperties?: number;
    maxProperties?: number;
};
export declare function formatAjvErrors(errors: ErrorObject[] | null | undefined): string;
/**
 * `to-json-schema` uses a nonstandard `required: true` boolean on properties.
 * AJV expects JSON Schema's `required: string[]` on the parent object.
 */
export declare function normalizeToJsonSchema(input: any): any;
export declare function inferSchemaFromPayload(payload: unknown): any;
export declare function indexSchema(schema: any): Map<string, NodeInfo>;
export declare function summarizeDiff(baseSchema: any, nextSchema: any): {
    breaking: {
        removedRequired: string[];
        requiredBecameOptional: string[];
        typeChanged: string[];
        constraintsChanged: string[];
    };
    nonBreaking: {
        added: string[];
        removedOptional: string[];
    };
    breakingCount: number;
};
export declare function validateAgainstSchema(schema: any, payload: any): {
    ok: boolean;
    errors: ErrorObject<string, Record<string, any>, unknown>[] | null | undefined;
};
//# sourceMappingURL=lib.d.ts.map