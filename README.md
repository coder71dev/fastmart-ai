# fastmart-ai

An **n8n** app that powers the Perfecto AI Shopping Assistant. It talks to the live Perfecto store over its HTTP API — no direct database access. See [PLAN.md](PLAN.md) for the full build history.

---

## Quick start (local)

Get from zero to a working agent in 4 steps.

### 1. Copy the environment file and generate passwords

```bash
cp .env.example .env
```

**PowerShell (Windows):**

```powershell
$keys = @('N8N_ENCRYPTION_KEY','N8N_USER_MANAGEMENT_JWT_SECRET','SANDBOX_API_KEYS','SANDBOX_API_RUNNER_REGISTRATION_TOKEN','SANDBOX_API_RUNNER_API_KEY','SEARXNG_SECRET','POSTGRES_PASSWORD')
$env = Get-Content .env -Raw
foreach ($k in $keys) { $env = $env -replace "(?m)^$k=.*", "$k=$(openssl rand -hex 32)" }
Set-Content .env $env -NoNewline
```

**Bash (Linux/macOS):**

```bash
for v in N8N_ENCRYPTION_KEY N8N_USER_MANAGEMENT_JWT_SECRET SANDBOX_API_KEYS \
         SANDBOX_API_RUNNER_REGISTRATION_TOKEN SANDBOX_API_RUNNER_API_KEY \
         SEARXNG_SECRET POSTGRES_PASSWORD; do
  sed -i "s|^$v=.*|$v=$(openssl rand -hex 32)|" .env
done
```

Run this once, before the first start. Do not re-run against a live setup — it replaces every password.

### 2. Apply local dev settings

Open `.env` and change these 4 lines (near the bottom):

```
N8N_HOST=localhost
N8N_PROTOCOL=http
N8N_SECURE_COOKIE=false
STORE_BASE_URL=http://fastmart-pro.test
```

### 3. Start n8n

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

Wait about 20 seconds for n8n to finish its first-run migrations.

> **First start failed?** Fix `.env` then `docker compose -f docker-compose.yml -f docker-compose.dev.yml down -v` and `up -d` again. Postgres bakes the password into its volume on first run — changing `.env` alone doesn't update it.

### 4. Build and deploy everything

```bash
node dev/bootstrap-creds.mjs      # first time only: creates the owner + credentials
node dev/sync.mjs                 # build + deploy all 7 workflows
```

`bootstrap-creds.mjs` is a first-run script (it creates the owner account and the credentials). `sync.mjs` is the everyday command: it deploys in dependency order, reads each workflow's real id back from the instance, and verifies every reference before reporting success. Your login is printed by `bootstrap-creds.mjs`.

To use custom credentials, set env vars **before** running bootstrap — they only affect new accounts, not existing ones:

```bash
N8N_OWNER_EMAIL=you@example.com N8N_OWNER_PASSWORD=yourpass node dev/bootstrap-creds.mjs
```

> Adding `N8N_OWNER_EMAIL` / `N8N_OWNER_PASSWORD` to `.env` does **not** change an existing owner. Those vars are only read by the bootstrap script. To change credentials after setup, use n8n's forgot-password flow or wipe volumes and re-run bootstrap.

The OpenAI credential's Base URL is set to `https://api.commandcode.ai/provider/v1`. If you need a different provider, update it in the n8n editor (Credentials → OpenAI compatible Commandcode).

> **`N8N_INSTANCE_AI_MODEL_API_KEY` must be set** in `.env` for the agent to work. If it's empty, the bootstrap will tell you. After changing it, recreate the container: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d n8n` — a `restart` reuses the old environment and silently keeps the stale value.

### What just happened

