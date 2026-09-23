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
| `N8N_INSTANCE_AI_MODEL_API_KEY` | your Command Code key (n8n Assistant only — the same key the `OpenAI compatible Commandcode` workflow credential holds) |

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
node dev/deploy.mjs dev/out/searchTool.json dev/out/productDetailTool.json   # prints both new tool workflow ids
SEARCH_TOOL_ID=<search id> DETAIL_TOOL_ID=<detail id> STORE_BASE_URL=https://perfectobd.com node dev/build-workflows.mjs
node dev/deploy.mjs dev/out/searchTool.json dev/out/productDetailTool.json dev/out/productDiscovery.json \
  dev/out/supportSpecialist.json dev/out/cartSpecialist.json dev/out/orderSpecialist.json dev/out/agentChat.json
```

This only works on an instance whose ids came from the restored DB — `dev/build-main.mjs` and `dev/deploy.mjs` reference specialist-workflow and credential ids by value. On a truly fresh instance (no restore) every id changes and you must import the 7 JSONs in the UI and recreate both credentials by hand.

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

> **Symptom if you skip the overlay:** n8n starts fine and the editor works, but every store tool fails with a connection error the agent may paraphrase as a business answer (e.g. *"I couldn't find order TEST…"*). Check from inside the container:
> `docker exec fastmart-n8n sh -c 'wget -qO- "http://fastmart-pro.test/api/v3/categories?parent_id=0" | head -c 80'`
> JSON back = fine; `Connection refused` = you started without `-f docker-compose.dev.yml`, so `fastmart-pro.test` resolves to the container's own loopback and never reaches the store. Fix: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d`.
>
> **The orphan warning is the same mistake, caught earlier.** `docker compose up -d` (base file only) in this directory prints *"Found orphan containers ([… fastmart-meilisearch])"* — the dev Meilisearch is not in the base file, so that invocation does not recognise it. The same base-only run recreates n8n **without** the `extra_hosts` mapping, which is the connection failure above. Confirm with `docker inspect fastmart-n8n --format '{{json .HostConfig.ExtraHosts}}'` — it must list `fastmart-pro.test:host-gateway`.
>
> If Meilisearch is also stopped (`docker compose ps --all` shows it `Exited`), every *keyword* search fails on top of that: the store's `/api/v4/products?keyword=` returns **HTTP 500** (Laravel Scout → Meilisearch), while the homepage grid keeps working because it lists from the DB with no keyword. So a product on the homepage can be missing from chat. The search tool reports that state as `SEARCH UNAVAILABLE …` rather than an empty result, so the agent says the search is down — it must never turn a failed search into "not in the catalogue". Both come back with the overlay command above.

## Spikes / widgets

