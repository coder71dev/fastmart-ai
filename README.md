# fastmart-ai

Standalone **n8n** app for the Perfecto AI Shopping Assistant — the AI chat brain that talks to the live Perfecto store over its HTTP API.

This is a **separate app** from `biz-buddy`. It does not share biz-buddy's Postgres/Redis stack. See `PLAN.md` for the full plan and progress tracking.

---

## Quick start (local)

```bash
# 1. Copy the env template
cp .env.example .env

# 2. Edit .env — set N8N_ENCRYPTION_KEY and STORE_BASE_URL
#    (STORE_BASE_URL = your local Perfecto URL, e.g. http://perfecto.ddev.site)

# 3. Start n8n + its own Postgres
docker compose up -d

# 4. Open n8n
#    http://localhost:5678
```

First launch: complete the owner-account signup in the browser (n8n user management). Your workflows live in `n8n_data` (volume).

## Spikes / widgets

- **Widget contract:** see `WIDGET-CONTRACT.md` — the JSON contract the React widget uses to talk to the n8n webhook (full-response wait; the store's own guest cart keyed by the widget's `conversation_id`). **Browser-verified** 2026-09-02 from the real widget page (`http://localhost:8000` → n8n executions 84–87). The widget fork is in `biz-buddy` (`resources/js/components/storefront/storefront-widget.tsx`): it POSTs to the n8n webhook by default (`window.__PERFECTO_CHAT_MODE='laravel'` reverts to the old SSE brain).
- **Step 5 status:** workflow `agent-chat` is active in n8n; webhook URL is shown in the Webhook node's **Production URL** field (currently `http://localhost:5678/webhook/spike/agent-chat`). Run `node scratchpad-verify.mjs` to fire the test chats again. To apply a changed `wf4-agent-chat.json`: import/PATCH in the n8n editor, then re-activate so the published version runs it (see spike-checklist gotchas).
- **Re-import after editing `wf4-agent-chat.json`:** open the workflow in n8n → menu (⋮) → Import from File → pick the JSON → Save → toggle **Active** off and on (this re-publishes; a bare Save only updates the draft).

> Note: the existing n8n Public API key is scoped to `workflow:list` only. Importing workflows needs an **owner** action (Web UI import, or a new owner-scoped API key) — that's deliberate, not a bug.

---

## What's in here

| File | Purpose |
|---|---|
| `docker-compose.yml` | n8n + its own Postgres + Meilisearch (standalone) |
| `.env.example` | Env template |
| `PLAN.md` | Full plan + progress tracking |
| `spike-checklist.md` | 2-week de-risk spike |
| `WIDGET-CONTRACT.md` | Widget ⇄ n8n webhook contract (final) |
| `DEPLOY-VPS.md` | Part 3 runbook — VPS, HTTPS, widget cutover |
| `dev/build-workflows.mjs` | Builds the 4 specialist sub-workflows → `dev/out/*.json` |
| `dev/build-main.mjs` | Builds the main agent-chat workflow → `dev/out/agentChat.json` |
| `dev/deploy.mjs` | Upserts + activates workflows into live n8n (owner JWT) |
| `dev/n8n-admin.mjs` | n8n REST admin helper (list/get/create/update/activate/execs) |
| `dev/prompts.js` | All system prompts + tool descriptions (single source) |
| `dev/eval-harness.mjs` | External eval battery — 10 cases, grades real behavior |
| `dev/prod-bench.mjs` | Production-readiness benchmark — latency/turn, concurrency ramp, cost/turn |
| `wf4-agent-chat.json` / `wf5-test-bucket.json` | Spike-era workflow snapshots (superseded by `dev/build-*`) |
| `scratchpad-verify.mjs` | Quick webhook smoke test |

## Environment variables (key ones)

