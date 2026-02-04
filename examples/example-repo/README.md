# Example repo (local fixture)

This folder is a **copy/paste-ready mini repo** you can use to demo or validate the Action wiring.

It’s intentionally not published anywhere — just a convenient local fixture for:

- a realistic `schemas/` + `samples/` layout
- a PR-safe workflow that compares the PR payload against the **base branch** schema

## How to use

1) Copy this folder into another repo (or into a temporary directory).

2) Adjust the Action `uses:` line:

- For local testing inside this repo, you can use `./`.
- For a real repo, use your pinned release tag/sha.

3) Open a PR that changes `samples/webhook.payload.json`.

If the payload drift is breaking, the workflow should fail with a readable diff.

## ### Workflows
- `webhook-contract.yml` (basic)
- `webhook-contract-pr.yml` (PR-safe, detects breaking changes vs base branch)

### Local CLI demo


From the *repo root* (this repo), you can demo breaking changes without GitHub Actions:

```bash
node dist/cli.js diff \
  --base examples/example-repo/schemas/webhook.schema.json \
  --next examples/example-repo/samples/webhook.payload.breaking.json \
  --show-nonbreaking
```

## GIF demo (optional)

If you have `vhs` installed, you can generate a short terminal GIF:

```bash
cd examples/example-repo
npm ci
vhs ../vhs/wcci.tape
# -> examples/example-repo/wcci-demo.gif
```