- **Widget contract:** see `WIDGET-CONTRACT.md` — the JSON contract the React widget uses to talk to the n8n webhook (full-response wait; the store's own guest cart keyed by the widget's `conversation_id`). **Browser-verified** 2026-09-02 from the real widget page (`http://localhost:8000` → n8n executions 84–87). The widget fork is in `biz-buddy` (`resources/js/components/storefront/storefront-widget.tsx`): it POSTs to the n8n webhook by default (`window.__PERFECTO_CHAT_MODE='laravel'` reverts to the old SSE brain).
- **Standalone chat SPA (`perfecto-ai-demo.html`):** one self-contained file (Tailwind + Alpine via CDN, no build) that replaces the old simulated prototype — the brain is now the real n8n agent (`agent-chat (prod webhook)`, workflow id `oAlPFsGVYAlhZami`, webhook path `spike/agent-chat`). It POSTs `{message, conversation_id, profile}` to that webhook (full-response wait; `conversation_id`, the chat transcript **and** the panel's open state persist in `localStorage` under `perfecto_conversation_id` / `perfecto_chat_v1` / `perfecto_chat_open`, so a reload keeps the same agent memory, guest cart and visible history — only **↺ Reset session** starts a new one) and renders `reply` + all 9 `OutputBlock` types (including an `order-status` progress card that is built server-side **without** the customer's name/phone/email/address, so identity never reaches the browser). **The storefront is fully live too**: branding/contact come from the business-settings API, the nav is real categories, the grid is the real catalog (collections, category filter, sort, pagination), cards open a real product detail with variants, and the cart is the store's own guest cart (`tmp-*`), so qty/remove/add all hit the store, and the cart badge/panel is re-read from the store after every chat turn (the agent can change the cart without sending a `cart-table` block). If the store blocks the browser (CORS) it falls back to a small sample catalog so chat still works. Missing or broken images fall back to an inline placeholder. Every turn ends with an answer or an error bubble with **Try again** (a failed turn is never silently dropped — n8n's `{"message":"Error in workflow"}` body is valid JSON, so the SPA requires the contract shape before rendering). The 3-question skin quiz is sent as `profile`. Config via `window.__PERFECTO_N8N_CHAT_WEBHOOK` and `window.__PERFECTO_STORE_BASE`. Serve over **http://localhost** (not `file://` or `https`): `npx --yes http-server -p 8080 .` → `http://localhost:8080/perfecto-ai-demo.html`. This matters — a `file://` or `https` page is a secure context, so the browser **blocks** its `http://` calls as mixed content, and every store/cart request shows as blocked in the Network tab while the chat may still work. Open the DevTools console: the SPA logs the precise cause (`never left the browser` vs `HTTP nnn`) and the page origin. Hosting is not wired yet (planned: `/assistant/` on `ai.perfectobd.com`).
- **Step 5 status:** workflow `agent-chat` is active in n8n; webhook URL is shown in the Webhook node's **Production URL** field (currently `http://localhost:5678/webhook/spike/agent-chat`). Run `node scratchpad-verify.mjs` to fire the test chats again. To apply a changed `wf4-agent-chat.json`: import/PATCH in the n8n editor, then re-activate so the published version runs it (see spike-checklist gotchas).
- **Re-import after editing `wf4-agent-chat.json`:** open the workflow in n8n → menu (⋮) → Import from File → pick the JSON → Save → toggle **Active** off and on (this re-publishes; a bare Save only updates the draft).

> Note: the existing n8n Public API key is scoped to `workflow:list` only. Importing workflows needs an **owner** action (Web UI import, or a new owner-scoped API key) — that's deliberate, not a bug.

---

## What's in here

