# Production benchmark — local baseline (2026-09-08)

Tool: `dev/prod-bench.mjs` · session `bmtslbmcv` · raw JSON in `prod-local-2026-09-08.json`
Target: local n8n `agent-chat` webhook, dev store, **paid** Gemini key, cost decode from n8n Postgres (full turn = orchestrator + child specialists).
Price basis: `gemini-3.7-flash`, input $0.75 / output $3.75 per 1M.

**48/48 turns clean — 0 timeouts, 0 HTTP errors, no Gemini 429s.**

## Latency by scenario (serial, 3 reps; median / p90 wall-clock)

| Scenario | med | p90 | tokens/turn | avg cost/turn |
|---|---|---|---|---|
| Greeting | 1.5s | 1.8s | ~1,729 | ~$0.0014 |
| Memory recall | 1.9s | 2.1s | ~1,922 | ~$0.0016 |
| Support policy | 5.1s | 5.3s | ~4,155 | ~$0.0035 |
| Order track | 5.8s | 5.9s | ~4,942 | ~$0.0042 |
| Bengali reply | 5.7s | 6.3s | ~4,526 | ~$0.0043 |
| Product search | 7.3s | 7.4s | ~7,275 | ~$0.0061 |
| Cart flow (add/view/remove) | 7.7s | 11.8s | ~7,212 | ~$0.0059 |
| **All turns** | **5.8s** | **8.5s** | | |

## Concurrency ramp

| Concurrent chats | ok | wall (all done) | median latency | errors |
|---|---|---|---|---|
| 1 | 1/1 | 7.2s | 7.2s | 0 |
| 2 | 2/2 | 5.4s | 5.4s | 0 |
| 5 | 5/5 | 8.9s | 6.4s | 0 |
| 10 | 10/10 | 10.1s | 6.8s | 0 |

Clean through 10 concurrent chats; median latency holds ~5–7s. n8n default production concurrency (10) is not the binding constraint at this load; the paid key showed no throttling.

## Cost

- Measured total (30 latency + 18 ramp turns): **$0.196** → **≈ $0.004 per full turn** (~৳0.5).
- Projection at the heavier real mix: ~**$4 / 1,000 chats / month** (real mixes run cheaper — greetings are ~$0.0014).

## How to re-run

```bash
# local (baseline above)
node dev/prod-bench.mjs --out bench-local.json

# VPS at go-live — run ON the VPS host so cost reads the VPS n8n DB
node dev/prod-bench.mjs --webhook https://ai.<domain>/webhook/spike/agent-chat \
  --store <live-store-url> --force-db --out bench-vps.json
```

Compare the VPS report against this file: live store + HTTPS + network distance will shift the numbers.

## Caveats

- Cart scenarios write real `tmp-bench-*` guest carts (then remove them) — same pattern as `eval-harness.mjs`.
- Costs are estimates: n8n-recorded tokens × list rates; actual Google bill can differ.
- This baseline is against the **dev** store over localhost — production numbers need the VPS run.
