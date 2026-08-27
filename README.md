# stakepool-directory

Source of truth for the Solana stake-pool directory shown in the
Validator Metrics app: how a validator applies to each delegation
program, what each one requires, and where each stake source links.

This repo is public on purpose. The app reads the data through the
`validator-metrics` Cloudflare Worker (`/v1/stake-pools`), which fetches
`stake-pools.json` straight from raw GitHub — a public repo means the
worker needs no credential that could expire or leak.

## Files

- **`stake-pools.json`** — the directory. Edit this; nothing else serves data.
- **`scripts/audit-stake-pools.mjs`** — weekly freshness audit.
- **`.github/workflows/stake-pool-audit.yml`** — schedules the audit.

## How updates happen

Every Monday the workflow re-fetches each page cited by the directory and
runs a two-round audit. The first Claude call lists possible field changes;
a fresh judge call then decides whether each suggestion is materially
different in meaning, equivalent wording, or unsupported by the page. A
field is rewritten only when the judge finds an explicit, high-confidence
semantic change. Anything softer is left alone and reported for a human.
Link rot is checked with plain HTTP — no model involved — and sites that
merely block scripted requests (Cloudflare, 403) are reported as `blocked`
rather than broken, so the report stays worth reading.

Both rounds use `AUDIT_MODEL` by default. Set `AUDIT_JUDGE_MODEL` if the
judge should use a different Claude model.

Changes arrive as a pull request. **Review it against the linked pages
before merging** — the model is deliberately conservative, but it is not
a substitute for checking.

Merging is all it takes to ship: the worker picks the change up within an
hour, and the app reads it at runtime. No app release required. The app
also bundles a copy as an offline fallback, so this repo being
unreachable degrades to slightly stale data rather than an empty screen.

## Requirements

The workflow needs an `ANTHROPIC_API_KEY` repo secret. It runs on
`schedule` and `workflow_dispatch` only, both of which require write
access — the public cannot trigger it, and fork pull requests never
receive secrets.