| File | Purpose |
|---|---|
| `docker-compose.yml` | **Production stack** — n8n, its Postgres, and the n8n Assistant (sandbox + SearXNG + the Gemini signature proxy, which is kept but unused now the model runs on Command Code). `docker compose up -d` is the whole deploy |
| `docker-compose.dev.yml` | **Local-dev overlay** — adds the dev-only Meilisearch and the `fastmart-pro.test` host mapping, and opts back into plain HTTP. Never used on a server |
| `.env.example` | Env template (production-shaped; local overrides documented at the bottom) |
| `PLAN.md` | Full plan + progress tracking |
| `spike-checklist.md` | 2-week de-risk spike |
| `WIDGET-CONTRACT.md` | Widget ⇄ n8n webhook contract (final) |
| `dev/build-workflows.mjs` | Builds the 4 specialist sub-workflows + the slim `tool-search-products` and `tool-product-detail` tools → `dev/out/*.json` |
| `dev/build-main.mjs` | Builds the main agent-chat workflow → `dev/out/agentChat.json` |
| `dev/deploy.mjs` | Upserts + activates workflows into live n8n (owner JWT) |
| `dev/n8n-admin.mjs` | n8n REST admin helper (list/get/create/update/activate/execs) |
| `dev/prompts.js` | All system prompts + tool descriptions (single source) |
| `dev/eval-harness.mjs` | External eval battery — 10 cases, grades real behavior |
| `dev/prod-bench.mjs` | Production-readiness benchmark — latency/turn, concurrency ramp, cost/turn |
| `dev/build-collector.mjs` | Builds the **`token-usage collector`** workflow — reads n8n's own Postgres and writes one row per LLM call into the `token_usage` Data Table |
| `dev/token-cost.mjs` | Renders the `token_usage` Data Table as `token-cost.html` (datatable + totals footer) |
| `token-cost.html` | **Generated** token-cost datatable — re-run `dev/token-cost.mjs` to refresh |
| `wf4-agent-chat.json` / `wf5-test-bucket.json` | Spike-era workflow snapshots (superseded by `dev/build-*`) |
| `scratchpad-verify.mjs` | Quick webhook smoke test |
| `perfecto-ai-demo.html` | **Standalone chat SPA** — one self-contained file (Tailwind + Alpine via CDN, no build). POSTs to the agent-chat webhook and reads the live store API. Serve over HTTP, not `file://` |

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
| `N8N_INSTANCE_AI_MODEL` / `_API_KEY` / `_URL` | `custom/deepseek/deepseek-v4.1-flash` on `https://api.commandcode.ai/provider/v1` | n8n Assistant's model, set from `.env` only — switching it is an edit + `docker compose up -d`, no rebuild. **Must be prefixed `custom/`**: instance-ai reads the text before the first `/` as an n8n provider name, and `deepseek` is one n8n ships, so a bare `deepseek/deepseek-v4.1-flash` is stripped to `deepseek-v4.1-flash` and rejected by the gateway. `_URL` is required for `custom/` (its baseURL); empty = the provider's own address (OpenRouter is built in; Command Code is not) |
| `GENERIC_TIMEZONE` / `TZ` | `Asia/Dhaka` | Business timezone |
| `MEILI_MASTER_KEY` | *(empty)* | **Dev overlay only** — the local store's search backend |

> Pinned in `docker-compose.yml`, not settable from `.env`: `NODE_FUNCTION_ALLOW_BUILTIN=http,https,util,path,url,zlib,crypto,stream,events` (task runners are always on in n8n 2+, and this is the setting that grants the Code nodes `require('http')` — verified working on 2.40.5), `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (Code nodes read `$env.STORE_BASE_URL`), and `N8N_RUNNERS_TASK_TIMEOUT=300` (n8n 3 shortens the default to 60s — see below).

## Upgrading n8n

`docker-compose.yml` pins the n8n image to the **`latest`** tag — n8n's `stable` channel (`2.40.5` at time of writing). `pull` is therefore the whole upgrade, but the tag also moves to **3.0.x by itself** when n8n ships it, so re-read the deprecation report on every pull:

```bash
docker compose pull n8n
docker compose up -d n8n            # recreates only n8n; Postgres keeps its data
docker logs fastmart-n8n | head -40 # migrations + the deprecation report
```

Want a bump to be a deliberate act instead? Pin an exact tag in compose (`:2.41.0`, `:v3-rc-20260921`) and change it by hand.

Each start prints a **deprecation report** naming the config v3 will change — that report is the authoritative checklist for *this* instance, not this table. Everything it can act on is already handled:

| v3 breaking change | Status here |
|---|---|
| Docker-only self-hosting | Already Docker (`docker compose up -d`) |
| `N8N_RUNNERS_ENABLED` removed | Dropped from compose — runners are always on since 2.0, and the Code nodes' `require('http')` still works |
| `N8N_RUNNERS_TASK_TIMEOUT` default 300s → 60s | Set to `300` in compose, so the blocks Code node keeps its ceiling |
| `~/.n8n/binaryData` → `~/.n8n/storage` | Nothing to do — the volume mounts `~/.n8n`, the parent of both |
| Removed nodes (Function, Item Lists, Cron, legacy OpenAI, SerpApi, …) | Unused |
| AI Agent v1 modes removed | Already the v2 Tools Agent |
| `$getPairedItem`, `$evaluateExpression` removed | Unused |
| Sub-workflow Local File/URL sources and the "Any workflow" caller policy removed | Tool nodes use the `database` source; no caller policy set |
| Chat Trigger WebSocket frames become JSON | Not used — the widget calls the plain webhook |
| `N8N_UNVERIFIED_PACKAGES_ENABLED` defaults false; Compression limits lowered | No community packages, no Compression node |

Two known, accepted warnings: the internal task runner mode is deprecated (fine for a single instance; move to the `n8nio/runners` image in external mode if you ever scale out), and the Python runner fails to start because the image has no Python (we only use JavaScript Code nodes).

After any version bump, re-run `node scratchpad-verify.mjs` and `node dev/eval-harness.mjs` before trusting it.

## Day-to-day dev loop

```bash
# 1. Edit prompts/tools in dev/prompts.js or the build scripts
# 2. Rebuild + deploy everything (the two tool sub-workflows have their own ids):
node dev/build-workflows.mjs && node dev/build-main.mjs
node dev/deploy.mjs dev/out/searchTool.json dev/out/productDetailTool.json   # print their ids on first run
#   on a fresh instance, rebuild with those ids so the specialist's tool nodes point at them:
#   SEARCH_TOOL_ID=<id> DETAIL_TOOL_ID=<id> node dev/build-workflows.mjs
node dev/deploy.mjs dev/out/searchTool.json dev/out/productDetailTool.json dev/out/productDiscovery.json \
  dev/out/supportSpecialist.json dev/out/cartSpecialist.json dev/out/orderSpecialist.json dev/out/agentChat.json

