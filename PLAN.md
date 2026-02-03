# Plan (MVP)

## Target user
Solo devs / small teams building integrations (Stripe, GitHub, Shopify, etc.).

## What we sell
Free: GitHub Action + basic schema validation.
Paid (later): hosted payload history, alerts, team sharing, long-term retention.

## Differentiation vs competitors
- Hookdeck/Webhook.site/Beeceptor: inspection + replay + routing (feature-heavy, infra-y)
- TypedWebhook.tools: generates types/schemas from captured requests

**Our wedge:** enforce contracts in CI and make payload diffs reviewable.

## MVP decisions
- Start with **JSON Schema + AJV** validation.
- Schema inference: pick a library that creates reasonable schemas from samples.
- Diff: show changes in required fields / types / missing paths.

## Next steps
1. Evaluate schema inference libs (JS):
   - to-json-schema
   - json-schema-inferrer
   - quicktype
2. Evaluate schema diff libs:
   - json-schema-diff
   - custom diff on normalized schema
3. Implement CLI with good UX and test fixtures.
4. Wrap as a GitHub Action.
