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
node dev/build-workflows.mjs
node dev/build-main.mjs
node dev/bootstrap-creds.mjs
```

This creates your owner account, builds the 7 workflow JSONs, creates the credentials n8n needs (OpenAI API + Postgres for chat memory), patches the JSONs with the new credential ids, and deploys everything. Your login is printed at the end.

To use custom credentials, set env vars **before** running bootstrap — they only affect new accounts, not existing ones:

```bash
N8N_OWNER_EMAIL=you@example.com N8N_OWNER_PASSWORD=yourpass node dev/bootstrap-creds.mjs
```

> Adding `N8N_OWNER_EMAIL` / `N8N_OWNER_PASSWORD` to `.env` does **not** change an existing owner. Those vars are only read by the bootstrap script. To change credentials after setup, use n8n's forgot-password flow or wipe volumes and re-run bootstrap.

The OpenAI credential's Base URL is set to `https://api.commandcode.ai/provider/v1`. If you need a different provider, update it in the n8n editor (Credentials → OpenAI compatible Commandcode).

> **`N8N_INSTANCE_AI_MODEL_API_KEY` must be set** in `.env` for the agent to work. If it's empty, the bootstrap will tell you. Restart n8n after setting it: `docker compose -f docker-compose.yml -f docker-compose.dev.yml restart n8n`.

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
node dev/build-workflows.mjs
node dev/build-main.mjs
STORE_BASE_URL=https://perfectobd.com node dev/build-workflows.mjs
node dev/bootstrap-creds.mjs
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

## What's in here

| File | What it is |
|---|---|
| `docker-compose.yml` | Production stack — n8n, database, sandbox services |
| `docker-compose.dev.yml` | Local dev add-on — Meilisearch + host mapping |
| `.env.example` | Environment template — every variable documented |
| `dev/prompts.js` | All system prompts and tool descriptions |
| `dev/build-workflows.mjs` | Builds the 4 specialist + 2 tool workflows |
| `dev/build-main.mjs` | Builds the main agent workflow |
| `dev/bootstrap-creds.mjs` | Creates credentials and deploys all workflows on a fresh instance |
| `dev/deploy.mjs` | Deploys workflow JSONs (needs the original owner account) |
| `dev/eval-harness.mjs` | Eval battery — 10 test cases |
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

# 2. Rebuild + deploy
node dev/build-workflows.mjs && node dev/build-main.mjs
node dev/deploy.mjs dev/out/searchTool.json dev/out/productDetailTool.json   # prints tool ids
SEARCH_TOOL_ID=<id> DETAIL_TOOL_ID=<id> node dev/build-workflows.mjs        # rebuild with tool ids
node dev/deploy.mjs dev/out/searchTool.json dev/out/productDetailTool.json \
  dev/out/productDiscovery.json dev/out/supportSpecialist.json \
  dev/out/cartSpecialist.json dev/out/orderSpecialist.json dev/out/agentChat.json

# 3. Run the eval battery
node dev/eval-harness.mjs
```

> **Store host** is baked into tool nodes at build time. For a VPS build: `STORE_BASE_URL=https://perfectobd.com node dev/build-workflows.mjs`

> **Model** is also baked at build time, but the provider is an env choice: `MODEL_PROVIDER=gemini node dev/build-main.mjs` switches to Gemini. See `dev/model-config.mjs`.

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

# Local dev
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

---

## Safety

- This app only talks to the store over HTTP — it never writes to the store database directly.
- I will never run `pint` or auto-commit inside `fastmart-pro` (store rules from its `AGENTS.md`).
