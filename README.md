# fastmart-ai

Standalone **n8n** app for the Perfecto AI Shopping Assistant — the AI chat brain that talks to the live Perfecto store over its HTTP API.

This is a **separate app** from `biz-buddy`. It does not share biz-buddy's Postgres/Redis stack. See `PLAN.md` for the full plan and progress tracking.

---

## Deploy (production)

`docker-compose.yml` is the production stack and needs no editing — no panel-specific YAML, no per-host tweaks.

```bash
git clone <this-repo-url> /www/wwwroot/ai.perfectobd.com
cd /www/wwwroot/ai.perfectobd.com
cp .env.example .env      # then fill the values in the table below
docker compose up -d
```

**Filling `.env`.** Every variable is documented in the file itself; these are the ones you must set before `up`:

| Var | Set to |
|---|---|
| `N8N_HOST` | `ai.perfectobd.com` |
| `STORE_BASE_URL` | `https://perfectobd.com` |
| `POSTGRES_PASSWORD` | a **new** password for n8n's own database — nothing to match, so `openssl rand -hex 32` is ideal (the loop below fills it). Set it once; changing it later locks n8n out |
| `N8N_ENCRYPTION_KEY` | ⚠ **copy, don't generate** — take the exact value from your existing instance's `.env` (your local `fastmart-ai/.env`). Step 3 restores a DB whose credentials are encrypted with that key, so a fresh value here makes them permanently unreadable. The fill loop deliberately skips this one |
| `N8N_USER_MANAGEMENT_JWT_SECRET` | `openssl rand -hex 32` |
| `SANDBOX_API_KEYS` | `openssl rand -hex 32` |
| `SANDBOX_API_RUNNER_REGISTRATION_TOKEN` | `openssl rand -hex 32` |
| `SANDBOX_API_RUNNER_API_KEY` | `openssl rand -hex 32` |
| `SEARXNG_SECRET` | `openssl rand -hex 32` |
| `N8N_INSTANCE_AI_MODEL_API_KEY` | your Google AI Studio key (n8n Assistant only) |

Generate every random in one go:

```bash
for v in N8N_USER_MANAGEMENT_JWT_SECRET SANDBOX_API_KEYS \
         SANDBOX_API_RUNNER_REGISTRATION_TOKEN SANDBOX_API_RUNNER_API_KEY \
         SEARXNG_SECRET POSTGRES_PASSWORD; do
  sed -i "s|^$v=.*|$v=$(openssl rand -hex 32)|" .env
done
```

Run that **once, before the first `up`**. Do not re-run it against a live deployment: it regenerates every secret, which breaks the sandbox auth (`SANDBOX_API_KEYS`) and the database connection (`POSTGRES_PASSWORD`).

Leave the rest as the template has it — `N8N_PROTOCOL=https`, `N8N_SECURE_COOKIE=true`, `N8N_BIND=127.0.0.1`, `N8N_ENABLED_MODULES` and the two timezones are already correct for production.

Check nothing required is still blank — any line this prints is unfilled:

```bash
grep -nE '^(N8N_ENCRYPTION_KEY|N8N_USER_MANAGEMENT_JWT_SECRET|SANDBOX_API_KEYS|SANDBOX_API_RUNNER_REGISTRATION_TOKEN|SANDBOX_API_RUNNER_API_KEY|SEARXNG_SECRET|POSTGRES_PASSWORD|N8N_HOST|STORE_BASE_URL)=$' .env
```

> Missing secrets do not fail loudly at `up`. A blank `SANDBOX_API_KEYS` breaks the sandbox healthcheck, and n8n waits on that dependency — so the symptom is n8n silently never starting.

That gets the containers running. These five steps get it *serving*:

**1. Site + TLS** — aaPanel → Website → Add Site `ai.perfectobd.com` (no PHP, no DB) → SSL → Let's Encrypt → Force HTTPS.

> Issue the certificate **before** first login. `N8N_SECURE_COOKIE=true` over plain HTTP redirect-loops the login.

**2. Reverse proxy** — Website → Reverse Proxy → target `http://127.0.0.1:5678`, then add to the generated config:

```nginx
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 300s;
```

The first three carry n8n's UI push; without them the editor goes stale. `proxy_read_timeout` matters because a webhook stays open for the whole agent turn (~6s median, ~30s worst case) and nginx's default would 504 mid-answer.

Because the repo sits in the webroot, also add:

```nginx
location ~ /\.(?!well-known) { deny all; }
location = /.env { deny all; }
```

