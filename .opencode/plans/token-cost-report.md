# Plan — Token & Cost Report for n8n (fastmart-ai)

## Goal
Know exactly how many tokens (and estimated cost) each chat turn burns, plus a time-window cost report — from the n8n instance's own stored data. No changes to n8n itself.

## Verified findings (research done, all proven live)

1. **n8n already records tokens per AI call.** Every execution's `execution_data.data` blob (flatted/index-compressed JSON in the `fastmart-n8n-postgres` container) contains per-node-run metrics:
   `llm.tokens.in`, `llm.tokens.out`, `llm.tokens.total`, `llm.tokens.estimated`, plus agent stats (`ai.agent.tool_calls.total`, etc.). Example (exec 651): in 3980 / out 493 / 9 tool calls.
2. **n8n never records cost** — we compute it from a price table.
3. **Turn = main agent-chat execution + its child specialist executions.** Children carry `parentExecution.executionId` pointing at the parent (verified: exec 652's parent = 651). Children run as mode `integrated`.
4. **Model id is recoverable** — the blob contains the model string (`gemini-3.7-flash`) next to the provider URL; node→model map can also be decoded from `execution_data.workflowData`. All workflows currently pin `gemini-3.7-flash` (per `dev/build-*.mjs`).
5. **Prices from models.dev API** (`https://models.dev/api.json`, provider `google`): `gemini-3.7-flash` = input $0.75, output $3.75, cache_read $0.075 per 1M tokens. n8n metrics do not split cached tokens, so we use input/output only.
6. **609 executions exist** in `execution_entity` (incl. recent `error` ones — they still have data rows, counted and flagged).
7. Decoding trick for the flatted blob already exists in `dev/decode-exec.mjs` / `dev/exec-timing.mjs` — reuse the same psql-pipe pattern (avoids PowerShell quoting hell).

## New files

### 1. `dev/usage-report.mjs` (main deliverable)
Read-only reporting CLI. Queries Postgres via `docker exec -i fastmart-n8n-postgres psql` (stdin SQL, same as existing scripts).

```
node dev/usage-report.mjs                      # all time
node dev/usage-report.mjs --days 7             # last 7 days
node dev/usage-report.mjs --since 2026-09-01   # from a date
node dev/usage-report.mjs --turns 651          # deep-dive one turn
node dev/usage-report.mjs --days 7 --out report.md --json report.json
```

Pipeline:
1. `execution_entity` JOIN `workflow_entity` (id, workflow name, status, startedAt) filtered by window.
2. For each: fetch `execution_data` row → decode flatted blob (resolve index refs) → collect per-node-run `metadata.metrics` token counts.
3. Group into **turns**: executions of `agent-chat (prod webhook)` = turn roots; children (mode `integrated` w/ parentExecution) roll up into their parent. Standalone/eval runs reported separately per workflow.
4. Cost = `tokens.in/1e6 × price.in + tokens.out/1e6 × price.out` per model. Unknown model (no price) → cost shown as `?` + loud warning listing the model id.
5. Model attribution: decode node→model from blob (model string near provider URL / workflowData); fallback: per-workflow default map; final fallback `unknown`.

### 2. `dev/usage-prices.json` (auto-managed price cache/override)
- On first run the script fetches `https://models.dev/api.json`, keeps only needed models, writes this file.
- Later runs: try live fetch (short timeout), fall back to this file. Manual edits respected (edit key `"prices"` → add model id with `{in, out}` per 1M).

## Report contents
- **Per-turn table** (main agent turns): time, user-message snippet (from webhook body), AI calls count, tokens in/out, cost, status (ok/error).
- **Summary by day** — turns, tokens, cost.
- **Summary by workflow** — catches eval-battery burn vs real traffic.
- **Summary by model** — future-proof when models differ.
- **Bottom line**: totals + avg cost/turn + pricing basis note.
- Outputs: console tables, `--out report.md`, `--json report.json`.

## Doc updates
- README "What's in here" table: add `dev/usage-report.mjs`, `dev/usage-prices.json`.
- PLAN.md Part 2 area: one checkbox line "token/cost reporting tool — done".

## Caveats (documented in script header)
- **Estimates, not invoices**: token counts are n8n's recorded usage; prices are list rates from models.dev. Actual Google bill can differ (batching, cached tokens not split out, free-tier credits).
- **Pruning risk**: if n8n execution-data pruning is ever enabled, old rows vanish — run periodically and keep the JSON snapshots.
- Read-only against the DB; zero risk to n8n runtime.

## Verification (after implementation)
1. `node dev/usage-report.mjs --turns 651` — expect ≈ exec 651 + child 652 tokens: in ~3980+ (agent+specialist), 9 tool calls — cross-check with `node dev/exec-timing.mjs 651`.
2. `node dev/usage-report.mjs --days 1` — turns today match execution list; error turns flagged.
3. Cost math sanity: 3980 in + 493 out → (3980×0.75 + 493×3.75)/1e6 ≈ $0.0048 for that agent hop.
4. md + json outputs render, and a bogus-price model produces the `?` + warning path.

## Out of scope (noted for later)
- Live per-turn logging (n8n webhook/event bus) — current approach is a retrospective report, which is what was asked.
- Dashboard/alerts — JSON output makes this easy to add later.
