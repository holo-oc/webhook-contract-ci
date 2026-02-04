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
