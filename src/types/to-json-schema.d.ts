declare module "to-json-schema" {
  type Options = {
    required?: boolean;
    arrays?: { mode?: string };
  };

  export default function toJsonSchema(input: unknown, options?: Options): unknown;
}
