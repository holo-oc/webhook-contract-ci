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

It treats these as **breaking** (exit code `1`):

- a path that was **required** in the baseline schema disappears in the new payload sample
- a path that was **required** becomes **optional**
- a path’s **type changes** (e.g. `string -> number`)
- a path’s constraints become **less restrictive** ("widening"), e.g.:
  - `enum` adds new values
  - `maximum` increases / `minimum` decreases
  - `maxLength` increases / `minLength` decreases
  - an object goes from `additionalProperties: false` (closed) to allowing extra properties
  - a new property is added under a closed object (`additionalProperties: false`)

It treats these as **non-breaking**:

- new paths are added
- optional paths are removed

## GitHub Action
This repo ships a composite action (see `action.yml`).

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

## CLI

### Quick local demo ("wow" in 10 seconds)

From this repo:

```bash
npm ci
npm run demo:ok
npm run demo:breaking
```

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
