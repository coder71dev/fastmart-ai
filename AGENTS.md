# AGENTS.md — fastmart-ai

Guidance for any AI agent (or future session of this one) working in this repo.
For setup/deploy mechanics, see [README.md](README.md). For full build history
and the reasoning behind each decision, see [PLAN.md](PLAN.md). For the exact
webhook request/response shape, see [WIDGET-CONTRACT.md](WIDGET-CONTRACT.md).
This file is the "how to think about this repo" layer — read it first.

---

## 1. What this is

An **n8n** app that is the AI brain for the Perfecto BD shopping assistant — a
beauty e-commerce chatbot in Bangladesh (prices in ৳ Taka). It is **not** a
normal codebase: the actual product is a set of **n8n workflows** (JSON graphs
of nodes), and the `.mjs` files in `dev/` are *generators* that build those
JSON graphs and deploy them into a running n8n instance over its REST API.

```
Customer ──► React widget / perfecto-ai-demo.html ──► n8n webhook (agent-chat)
                                                            │
                                               orchestrator (AI Agent node)
                                                            │
                          ┌─────────────┬──────────────┬───┴──────┬─────────────┐
                    product_discovery  cart_specialist  order_mgmt  support_specialist
                     (sub-workflow)     (sub-workflow)  (sub-workflow) (sub-workflow)
                                                            │
                                            all of it talks HTTP to the live
                                            Perfecto store API — never a DB
```

This app **never touches the store's database directly** — everything goes
through the store's HTTP API (`STORE_BASE_URL`). That boundary is intentional
and load-bearing; don't add a DB connection to the store as a shortcut.

---

## 2. The one rule that matters most: **the n8n UI is not the source of truth, the repo is**

It is *possible* to open the n8n editor and hand-edit a node. **Don't, except
for a scoped hotfix you immediately port back into `dev/build-main.mjs` /
`dev/build-workflows.mjs` / `dev/prompts.js` in the same session.** Every time
this has been skipped, it has caused a real, hard-to-see production bug:

- **2026-09-28** (documented in [PLAN.md](PLAN.md)): a redeploy left
  production half-wired — instance-specific credential/workflow ids were
  hardcoded in the builders, so a rebuilt workflow pointed at ids that didn't
  exist on that instance. Symptom: `Error in sub-node PG Memory`, every
  specialist tool call dead. Fixed by making `dev/sync.mjs` resolve every id
  **by name, on the target instance**, never by a copied literal.
- **2026-10-12** (this session): someone hand-patched the live workflow in
  the n8n UI to fix a real bug (`user_id` became required) but never ported
  it back to `dev/build-main.mjs`. In the same hand-editing session, a typo
  (`'number'))` — one stray extra `)`) was introduced into the `cart-add`
  tool's URL. n8n expressions **fail silently** on a bad parse — the HTTP
  call just returned nothing, no error. The agent kept confidently telling
  customers "I've added it to your cart!" while the add silently did
  nothing, for hours, because nothing in the chain surfaces a failed
  expression as a visible error. A second hand-edit also replaced the full
  system prompt with a stripped-down draft that was missing the
  variant-picker / approval / cart-task instructions entirely — degrading
  the live assistant without anyone noticing, since nothing failed loudly.

**Takeaway:** n8n's expression language and the AI Agent/tool wrapper both
swallow failures quietly. A broken node does not necessarily error — it can
just silently do nothing while the LLM, unaware, narrates success anyway.
**Never trust the model's reply text alone as proof an action worked** — see
§5 (testing).

---

## 3. How a change actually ships

```bash
# 1. Edit the SOURCE, never the n8n canvas directly:
#    dev/prompts.js        — system prompts, tool descriptions
#    dev/build-main.mjs    — the main agent-chat workflow (orchestrator, memory, response-shaping)
#    dev/build-workflows.mjs — the 4 specialists + 2 store-facing tool workflows
#    dev/model-config.mjs  — which model / provider

# 2. Rebuild + deploy — ALWAYS this one command, never dev/deploy.mjs alone:
node dev/sync.mjs

# 3. Prove it actually works (not just that it deployed):
node dev/eval-harness.mjs
```

