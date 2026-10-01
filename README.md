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

### 4. Build and deploy everything

```bash
node dev/bootstrap-creds.mjs      # first run only: creates owner + credentials
node dev/sync.mjs                 # build + deploy all 7 workflows
```

Your login is printed by `bootstrap-creds.mjs`. To choose your own, set them **before** running it:

```bash
N8N_OWNER_EMAIL=you@example.com N8N_OWNER_PASSWORD=yourpass node dev/bootstrap-creds.mjs
```

> Adding `N8N_OWNER_EMAIL` / `N8N_OWNER_PASSWORD` to `.env` does **not** change an existing owner — only the bootstrap script reads them. To change credentials later, use n8n's forgot-password flow or wipe volumes and re-run bootstrap.

> `N8N_INSTANCE_AI_MODEL_API_KEY` must be set in `.env` or the agent won't work. After changing it, recreate the container — see [Which provider to use](#which-provider-to-use).

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

## Deploy changes to production (safe runbook)

`sync.mjs` is the deploy command. It resolves every credential and workflow id from the **target instance**, deploys in dependency order, then verifies every reference before reporting success. This runbook wraps it in backup + smoke-test steps.

### Pre-deploy (run on the VPS)

```bash
cd /www/wwwroot/ai.perfectobd.com
git pull

# 1. back up the database BEFORE touching anything
docker exec fastmart-n8n-postgres pg_dump -U n8n fastmart_n8n | gzip > /www/backup/n8n-pre-deploy-$(date +%F-%H%M).sql.gz
ls -lh /www/backup/n8n-pre-deploy-*.sql.gz | tail -1   # confirm it's there

# 2. check the env (a stale STORE_BASE_URL bakes the wrong host into every tool node)
grep -E '^(STORE_BASE_URL|N8N_HOST|N8N_INSTANCE_AI_MODEL_API_KEY)=' .env

# 3. verify-only — catches bad credentials / missing workflows WITHOUT deploying
STORE_BASE_URL=https://perfectobd.com node dev/sync.mjs --check
```

`--check` resolves credentials by name and reads every workflow id from the instance, then reports whether the built main workflow's references all resolve. If it passes, the deploy is safe.

### Deploy

```bash
STORE_BASE_URL=https://perfectobd.com node dev/sync.mjs
```

Last line should be `verify OK: 6 tool references + 2 credentials resolve on this instance`. Anything else means the deploy stopped before the broken workflow was activated.

### Post-deploy smoke tests

```bash
# 5. verify the webhook is live and the agent answers correctly
node dev/eval-harness.mjs --webhook https://ai.perfectobd.com/webhook/spike/agent-chat \
  --store https://perfectobd.com
# expect pass=14  fail=0  (or only the 1 search-dependent soft warn)

# 6. spot-check one workflow in the n8n UI — is it active and does its node graph look right?
node dev/read-wf.mjs "agent-chat (prod webhook)"
# id, nodes and connections should match what you expect; active=true
```

### If something broke

```bash
# restore the pre-deploy snapshot
docker exec -i fastmart-n8n-postgres psql -U n8n fastmart_n8n < /www/backup/n8n-pre-deploy-*.sql.gz
docker compose restart n8n
```

The restore brings back the old workflows, credentials (encrypted with the same `N8N_ENCRYPTION_KEY`), memory tables, data tables, and canvas groups. The webhook keeps responding immediately — n8n doesn't need a rebuild, it re-reads the DB on start.

### What survives a redeploy vs. what doesn't

| Artifact | Survives redeploy | Survives DB restore |
|---|---|---|
| Workflows (all 7) | yes — patch by name | yes (restored) |
| Credentials (encrypted) | yes | yes (same `N8N_ENCRYPTION_KEY`) |
| Chat memory (`chat_memory_fastmart`) | yes | yes |
| Token-usage Data Table | yes | yes |
| Execution history | yes | yes |
| Canvas groups (n8n UI layout) | yes — self-healed by deploy.mjs | yes |
| Owner account | yes | yes |

Nothing is lost by a redeploy; `sync.mjs` is a patch, not a wipe. The only destructive operation is `docker compose down -v` (wipes the volume).

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
| `N8N_INSTANCE_AI_MODEL_API_KEY` | Model provider API key — the provider depends on `N8N_INSTANCE_AI_MODEL_URL` | *(required)* |

The `custom/` prefix on the model id (`N8N_INSTANCE_AI_MODEL`) selects the provider. n8n splits the id at the first `/`, uses the head as a provider name and sends **only the part after the slash** to the endpoint — `custom/gemini-3.5-flash-lite` reaches the model server as `gemini-3.5-flash-lite`.

### Which provider to use

Pick the head that matches your **key's issuer**. The part after the `/` is passed to the endpoint untouched, so any model name works.

