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

## Planned MVP
- CLI:
  - `wcci infer --in payload.json --out schema.json`
  - `wcci check --schema schema.json --in payload.json`
  - `wcci diff --base schema.json --next payload.json`
- GitHub Action:
  - runs on PR
  - fails if payload violates schema (or if breaking diff detected)

## License
TBD