The stack runs 7 containers: **n8n** (the workflow engine), **Postgres** (its database), **Meilisearch** (the store's search backend, dev only), **SearXNG** (web search for the AI), and 3 sandbox containers (secure code execution for the AI assistant).

The 7 workflows are: a main **agent-chat** webhook that routes customer messages to 4 specialist sub-workflows (product discovery, cart, orders, support), plus 2 tool workflows (slim search + product detail) that the specialists call.

---

## Deploy to production

```bash
git clone <this-repo-url> /www/wwwroot/ai.perfectobd.com
cd /www/wwwroot/ai.perfectobd.com
cp .env.example .env
```

Generate passwords (same as local), then set these production values:

| Variable | Set to |
|---|---|
| `N8N_HOST` | `ai.perfectobd.com` |
| `STORE_BASE_URL` | `https://perfectobd.com` |
| `N8N_INSTANCE_AI_MODEL_API_KEY` | your Command Code API key |

> **N8N_ENCRYPTION_KEY** — copy from your existing `.env` (don't generate) if you're restoring a database backup. The encrypted credentials in the backup need this exact key.

Start and bootstrap:

```bash
docker compose up -d
node dev/bootstrap-creds.mjs
STORE_BASE_URL=https://perfectobd.com node dev/sync.mjs
```

Point the widget: `window.__PERFECTO_N8N_CHAT_WEBHOOK = 'https://ai.perfectobd.com/webhook/spike/agent-chat';`

Reverse proxy: point `ai.perfectobd.com` at `http://127.0.0.1:5678`. Add these headers:

```nginx
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 300s;
```

Lock down: close port 5678 from outside. Set up a daily backup:

```bash
docker exec fastmart-n8n-postgres pg_dump -U n8n fastmart_n8n | gzip > /www/backup/n8n-$(date +\%F).sql.gz
```

> **VPS must be KVM/Xen** — the sandbox runner starts its own Docker daemon, which fails under OpenVZ/LXC.

---

## Deploy changes to production

After you `git pull` new code, redeploy **on the VPS** (the deploy scripts talk to `localhost:5678` and read the owner from n8n's DB, so they only work on the n8n host):

```bash
cd /www/wwwroot/ai.perfectobd.com
git pull
STORE_BASE_URL=https://perfectobd.com node dev/sync.mjs
```

That one command is the whole deploy. It builds and deploys in dependency order (tool sub-workflows → specialists → main agent), **reads every workflow id back from the instance** and injects it into the next build, resolves credentials by name, then verifies that every tool reference and credential resolves before reporting success. Nothing to paste, and nothing silently pointing at the wrong workflow.

```bash
node dev/sync.mjs --check     # verify only, deploy nothing
```

**If it fails, it fails before reporting success** — a bad tool id or missing credential is a hard error, not a broken production chat.

<details>
<summary>Manual steps (only if you are not using sync.mjs)</summary>

```bash
STORE_BASE_URL=https://perfectobd.com node dev/build-workflows.mjs
STORE_BASE_URL=https://perfectobd.com node dev/build-main.mjs
node dev/deploy.mjs dev/out/searchTool.json dev/out/productDetailTool.json dev/out/productDiscovery.json \
  dev/out/supportSpecialist.json dev/out/cartSpecialist.json dev/out/orderSpecialist.json dev/out/agentChat.json
```

`dev/deploy.mjs` matches workflows **by name** and re-activates them, so it overwrites the old versions in place. It refuses to create a workflow whose name is new (a rename would orphan every id pointing at it) — pass `ALLOW_NEW_WORKFLOW=1` if you really mean it.

Because the builders cannot know your instance's ids, the manual path needs them passed in, or the orchestrator will point at workflows that don't exist:

```bash
SEARCH_TOOL_ID=<id> DETAIL_TOOL_ID=<id> node dev/build-workflows.mjs
PRODUCT_DISCOVERY_ID=<id> SUPPORT_SPECIALIST_ID=<id> \
  CART_SPECIALIST_ID=<id> ORDER_SPECIALIST_ID=<id> \
  PG_CRED_ID=<id> MODEL_CRED_ID=<id> node dev/build-main.mjs
```

`node dev/read-wf.mjs "agent-chat (prod webhook)"` prints a workflow's id, nodes and connections straight from the API — the quickest way to get those values.
</details>

> **Deploy auth** — both scripts find the owner themselves (`roleSlug = 'global:owner'` in n8n's DB), so the same command works locally and on the VPS. Override with `N8N_OWNER_ID=<uuid>`.

Verify it landed:

```bash
node dev/eval-harness.mjs --webhook https://ai.perfectobd.com/webhook/spike/agent-chat \
  --store https://perfectobd.com    # expect pass=10 fail=0
```

### Changing the model on production

The model reaches the system two different ways — they need different steps:

| What | Gets the model from | To change it |
|---|---|---|
| **n8n Assistant** (the chat panel) | `.env` only | edit `.env`, then `docker compose up -d n8n` |
| **agent-chat workflows** | baked in at build time | rebuild + `dev/deploy.mjs` |

```bash
# n8n Assistant — .env edit, then RECREATE the container
docker compose up -d n8n
docker exec fastmart-n8n printenv | grep N8N_INSTANCE_AI   # verify
```

> `docker compose restart n8n` reuses the environment the container was **created** with, so it silently keeps the old value. Use `up -d` (or `--force-recreate`). If the env is right but the Assistant still uses the old provider, a stored credential is overriding it — check Credentials → `AI Assistant model` in the n8n editor.

```bash
# the workflows — rebuild and redeploy
STORE_BASE_URL=https://perfectobd.com node dev/build-main.mjs
node dev/deploy.mjs dev/out/agentChat.json
```

> The workflows read the endpoint from the credential's **Base URL** field, not `.env`. Switching providers means changing that field too (n8n editor → Credentials).

---

## What's in here

| File | What it is |
|---|---|
| `docker-compose.yml` | Production stack — n8n, database, sandbox services |
| `docker-compose.dev.yml` | Local dev add-on — Meilisearch + host mapping |
| `.env.example` | Environment template — every variable documented |
| `dev/prompts.js` | All system prompts and tool descriptions |
| `dev/build-workflows.mjs` | Builds the 4 specialist + 2 tool workflows |
| `dev/build-main.mjs` | Builds the main agent workflow |
| `dev/sync.mjs` | **The deploy command** — build + deploy in dependency order, resolving every id from the instance, then verify |
| `dev/read-wf.mjs` | Prints a workflow's real id, nodes and connections from the n8n API |
| `dev/bootstrap-creds.mjs` | First run only: creates the owner account and credentials |
| `dev/deploy.mjs` | Deploys workflow JSONs (auto-detects the n8n owner) |
| `dev/eval-harness.mjs` | Eval battery — 14 test cases (`--group hitl` for the human-in-the-loop ones) |
| `dev/prod-bench.mjs` | Latency and token cost benchmark |
| `dev/model-config.mjs` | Swap models without editing workflow code |
| `dev/build-collector.mjs` | Builds the token-usage collector workflow |
| `dev/token-cost.mjs` | Renders token usage as an HTML report |
| `perfecto-ai-demo.html` | Standalone chat SPA — one file, no build |
| `PLAN.md` | Full build history |

---

## Environment variables

`.env.example` documents every variable. The important ones:

| Variable | What it does | Default |
|---|---|---|
| `N8N_HOST` | Public hostname for webhooks | `ai.perfectobd.com` |
| `N8N_PROTOCOL` | `http` locally, `https` in production | `https` |
| `N8N_SECURE_COOKIE` | `false` locally, `true` behind HTTPS | `true` |
| `STORE_BASE_URL` | Where the store API lives | `https://example.com` |
| `N8N_ENCRYPTION_KEY` | Encrypts n8n credentials — set once, never change | *(required)* |
| `POSTGRES_PASSWORD` | n8n's database password — set once, never change | *(required)* |
| `N8N_INSTANCE_AI_MODEL_API_KEY` | Command Code API key for the agent | *(required)* |

The `custom/` prefix on the model id (`N8N_INSTANCE_AI_MODEL`) is required — without it, n8n strips the namespace and the gateway rejects the model.

---

## Day-to-day development

```bash
# 1. Edit prompts or tools in dev/prompts.js or the build scripts

# 2. Rebuild + deploy (one command, handles all the ids)
node dev/sync.mjs

# 3. Run the eval battery
node dev/eval-harness.mjs
```

> **Store host** is baked into the tool nodes at build time. For a VPS build: `STORE_BASE_URL=https://perfectobd.com node dev/sync.mjs`

> **Model** is baked at build time, but the provider is an env choice: `MODEL_PROVIDER=gemini node dev/sync.mjs` switches to Gemini. See `dev/model-config.mjs`.

`sync.mjs` exists because the builders cannot know your instance's ids. It deploys each workflow, reads the id n8n assigned it, and passes that into the next build — so tool ids, specialist ids and credential ids are always this instance's, and it verifies every reference before it says "done". Deploying a hand-built JSON without it is what produces a 500 in the widget (`Error in workflow`) and `Error in sub-node PG Memory`.

---

## Store API reference

| Purpose | Endpoint |
|---|---|
| Categories | `GET /api/v3/categories?parent_id=0` |
| Products | `GET /api/v4/products?keyword=…&category_id=…&sort=…&page=N` |
| Product detail | `GET /api/v3/products/{id}` |
| Variants | `GET /api/v4/products/variants?product_id={id}` |
| Cart read | `POST /api/v3/carts/{user_id}` |
| Cart add | `POST /api/v3/carts/add?user_id=&id=&quantity=&variant=` |
| Cart qty | `POST /api/v3/carts/change-quantity` |
| Cart remove | `DELETE /api/v3/carts/{lineId}?user_id=` |

---

## Commands

```bash
# Production
docker compose up -d
docker compose ps
docker compose logs -f n8n
docker compose down
docker compose down -v              # wipes volumes

# Local dev (adds Meilisearch + host mapping for fastmart-pro.test)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

> **Meilisearch won't start after a restart?** Docker remembers the network ID a container was created on. If the network was destroyed and recreated (same name, new ID) — by a `docker compose down` or a host restart — the container is orphaned: `docker start` fails with `network <old-id> not found`. Fix:
> ```bash
> docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --force-recreate meilisearch
> ```
> If the search index is empty after restart (`/indexes` returns `results: []`), the product data needs re-indexing from the store database — run the store's `search:sync` artisan command from the `fastmart-pro` repo.

---

## Safety

- This app only talks to the store over HTTP — it never writes to the store database directly.
- I will never run `pint` or auto-commit inside `fastmart-pro` (store rules from its `AGENTS.md`).