| Var | Default | Meaning |
|---|---|---|
| `STORE_BASE_URL` | `https://example.com` | Base URL for ALL store API calls from workflows (portable local → VPS) |
| `N8N_ENCRYPTION_KEY` | *(empty)* | **Required for production** — set a stable 32-byte hex |
| `N8N_SECURE_COOKIE` | `false` | `true` behind HTTPS |
| `N8N_RUNNERS_ENABLED` | `false` | **Keep `false`** — task runners strip `require('http')` from Code nodes, which the cart context + blocks need |
| `NODE_FUNCTION_ALLOW_BUILTIN` | *(set in compose)* | Must include `http,https,url` — lets Code nodes make store HTTP calls (sandbox has no `$helpers`/`fetch`) |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | `false` | Code nodes read `$env.STORE_BASE_URL` |
| `N8N_PORT` / `N8N_HOST` / `N8N_PROTOCOL` | `5678` / `localhost` / `http` | How n8n is served |
| `POSTGRES_*` | n8n defaults | n8n's own DB (never the store DB) |
| `GENERIC_TIMEZONE` / `TZ` | `Asia/Dhaka` | Business timezone |

## Day-to-day dev loop

```bash
# 1. Edit prompts/tools in dev/prompts.js or the build scripts
# 2. Rebuild + deploy everything:
node dev/build-workflows.mjs && node dev/build-main.mjs
node dev/deploy.mjs dev/out/productDiscovery.json dev/out/supportSpecialist.json \
  dev/out/cartSpecialist.json dev/out/orderSpecialist.json dev/out/agentChat.json

# 3. Run the eval battery (10 cases, ~3 min, exit 0 = green):
node dev/eval-harness.mjs                 # or --group cart / --out report.json
```

## Production benchmark

`dev/prod-bench.mjs` measures how `agent-chat` will behave in production — per-turn latency, how many concurrent chats it survives, and token cost per full turn (from n8n's own Postgres metrics, so it includes the child specialist executions, not just the orchestrator).

```bash
# Local baseline (latency + ramp 1,2,5,10, ~6 min):
node dev/prod-bench.mjs --out bench-local.json

# VPS at go-live — run ON the VPS host so cost decoding reads the VPS n8n DB:
node dev/prod-bench.mjs --webhook https://ai.your-domain.com/webhook/spike/agent-chat \
  --store https://your-store.com --force-db --out bench-vps.json
```

- Cost decode auto-turns off unless the webhook is `localhost` **or** `--force-db` is set (it reads the `fastmart-n8n-postgres` container). Latency/load still report without it.
- Model price basis sits at the top of the file (`--price-in/--price-out` to override; default is the paid list rate for `gemini-3.7-flash`). Measured baseline 2026-09-08 (local, dev store): all-turn median ~5.8s / p90 ~8.5s, clean through 10 concurrent chats, ~$0.004 per full turn.
- Cart scenarios write real `tmp-bench-*` guest carts then remove them, like eval-harness. Point it at a **live** store only when you accept that (or skip cart via a short run — see `--phase`).

## Store access (HTTP API only)

Workflows call the store at `STORE_BASE_URL`:

- **Primary API:** `/api` (v3) — cart, orders, checkout
- **Products:** `/api/v4` (latest, unified products + gift offers)
- **Client:** n8n `HTTP Request` nodes / custom tools

No store DB credentials are used in n8n. This keeps one consistent, portable path local → VPS.

> **Guest cart:** Whether logged-out cart works depends on the store API auto-creating a guest user. This is verified in the spike (`spike-checklist.md`, Step 2). If it doesn't, a thin **guest-cart bridge** on the store is planned (store already has CSRF off + an `is_guest_user` middleware, so that stays small).

## Production / VPS (Part 3 of PLAN.md)

- Put this repo on the VPS next to the live Perfecto store.
- Run n8n behind a **reverse proxy** (Caddy/nginx) with **HTTPS** (required for WhatsApp/Messenger webhooks).
- Set `N8N_SECURE_COOKIE=true`, a real `N8N_ENCRYPTION_KEY`, and firewall n8n to internal/HTTPS.
- Back up `n8n_data` and `postgres_data` volumes.

## Commands

```bash
docker compose up -d                 # start
docker compose ps                    # status
docker compose logs -f n8n           # n8n logs
docker compose down                  # stop
docker compose down -v               # stop + wipe volumes (careful)
```

## Safety

- This app only ever talks to the store over HTTP API — it never writes to the store DB directly.
- I will **never** run `pint` or auto-commit inside `fastmart-pro` (store repo rules from its `AGENTS.md`).