# Webhook Contract CI

A GitHub Action + CLI to **prevent webhook payload changes from breaking production**.

Instead of “inspect and replay” (crowded market: Hookdeck / Webhook.site / Beeceptor), this focuses on **contract testing**:

- Generate/update a JSON Schema (and optionally TypeScript types) from example payloads
- Validate new payload samples against the baseline schema in CI
- Produce human-readable diffs when the payload shape changes

## Why this exists
Webhook inspection tools are commoditized. The painful, expensive bit is when payloads drift and you only learn in prod.

This project aims to make webhook payload contracts:
- versioned (in git)
- enforced (in CI)
- reviewable (PR comments)

## Status
WIP — scaffold + research notes first, then MVP implementation.

## MVP (current)
- CLI:
  - `wcci infer --in payload.json --out schema.json`
  - `wcci check --schema schema.json --in payload.json`
  - `wcci diff --base schema.json --next payload.json` (infers schema from the payload sample and reports *breaking* changes)

### Breaking diff semantics
`wcci diff` is opinionated for webhook *consumers*:

It treats these as **breaking** (exit 1):
- a path that was **required** in the baseline schema disappears in the new payload sample
- a path that was **required** becomes **optional**
- a path’s **type changes** (e.g. `string -> number`)

It treats these as **non-breaking**:
- new paths are added
- optional paths are removed

### GitHub Action
This repo ships a composite action (see `action.yml`). Example workflow:

```yaml
name: Webhook contract
on:
  pull_request:

jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # If using this action from another repo:
      # - uses: owner/webhook-contract-ci@v1
      # If running it inside this repo for local testing:
      - uses: ./
        with:
          mode: diff
          schema: schemas/webhook.schema.json
          payload: samples/webhook.payload.json
          show_nonbreaking: true
```

## License
TBD