# 3. Run the eval battery (10 cases, ~3 min, exit 0 = green):
node dev/eval-harness.mjs                 # or --group cart / --out report.json
```

> The two tool sub-workflows are the exception to "the ids are already in the repo" — a restore to a new instance mints new ids, so deploy `searchTool.json` and `productDetailTool.json`, read the ids they print, and rebuild `productDiscovery.json` with `SEARCH_TOOL_ID=<id> DETAIL_TOOL_ID=<id>` before deploying the rest.

> The store host is **baked into the tool nodes at build time** (`STORE` in `dev/prompts.js`). The Code nodes (cart context, blocks/price-guard) read `$env.STORE_BASE_URL` at runtime, but the tool nodes do not. For a VPS build, prefix both build commands with `STORE_BASE_URL=https://<live-store>` and redeploy.

> The **model node is baked at build time, but the provider is an env choice, not a code edit** — `dev/model-config.mjs` holds one descriptor per provider and both builders read it. For Command Code the built graph is `lmChatOpenAi` + `openAiApi`, and the **endpoint comes from the credential's own Base URL field** (`https://api.commandcode.ai/provider/v1`), never from `.env`:
>
> ```bash
> node dev/build-main.mjs                               # Command Code (default)
> MODEL_PROVIDER=gemini node dev/build-main.mjs          # n8n's own Google Gemini node
> MODEL_PROVIDER=openrouter MODEL_CRED_ID=xxx \
>   MODEL_CRED_NAME=OpenRouter node dev/build-main.mjs   # any other OpenAI-compatible gateway
> MODEL=google/gemini-3.7-flash node dev/build-main.mjs  # same provider, different model
> ```
>
> Unlike the Assistant, the workflows still need a rebuild **and** `dev/deploy.mjs` for the change to land — and editing the model in the n8n UI is silently overwritten by the next deploy. `MODEL_CRED_ID` / `MODEL_CRED_NAME` exist because n8n credential ids are per-instance (the ids in `model-config.mjs` are this instance's).

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
- Model price basis sits at the top of the file (`--price-in/--price-out` to override). ⚠ The built-in defaults are still the old `gemini-3.7-flash` list rate — the workflows now run `deepseek/deepseek-v4.1-flash`, so pass both flags (or update the constants) or the cost column is meaningless. The latency baseline below was also measured on Gemini and has not been re-measured for the new model: measured 2026-09-08 (local, dev store) all-turn median ~5.8s / p90 ~8.5s, clean through 10 concurrent chats, ~$0.004 per full turn.
- Cart scenarios write real `tmp-bench-*` guest carts then remove them, like eval-harness. Point it at a **live** store only when you accept that (or skip cart via a short run — see `--phase`).

## Token usage & cost

Every LLM call's real token usage is collected into the **`token_usage` Data Table** (one row per call), which `dev/token-cost.mjs` renders as `token-cost.html` — a single-file datatable with a totals footer.

```bash
node dev/build-collector.mjs && node dev/deploy.mjs dev/out/tokenCollector.json   # build + activate (once)
curl -X POST http://localhost:5678/webhook/metrics/collect-tokens                 # ingest now
node dev/token-cost.mjs                                                           # refresh token-cost.html
```

The collector **runs every 5 minutes** and on demand via that webhook, so a fresh turn can take up to ~5 minutes to appear. `{"ingested":N}` means N call-rows were written; `{"ingested":0,"note":"nothing new to ingest"}` is a normal idle run. Runs are visible in n8n's executions list (success **and** failure), so a gap is diagnosable.

**Why a collector and not a node in the agent graph.** n8n keeps per-call usage on the model node's `ai_languageModel` connection, but nothing *inside the run* can read it. Verified on n8n 2.40.5 with a throwaway probe workflow — from the node after the agent, every accessor fails:

| Accessor | Result |
|---|---|
| `$('OpenAI Chat Model').first().json` | `No data found from 'main' input` |
| `$('OpenAI Chat Model').all()` | `No data found from 'main' input` |
| `$items('OpenAI Chat Model')` | `No data found from 'main' input` |
| `$node['OpenAI Chat Model'].json` | `No data found from 'main' input` |
| `$('AI Agent').first().json.tokenUsage` | `null` — the Agent emits only `output`, `intermediateSteps` |

So the collector reads n8n's **own** Postgres (`execution_entity` + `execution_data`), decodes the flatted run data, and inserts the rows. Its cursor (last ingested execution id) lives in the workflow's static data. It needs a Postgres credential for the `fastmart_n8n` database — `n8n Postgres (metrics, read-only)`, id `aDuHo9mivsM8kd9Z`. That is n8n's own DB, **not** the store's.

`token_usage` columns: `execution_id`, `parent_execution_id`, `conversation_id`, `workflow_name`, `run_mode`, `node_name`, `call_index`, `prompt_tokens`, `completion_tokens`, `total_tokens`, `started_at`. A specialist sub-execution has no conversation of its own, so it carries `parent_execution_id` and `dev/token-cost.mjs` resolves it to the parent's conversation before rendering.

> ⚠ **`POST {"full": true}` re-ingests from zero and does not de-duplicate — it duplicates rows.** To rebuild the table, clear it first (n8n → Data Tables → `token_usage` → Clear), then clear the workflow's static data (or re-save the workflow), then send `{"full": true}`.
>
> The cursor advances when a batch is *decoded*, not when it is written, so if the insert itself fails that batch's rows are skipped for good — repair the same way.

**Measuring what one webhook call costs** — clear the rows but **leave the cursor alone**, or the next run re-ingests the whole history and refills the table. Single-line, so it survives paste:

```bash
docker exec fastmart-n8n-postgres psql -U n8n -d fastmart_n8n -c 'DELETE FROM "data_table_user_HMfSB3bn9yzerRbr"'
```
```bash
curl -s -X POST http://localhost:5678/webhook/spike/agent-chat -H "Content-Type: application/json" -d "{\"message\":\"find me face serums\",\"conversation_id\":\"tmp-costcheck-1\"}"
```
```bash
curl -s -X POST http://localhost:5678/webhook/metrics/collect-tokens
```
```bash
node dev/token-cost.mjs
```

Clear the rows, make one call, ingest it (or wait up to 5 min for the schedule) — with the table otherwise empty, its footer total **is** that call's cost. Expect ~3k tokens for a greeting, ~6k for a normal turn, and ~28k for a multi-step cart flow: one turn is several LLM calls (orchestrator + each specialist), which is exactly what the per-call rows make visible. Only *workflow* calls are counted — the n8n Assistant's own model usage is not recorded here.

Three gotchas found the hard way while building this — they cost real debugging time, so:

- **`saveDataSuccessExecution: 'none'` is a trap here.** It was set to avoid re-storing the run data the collector reads. But n8n never finalises an execution it isn't saving, so every run sat in `running` with `finished=false` **forever**, and every *working* run was invisible — a healthy collector looked identical to a dead one. It is now `'all'`.
- **n8n merges workflow settings on update.** Deleting a key from `settings` in `dev/build-collector.mjs` and redeploying does **not** clear it in n8n — the built JSON omitted `saveDataSuccessExecution` while the DB still reported `'none'` until it was set explicitly to `'all'`.
- **A webhook with `responseMode: 'lastNode'` fails on an empty batch.** An idle run ended with zero items, so n8n threw *"No item to return was found"* (HTTP 500). The decoder now always emits one item, an `If` routes idle batches straight to a `Report` node, and the run reports `{"ingested":0}`.

First full ingest, checked against an independent full-resolve decode of the same executions (2026-09-22): **0 mismatches** on execution count, call count and token totals (298 executions / 626 calls / 2,953,736 tokens at the time of the check). `dev/prod-bench.mjs` still computes its own cost column from a price constant; the Data Table is the token-accurate source.

## Store access (HTTP API only)

Workflows call the store at `STORE_BASE_URL`:

- **Primary API:** `/api` (v3) — cart, orders, checkout
- **Products:** `/api/v4` (latest, unified products + gift offers)
- **Client:** n8n `HTTP Request` nodes / custom tools

No store DB credentials are used in n8n. This keeps one consistent, portable path local → VPS. Meilisearch is the *store's* search backend, never called from n8n directly — that is why the production stack ships without one.

**The SPA uses the same `STORE_BASE_URL` API surface, from the browser.** Verified endpoints:

| Purpose | Call |
|---|---|
| Branding + contact | `GET /api/v3/business-settings?q=website_name,header_logo,footer_logo,system_logo_white,site_icon,contact_phone,contact_email,contact_address,topbar_banner,topbar_banner_link,site_url` |
| Nav categories | `GET /api/v3/categories?parent_id=0` (+ `products_count`) |
| Grid / search / filter / sort / page | `GET /api/v4/products?type=…&category_id=…&keyword=…&sort=…&limit=24&page=N` → `{data, meta:{total,last_page}}`. `type` = `newArrivals\|featured\|bestSeller\|todaysDeal\|discounted`; `sort` = `latest\|oldest\|price_low_high\|price_high_low\|rating\|popularity` |
| Product detail | `GET /api/v3/products/{id}` (photos, description, tags) |
| Variants | `GET /api/v4/products/variants?product_id={id}` |
| Quiz options | `GET /api/v3/skin-concerns` |
| Cart read | `POST /api/v3/carts/{user_id}` |
| Cart add | `POST /api/v3/carts/add?user_id=&id=&quantity=&variant=` |
| Cart qty | `POST /api/v3/carts/change-quantity` `{id,quantity,user_id}` |
| Cart remove | `DELETE /api/v3/carts/{lineId}?user_id=` |

Two gotchas this surfaced: the `is_guest_user` middleware derives `user_field` (`temp_user_id`) from a `tmp*` **`user_id`** param, so every cart call must carry `user_id`; and product image paths are **relative** (`uploads/all/x.jpg`) while business-settings `image_url` is absolute — the SPA absolutizes relative paths and falls back to an inline placeholder when an image is missing or 404s. Avoid `/api/v3/products/search` and `/api/v3/brands` — they currently 500 with a PHP deprecation dump (use `/api/v4/products?keyword=` instead).

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