**3. Move the workflows in.** n8n keeps workflows **and their credentials** in its own encrypted Postgres — a fresh install has none and the widget gets 404s. Restore a dump from an existing instance (reuse that instance's `N8N_ENCRYPTION_KEY` in `.env` or it will not decrypt):

```bash
# on the machine that has the working instance
docker exec fastmart-n8n-postgres pg_dump -U n8n fastmart_n8n > n8n-backup.sql

# upload n8n-backup.sql to the VPS, then there:
cat n8n-backup.sql | docker exec -i fastmart-n8n-postgres psql -U n8n fastmart_n8n
docker restart fastmart-n8n
```

Log in with your **existing** owner email/password — do not run owner signup, the restored DB already has one. All workflows restore inactive, and their tool nodes still carry the old store host baked in, so rebuild against the live store and redeploy (needs Node 20+ on the VPS):

```bash
STORE_BASE_URL=https://perfectobd.com node dev/build-workflows.mjs
STORE_BASE_URL=https://perfectobd.com node dev/build-main.mjs
node dev/deploy.mjs dev/out/productDiscovery.json dev/out/supportSpecialist.json \
  dev/out/cartSpecialist.json dev/out/orderSpecialist.json dev/out/agentChat.json
```

This only works on an instance whose ids came from the restored DB — `dev/build-main.mjs` and `dev/deploy.mjs` reference specialist-workflow and credential ids by value. On a truly fresh instance (no restore) every id changes and you must import the 5 JSONs in the UI and recreate both credentials by hand.

**4. Point the widget at it.** On the live store:

```js
window.__PERFECTO_N8N_CHAT_WEBHOOK = 'https://ai.perfectobd.com/webhook/spike/agent-chat';
```

Rollback is `window.__PERFECTO_CHAT_MODE = 'laravel'` (back to the old SSE brain).

**5. Verify, then lock down.**

```bash
node dev/eval-harness.mjs --webhook https://ai.perfectobd.com/webhook/spike/agent-chat \
  --store https://perfectobd.com --out vps-eval.json     # expect pass=10 fail=0
```

- aaPanel → Security: 80/443 open, **5678 closed**. Confirm from outside: `curl -m 3 http://<vps-ip>:5678/` must time out.
- Cron → daily: `docker exec fastmart-n8n-postgres pg_dump -U n8n fastmart_n8n | gzip > /www/backup/n8n-$(date +\%F).sql.gz`

Two things that will bite otherwise:

- The VPS must be **KVM/Xen** — the sandbox runner is `privileged` and starts its own Docker daemon, which fails under OpenVZ/LXC. Check with `systemd-detect-virt`.
- The panel usually already runs the live store's Meilisearch on 7700. The production compose ships none for exactly that reason, so `docker compose up -d` cannot collide.

> **Not aaPanel?** Any TLS-terminating proxy works — delete steps 1–2 and run Caddy instead:
> `docker run -d --name caddy --restart unless-stopped -p 80:80 -p 443:443 -v $PWD/Caddyfile:/etc/caddy/Caddyfile -v caddy_data:/data caddy:2`
> with `ai.perfectobd.com { reverse_proxy 127.0.0.1:5678 }`.

## Quick start (local)

Local dev needs two things the production stack deliberately omits — the dev-only Meilisearch and the `fastmart-pro.test` host mapping. Both live in `docker-compose.dev.yml`:

```bash
cp .env.example .env      # then apply the "LOCAL DEV OVERRIDES" block at the bottom
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

# http://localhost:5678 — first visit completes owner signup
```

Your workflows live in the `n8n_data` volume.

## Spikes / widgets

- **Widget contract:** see `WIDGET-CONTRACT.md` — the JSON contract the React widget uses to talk to the n8n webhook (full-response wait; the store's own guest cart keyed by the widget's `conversation_id`). **Browser-verified** 2026-09-02 from the real widget page (`http://localhost:8000` → n8n executions 84–87). The widget fork is in `biz-buddy` (`resources/js/components/storefront/storefront-widget.tsx`): it POSTs to the n8n webhook by default (`window.__PERFECTO_CHAT_MODE='laravel'` reverts to the old SSE brain).
- **Step 5 status:** workflow `agent-chat` is active in n8n; webhook URL is shown in the Webhook node's **Production URL** field (currently `http://localhost:5678/webhook/spike/agent-chat`). Run `node scratchpad-verify.mjs` to fire the test chats again. To apply a changed `wf4-agent-chat.json`: import/PATCH in the n8n editor, then re-activate so the published version runs it (see spike-checklist gotchas).
- **Re-import after editing `wf4-agent-chat.json`:** open the workflow in n8n → menu (⋮) → Import from File → pick the JSON → Save → toggle **Active** off and on (this re-publishes; a bare Save only updates the draft).

> Note: the existing n8n Public API key is scoped to `workflow:list` only. Importing workflows needs an **owner** action (Web UI import, or a new owner-scoped API key) — that's deliberate, not a bug.

---

## What's in here

| File | Purpose |
|---|---|
| `docker-compose.yml` | **Production stack** — n8n, its Postgres, and the n8n Assistant (sandbox + SearXNG + Gemini signature proxy). `docker compose up -d` is the whole deploy |
| `docker-compose.dev.yml` | **Local-dev overlay** — adds the dev-only Meilisearch and the `fastmart-pro.test` host mapping, and opts back into plain HTTP. Never used on a server |
| `.env.example` | Env template (production-shaped; local overrides documented at the bottom) |
| `PLAN.md` | Full plan + progress tracking |
| `spike-checklist.md` | 2-week de-risk spike |
| `WIDGET-CONTRACT.md` | Widget ⇄ n8n webhook contract (final) |
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
| `N8N_HOST` | `localhost` | Public hostname n8n serves on. Drives the webhook URLs, so it must be the browser-resolvable name |
| `N8N_PROTOCOL` / `N8N_SECURE_COOKIE` | `https` / `true` | Fail-safe production defaults; local dev overrides to `http` / `false` |
| `N8N_BIND` / `N8N_PORT` | `127.0.0.1` / `5678` | Host interface + port. Loopback by default so only the reverse proxy can reach n8n |
| `N8N_ENCRYPTION_KEY` | *(empty)* | **Required.** 32-byte hex, encrypts stored credentials. Set once, never change — and reuse it when migrating or a restored DB will not decrypt |
| `N8N_USER_MANAGEMENT_JWT_SECRET` | *(empty)* | Required. Cookie signing only, safe to regenerate |
| `STORE_BASE_URL` | `https://example.com` | Base URL for ALL store API calls. Read at runtime by the Code nodes; **baked into the tool nodes at build time** (see Day-to-day dev loop) |
| `POSTGRES_*` | n8n defaults | n8n's own DB (never the store DB) |
| `SANDBOX_API_KEYS`, `SANDBOX_API_RUNNER_*`, `SEARXNG_SECRET` | *(empty)* | n8n Assistant secrets — `openssl rand -hex 32` each |
| `N8N_INSTANCE_AI_MODEL` / `_API_KEY` / `_URL` | `gemini-3.7-flash` via `gemini-sig-proxy` | n8n Assistant's model. `_URL` empty = the provider's own address (OpenRouter is built in) |
| `GENERIC_TIMEZONE` / `TZ` | `Asia/Dhaka` | Business timezone |
| `MEILI_MASTER_KEY` | *(empty)* | **Dev overlay only** — the local store's search backend |

> Pinned in `docker-compose.yml`, not settable from `.env`: `N8N_RUNNERS_ENABLED=false` (runners strip `require('http')` from Code nodes, which the cart context + blocks need), `NODE_FUNCTION_ALLOW_BUILTIN=http,https,url`, and `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (Code nodes read `$env.STORE_BASE_URL`).

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

> The store host is **baked into the tool nodes at build time** (`STORE` in `dev/prompts.js`). The Code nodes (cart context, blocks/price-guard) read `$env.STORE_BASE_URL` at runtime, but the tool nodes do not. For a VPS build, prefix both build commands with `STORE_BASE_URL=https://<live-store>` and redeploy.

## Production benchmark

`dev/prod-bench.mjs` measures how `agent-chat` will behave in production — per-turn latency, how many concurrent chats it survives, and token cost per full turn (from n8n's own Postgres metrics, so it includes the child specialist executions, not just the orchestrator).

```bash
# Local baseline (latency + ramp 1,2,5,10, ~6 min):
node dev/prod-bench.mjs --out bench-local.json

# VPS at go-live — run ON the VPS host so cost decoding reads the VPS n8n DB:
node dev/prod-bench.mjs --webhook https://ai.perfectobd.com/webhook/spike/agent-chat \
  --store https://perfectobd.com --force-db --out bench-vps.json
```

- Cost decode auto-turns off unless the webhook is `localhost` **or** `--force-db` is set (it reads the `fastmart-n8n-postgres` container). Latency/load still report without it.
- Model price basis sits at the top of the file (`--price-in/--price-out` to override; default is the paid list rate for `gemini-3.7-flash`). Measured baseline 2026-09-08 (local, dev store): all-turn median ~5.8s / p90 ~8.5s, clean through 10 concurrent chats, ~$0.004 per full turn.
- Cart scenarios write real `tmp-bench-*` guest carts then remove them, like eval-harness. Point it at a **live** store only when you accept that (or skip cart via a short run — see `--phase`).

## Store access (HTTP API only)

Workflows call the store at `STORE_BASE_URL`:

- **Primary API:** `/api` (v3) — cart, orders, checkout
- **Products:** `/api/v4` (latest, unified products + gift offers)
- **Client:** n8n `HTTP Request` nodes / custom tools

No store DB credentials are used in n8n. This keeps one consistent, portable path local → VPS. Meilisearch is the *store's* search backend, never called from n8n directly — that is why the production stack ships without one.

> **Guest cart:** Whether logged-out cart works depends on the store API auto-creating a guest user. This is verified in the spike (`spike-checklist.md`, Step 2). If it doesn't, a thin **guest-cart bridge** on the store is planned (store already has CSRF off + an `is_guest_user` middleware, so that stays small).

## Commands

```bash
# production
docker compose up -d                 # start
docker compose ps                    # status

# local dev — adds Meilisearch + the fastmart-pro.test host mapping
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

docker compose logs -f n8n           # n8n logs
docker compose down                  # stop
docker compose down -v               # stop + wipe volumes (careful)
```

## Safety

- This app only ever talks to the store over HTTP API — it never writes to the store DB directly.
- I will **never** run `pint` or auto-commit inside `fastmart-pro` (store repo rules from its `AGENTS.md`).