`dev/sync.mjs` exists specifically to prevent the class of bug in §2: it
deploys workflows in dependency order (tools → specialists → main), resolves
every credential and sub-workflow id **by name** on whatever instance it's
pointed at, reads back the real id n8n assigned, feeds that into the next
build, and then **verifies every reference resolves** before declaring
success. `node dev/deploy.mjs <file.json>` by itself only upserts one file
with whatever ids are already baked into it — fine for a scoped, deliberate
hotfix (see §4), wrong as your normal workflow.

`node dev/sync.mjs --check` verifies without deploying — run this before any
production deploy (see README's "safe runbook").

---

## 4. When you *do* need to patch the live instance directly

Sometimes (debugging a live incident, as in this session) you need to fix a
node in a running instance before you have time to go through the full
rebuild path, or you specifically don't want a full rebuild to also change
things that aren't part of the fix (e.g. swapping the model). That's fine —
but do it **surgically**, and **port it back to the repo in the same
session**:

1. Export the live workflow's current `name` / `nodes` / `connections` /
   `settings` straight from Postgres (`workflow_entity` table — see
   `dev/read-wf.mjs` for the read-only version, or query directly via
   `docker exec -i fastmart-n8n-postgres psql -U n8n -d fastmart_n8n`).
2. Edit **only** the one field you mean to change in that JSON.
3. `node dev/deploy.mjs <patched.json>` — it matches by workflow *name* and
   PATCHes, so this updates the existing workflow in place, same id.
4. Make the equivalent edit in the `dev/build-*.mjs` source so the next
   `sync.mjs` run doesn't silently revert your fix.
5. Update `dev/eval-harness.mjs` / `dev/prod-bench.mjs` / anything else that
   calls the webhook if the contract changed (see §6).

Never hand-edit in the n8n UI and walk away without doing step 4 — that is
exactly how both incidents in §2 happened.

---

## 5. Testing: don't trust the reply text, check what actually happened

- `node dev/eval-harness.mjs` — the real test suite, 14 cases, run against a
  live webhook. `--group hitl` for the human-in-the-loop (variant-picker /
  approval) flows specifically. `--store <url>` to point its own direct
  store checks at wherever the target n8n instance's `STORE_BASE_URL`
  actually points (it does **not** infer this — pass it explicitly, or its
  cart-read assertions will fail against the wrong store).
- A "FAIL" isn't automatically a real bug. This session hit two false
  positives: a test only recognizing `product-grid` blocks when the agent
  legitimately also uses `product-carousel`, and a test product that's
  genuinely out of stock in the current catalog. Always manually `curl` the
  exact failing case and read the full response before concluding something
  is broken.
- When checking whether an action (cart-add, etc.) really happened, don't
  stop at the model's prose reply. Check the **blocks** array (e.g. does a
  `cart-table` block appear with the item actually in it?), or — when
  debugging deeper — pull the raw execution from n8n's Postgres and look at
  the tool call's actual `observation` string. An empty observation with a
  confident reply is the signature of exactly the silent-failure pattern in
  §2.
- Manual test request (every call needs `user_id` and, as of 2026-10-14, an
  `Authorization: Bearer` token — see §6):
  ```bash
  curl -s -X POST http://localhost:5678/webhook/spike/agent-chat \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token — see dev/create-webhook-jwt-cred.mjs>" \
    -d '{"message": "find me a serum", "user_id": "tmp-test-123"}'
  ```

---

## 6. The webhook contract — key facts (full spec in WIDGET-CONTRACT.md)

- `POST {N8N_BASE_URL}/webhook/spike/agent-chat`
- **`Authorization: Bearer <token>` is REQUIRED** (as of 2026-10-14) — JWT
  Auth on the Webhook node, a static shared secret (`N8N_WEBHOOK_JWT_SECRET` /
  credential `fastmart Webhook JWT`), not per-user login. Missing → `401`;
  wrong signature → `403`. Every caller (widget, eval-harness) embeds the same
  long-lived token, same as an API key — see WIDGET-CONTRACT.md for why this
  is a casual-abuse deterrent, not real secrecy (the token has to live in the
  client-side JS for the browser to send it).
- **`user_id` is REQUIRED** (as of 2026-10-12). Without it the workflow
  returns `{"error": "user_id is required", "status": 400}`. It is *not*
  auto-minted from `conversation_id` anymore — the caller must mint and
  persist its own (`tmp-widget-<uuid>` convention), and must use a
  **different id per browser/customer** — one shared id merges everyone's
  cart and chat memory into one.