| Provider | `N8N_INSTANCE_AI_MODEL` | `N8N_INSTANCE_AI_MODEL_URL` | Key |
|---|---|---|---|
| **Gemini** | `custom/gemini-3.5-flash-lite` | `http://gemini-sig-proxy:8017/v1` | Google AI Studio |
| **Command Code** | `custom/deepseek/deepseek-v4.1-flash` | `https://api.commandcode.ai/provider/v1` | Command Code (`user_…`) |
| **OpenAI** | `openai/gpt-5.4` | *(empty)* | OpenAI (`sk-…`) |
| **Anthropic** | `anthropic/claude-sonnet-5-5` | *(empty)* | Anthropic (`sk-ant-…`) |
| **OpenRouter** | `openrouter/google/gemini-2.5-pro` | *(empty)* | OpenRouter (`sk-or-…`) |

```bash
# e.g. the Gemini route
N8N_INSTANCE_AI_MODEL=custom/gemini-3.5-flash-lite
N8N_INSTANCE_AI_MODEL_URL=http://gemini-sig-proxy:8017/v1
N8N_INSTANCE_AI_MODEL_API_KEY=<Google AI Studio key>
```

**Gemini notes.** Use the sig-proxy, not Google directly: Gemini 3 attaches a `thought_signature` to every tool call and the OpenAI-compatible client drops it, so the second turn of any multi-step tool call fails. The model id must be **bare** — Google's API rejects `google/gemini-…` with `404`, since that namespace belongs to the Command Code catalog.

**Command Code notes.** Keep the `google/` or `deepseek/` namespace in the tail; the gateway requires it. Without `custom/`, n8n sees a registered `deepseek` provider, routes through `@ai-sdk/deepseek`, and sends the stripped `deepseek-v4.1-flash` — which the gateway rejects.

**OpenAI / Anthropic / OpenRouter notes.** No `custom/`: each provider's native SDK supplies its own baseURL and adds its native tool calling, structured outputs and endpoint handling. A key from one provider returns `401` at another — that is never a `custom/` problem.

#### After editing `.env`

`.env` is read by `docker compose` **when a container is created**, not while it runs — the container holds a frozen copy. A plain `restart` reuses that copy, so the edit silently does nothing.

```bash
# applies locally and on production alike
docker compose up -d --force-recreate n8n

# always verify — this catches a silently-ignored edit
docker exec fastmart-n8n printenv | grep N8N_INSTANCE_AI
```

Some values aren't reachable through `.env` at all:

| Value | Reached by |
|---|---|
| Container env (`N8N_INSTANCE_AI_*`, `STORE_BASE_URL`, `N8N_HOST`) | edit `.env` + recreate |
| `${VAR:-default}` entries in `docker-compose.yml` | edit `.env` + recreate |
| Hardcoded in `docker-compose.yml` (`NODE_FUNCTION_ALLOW_BUILTIN`, `N8N_BLOCK_ENV_ACCESS_IN_NODE`, `N8N_RUNNERS_TASK_TIMEOUT`) | **edit the compose file** — it wins over `.env` |
| Workflow nodes with the host baked in | `MODEL=... STORE_BASE_URL=... node dev/sync.mjs` |
| n8n credentials / admin model | **change in the n8n UI** — DB settings override env |

> `dev/sync.mjs` and the smoke tests read `.env` directly at run time, so they pick up edits with no recreate. If the container env is right but the Assistant still uses the old provider, a stored credential is overriding it — check Credentials → `AI Assistant model`.

### Changing the model

The model reaches the system two different ways, so they need different steps:

| What | Gets the model from | To change it |
|---|---|---|
| **n8n Assistant** (chat panel) | `.env` | edit `.env`, then recreate + verify (above) |
| **agent-chat workflows** | baked in at build time | `MODEL=<model> STORE_BASE_URL=https://perfectobd.com node dev/sync.mjs` |

> The workflows read the endpoint from the credential's **Base URL** field, not `.env` — switching providers means changing that field too (n8n editor → Credentials).

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

Common commands:

```bash
docker compose ps                      # what's running
docker compose logs -f n8n             # follow n8n logs
docker compose down                    # stop
docker compose down -v                 # stop + wipe volumes (destructive)
```

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

## Troubleshooting

**A `.env` edit seems to be ignored.** The container keeps a frozen copy of the env from when it was created. Recreate, don't restart — see [After editing `.env`](#after-editing-env).

**The Assistant fails but the model works when tested directly.** Almost always a provider/key mismatch — a key from one provider returns `401` at another. Check `N8N_INSTANCE_AI_MODEL_URL` and the key's issuer, and look for a credential overriding the env (n8n → Credentials → `AI Assistant model`).

**Postgres rejects the password after changing it.** The password is baked into the volume on first run; editing `.env` doesn't update it. Only affects a broken *first* start — `down -v` then `up -d` (destructive).

**Meilisearch won't start after a restart.** Docker remembers the network ID a container was created on. If the network was destroyed and recreated under the same name, the container is orphaned and `docker start` fails with `network <old-id> not found`:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --force-recreate meilisearch
```

**Search index is empty after a restart** (`/indexes` returns `results: []`). Product data needs re-indexing from the store database — run the store's `search:sync` artisan command from the `fastmart-pro` repo.

**A deploy broke the workflows.** Restore the pre-deploy snapshot — see [If something broke](#if-something-broke).

---

## Safety

- This app only talks to the store over HTTP — it never writes to the store database directly.
- Never run `pint` or auto-commit inside `fastmart-pro` (store rules from its `AGENTS.md`).
