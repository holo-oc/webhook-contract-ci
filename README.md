# Webhook Contract CI

A GitHub Action + CLI to **prevent webhook payload changes from breaking production**.

Instead of “inspect and replay” (crowded market: Hookdeck / Webhook.site / Beeceptor), this focuses on **contract testing**:

- Generate/update a JSON Schema (optionally TypeScript types later) from example payloads
- Validate new payload samples against the baseline schema in CI
- Produce a human-readable summary of *breaking* changes when the payload shape drifts

## Why this exists
Webhook inspection tools are commoditized. The painful, expensive bit is when payloads drift and you only learn in prod.

This project aims to make webhook payload contracts:

- versioned (in git)
- enforced (in CI)
- reviewable (in PRs)

## Status
MVP-ish. The CLI + action are usable, but the schema inference and diff semantics are opinionated and intentionally conservative.

## Concepts

### Files to commit
You typically commit two things:

- `schemas/webhook.schema.json` — the baseline JSON Schema inferred from a “known-good” payload
- `samples/webhook.payload.json` — a representative sample payload (or a fixture you update when providers change)

### Breaking diff semantics
`wcci diff` is opinionated for webhook *consumers*.

It also supports common OpenAPI/JSON Schema composition patterns: object properties/constraints that live inside `allOf` branches are collapsed for indexing, so they participate in diffs.

Note on pointers: output is JSON-pointer-ish (e.g. `/nested/id`) and is displayed with RFC6901 *decoded* property names (so a property literally named `a/b` shows up as `/a/b`, not `/a~1b`). For some synthetic schema nodes we use internal tokens to avoid collisions with real property names:
- homogeneous array item schemas: `/*`
- tuple array items (when a schema uses `items: [...]`): `/[0]`, `/[1]`, ...
- `additionalProperties` subschemas: `/{additionalProperties}`

It treats these as **breaking** (exit code `1`):

- a path that was **required** in the baseline schema disappears in the new payload sample
- a path that was **required** becomes **optional**
- a path’s **type changes** (e.g. `string -> number`)
- a path’s constraints become **less restrictive** ("widening"), e.g.:
  - `enum` adds new values (including when a previously-enumerated field shows a new `const` value outside the baseline enum)
  - `maximum` increases / `minimum` decreases
  - `maxLength` increases / `minLength` decreases
  - `pattern` changes (only when both schemas specify a `pattern`; missing inferred patterns are ignored)
  - `maxItems` increases / `minItems` decreases
  - `maxProperties` increases / `minProperties` decreases
  - an object goes from `additionalProperties: false` (closed) to allowing extra properties
  - an `additionalProperties` **subschema** is loosened/removed (e.g. `{type:"string"} -> true`)
  - a new property is added under a closed object (`additionalProperties: false`)

It treats these as **non-breaking**:

- new paths are added
- optional paths are removed (only reported when the *next* parent object is explicitly closed with `additionalProperties:false`; otherwise removals are ambiguous in single-sample inference)

## GitHub Action
This repo ships a composite action (see `action.yml`) that runs a **bundled** CLI (`dist/bundle/cli.cjs`).

That means the action does **not** run `npm ci` at runtime (faster, no registry flakiness).

**Important:** `schema` and `payload` inputs are resolved relative to your repo root (`GITHUB_WORKSPACE`).

Modes:
- `infer`: regenerate a schema from a payload sample
- `check`: validate a payload sample against a schema
- `diff`: detect breaking changes vs a schema

### Example workflow (PR-safe)

This pattern compares the PR payload sample against the **base branch** schema.
That way, updating the schema in the PR can’t hide a breaking change.

```yaml
name: Webhook contract
on:
  pull_request:

jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Load base schema
        run: |
          git fetch --no-tags --depth=1 origin "${{ github.base_ref }}"
          git show "origin/${{ github.base_ref }}:schemas/webhook.schema.json" > /tmp/webhook.base.schema.json

      # Use a tagged release in your own repo, e.g.:
      # - uses: your-org/webhook-contract-ci@v1
      - uses: owner/webhook-contract-ci@v1
        with:
          mode: diff
          schema: /tmp/webhook.base.schema.json
          payload: samples/webhook.payload.json
          show_nonbreaking: true
```

(Also see `examples/workflows/webhook-contract.yml` and `examples/workflows/webhook-contract-pr.yml`.)

There’s also a copy/paste-ready **mini example repo** under `examples/example-repo/` (workflow + sample schema/payload).

## CLI

### Quick local demo ("wow" in 10 seconds)

From this repo:

```bash
npm ci
npm run demo:ok
npm run demo:breaking
npm run demo:breaking:json
```

Example output (breaking):

```text
breaking webhook payload changes detected:
removed required paths:
- /id
```

(For deterministic, copy/paste-able snapshots, see:
- `examples/demo-ok-output.txt`
- `examples/demo-breaking-output.txt`
- `examples/demo-breaking-output.json`.)

Optional: there’s also a `vhs` tape you can use to generate a short GIF demo locally:
- `examples/vhs/wcci.tape`

### Infer a baseline schema

```bash
wcci infer --in samples/webhook.payload.json --out schemas/webhook.schema.json
```

### Validate a payload against a schema

```bash
wcci check --schema schemas/webhook.schema.json --in samples/webhook.payload.json
```

### Detect breaking changes

```bash
wcci diff --base schemas/webhook.schema.json --next samples/webhook.payload.json --show-nonbreaking

# Or schema-to-schema diff
wcci diff --base schemas/webhook.schema.json --next-schema schemas/webhook.next.schema.json --show-nonbreaking

# Or machine-readable output (still uses exit codes)
# Note: `breakingPaths` entries include a `pointer` plus optional `detail` for categories
# like `typeChanged` and `constraintsChanged`.
wcci diff --base schemas/webhook.schema.json --next samples/webhook.payload.json --json
```

### Help

```bash
wcci --help
```

## Development

```bash
npm ci
npm test
```

## License
TBD