- `conversation_id` is accepted too and is simply echoed back — send the
  same value as `user_id`.
- Any script or test that posts to this webhook must send `user_id`. If you
  add a new one, mirror `dev/eval-harness.mjs`'s `postChat()` pattern (mints
  one if neither field is given).

---

## 7. Where things live

| Path | What |
|---|---|
| `dev/prompts.js` | All system prompts + tool descriptions (`P.ORCHESTRATOR` is the main one) |
| `dev/build-main.mjs` | Builds the main `agent-chat` webhook workflow |
| `dev/build-workflows.mjs` | Builds the 4 specialists + 2 store-facing tool workflows |
| `dev/sync.mjs` | **The only normal deploy path** — see §3 |
| `dev/deploy.mjs` | Low-level upsert-by-name — see §4 for when to use it directly |
| `dev/eval-harness.mjs` | The real test suite — see §5 |
| `dev/read-wf.mjs` | Prints what n8n actually has stored for a workflow (ground truth, not the built JSON) |
| `dev/model-config.mjs` | Model/provider selection, see README's provider table |
| `restore-n8n.ps1` | Restores a production DB dump into the local Docker stack for debugging — see §8, this is **not** a normal local-dev setup |
| `perfecto-ai-demo.html` | Standalone single-file chat SPA — no build step, open directly or serve statically |
| `WIDGET-CONTRACT.md` | The webhook request/response spec, kept up to date as the real contract changes |
| `.n8n-credentials.json` | Local credential **names** (not secrets) so builders resolve the right credential on this machine |

---

## 8. `restore-n8n.ps1` — know what you're actually testing against

Running this script drops a **real production database dump** into your
local n8n. After running it, "local" n8n is not a toy sandbox — it has
production's actual workflows, actual execution history, and
`STORE_BASE_URL` pointed at `https://stg-admin.perfectobd.com` (a real
staging store backend, not a mock). Testing against it has real side
effects (it can really add to a real cart on that backend). This is
extremely useful for diagnosing "what is actually live right now" bugs
(exactly how the §2 incidents were found and fixed), but:

- Don't treat it as your everyday dev loop — normal local dev should use its
  own freshly-bootstrapped instance (`docker compose up -d` +
  `dev/bootstrap-creds.mjs`, see README quick start), which has its own,
  independent credential/workflow ids.
- Don't assume raw DB export/import is a substitute for `sync.mjs` as a
  deploy mechanism between two *different* n8n instances — it only "works"
  here because this local copy's ids happen to be identical to production's
  (it *is* production's data). Two independently-created instances will
  have different credential and sub-workflow ids, and a raw DB copy between
  them silently breaks the same way §2's first incident did.

---

## 9. Do / Don't

**Do**
- Edit `dev/build-*.mjs` / `dev/prompts.js`, then `node dev/sync.mjs`.
- Run `node dev/sync.mjs --check` before any production deploy.
- Run `node dev/eval-harness.mjs` after any change that touches the
  orchestrator prompt, a specialist, or a tool — and manually verify any
  FAIL before assuming it's real.
- Keep `WIDGET-CONTRACT.md` in sync with the actual request/response shape
  whenever it changes.
- If you hand-patch the live instance for a hotfix, port the same change
  into the repo in the same session (§4).
- Back up before a production deploy:
  `docker exec fastmart-n8n-postgres pg_dump -U n8n fastmart_n8n | gzip > backup.sql.gz`

**Don't**
- Don't hand-edit a node in the n8n UI and leave it unsynced with the repo.
- Don't deploy with `dev/deploy.mjs` alone as your normal path — it doesn't
  resolve per-instance ids or verify references (that's `sync.mjs`'s job).
- Don't trust a confident reply ("I've added it to your cart!") as proof
  anything actually happened — n8n expressions and tool calls fail silently.
- Don't let this app write to the store's database directly — HTTP API only.
- Don't run `pint` or auto-commit inside the separate `fastmart-pro` (store)
  repo — its own `AGENTS.md` forbids both; this app only ever talks to it
  over HTTP, never touches its code.
- Don't assume a local `.env` edit took effect — n8n containers freeze their
  env at creation; you need `docker compose up -d --force-recreate n8n` (see
  README's "After editing `.env`").
- Don't generalize "it worked in local" to "it works in production" when
  your local instance isn't actually a restored prod copy (§8) — ids,
  credentials and catalog data can differ.
