# Plan — Perfecto AI Shopping Assistant on n8n

**Status:** ✅ **Spike PASSED 2026-09-02.** Part 1: 5/7 gates green — Steps 1–5 & 7 done; Step 6 blocked on external creds/HTTPS (documented, revisit at Part 3). n8n brain + store HTTP API + guest cart + widget webhook contract all proven live against the local store. **Part 2 — Full build DONE 2026-09-03 (5/5): agent+memory, store tools, 4 specialists, blocks JSON + price-guard, external eval harness — all tested live end-to-end (10/10 eval green).**
**Last updated:** 2026-09-22
**Target:** Rebuild the Biz Buddy AI chat brain on **n8n**, as a standalone app at `D:\laragon\www\fastmart-ai`, targeting the **live Perfecto store** over **HTTP API**.

---

## 1. Goal

Replace the Laravel chat backend (the agent brain) of the Perfecto AI shopping assistant with **n8n workflows**. Keep the React widget (it talks to an n8n webhook instead of Laravel). Accept:
- **Full-response wait** — no token streaming.
- **Form-style approvals** — no inline approve/reject mid-stream.
- Widget cart operates on the **store's own cart** (via its HTTP API) — guest-cart behavior to be verified.

Deferred (document only): WhatsApp / email / Facebook multi-channel automations.

---

## 2. Decisions locked

| Decision | Choice | Rationale |
|---|---|---|
| Platform | **n8n** (standalone) | $½$ dev time vs Laravel (~3–4 wk vs 8 wk); strong future multi-channel; you said streaming/approvals don't matter |
| App location | **`D:\laragon\www\fastmart-ai`** (new, separate) | Not inside biz-buddy; pulled to VPS later |
| Store access | **HTTP API only** | One path, works local + VPS, no store DB creds in n8n |
| Store API layer | **`/api` (v3)** primary; **`/api/v4`** for products (latest) | Per `AGENTS.md` |
| Cart auth | **Verify** whether store auto-creates guest user (`is_guest_user` middleware) | Spike step 2; add **guest-cart bridge** only if it doesn't |
| n8n networking | Reach store via **`STORE_BASE_URL`** env (configurable) | Portable local → VPS |
| Specialists | **4 sub-workflows** (product / support / cart / orders) | Parity with today |
| Embeddings | In biz-buddy's Postgres (pgvector) — decide at full-build whether to re-create in store DB or keep via biz-buddy | Not a blocker for MVP |

**Store conventions honored (from `fastmart-pro/AGENTS.md`):** NEVER run `pint`; NEVER auto-commit; `CSRF` and cookie-encryption are OFF for `web` routes (simplifies a guest bridge if needed).

---

## 3. Architecture (target)

```
React widget (kept) ──webhook──► n8n: AI Agent ──► sub-workflows:
                                     (Postgres memory) │
                                                       ├─ product search (store /api/v4 + pgvector)
                                                       ├─ cart / checkout (store /api v3)
                                                       ├─ order tracking (store API / DB)
                                                       ├─ support / policies (store)
                                                       └─ blocks / price-guard (Code node)
                                             └──► full answer + blocks JSON → widget
```

---

## 4. Deliverables (this repo)

| File | Purpose | Status |
|---|---|---|
| `PLAN.md` | This plan + progress tracking | ✅ In progress |
| `docker-compose.yml` | Production stack: n8n + Postgres + n8n Assistant (sandbox/SearXNG/Gemini proxy, kept but unrouted). `docker compose up -d` after `.env` — no edits | ✅ Done (2026-09-15) |
| `docker-compose.dev.yml` | Local-dev overlay: dev-only Meilisearch + `fastmart-pro.test` host mapping + plain HTTP | ✅ Done (2026-09-15) |
| `.env.example` | Env template | ✅ Done |
| `README.md` | Quick start | ✅ Done |
| `spike-checklist.md` | 2-week de-risk spike | ✅ Done (4/7 green, 2 blocked, Step 5 near-done) |
| `WIDGET-CONTRACT.md` | **Widget ⇄ n8n webhook contract** (final) | ✅ Done (2026-09-02) |
| `wf4-agent-chat.json` | **Production webhook workflow** (agent + guest cart + blocks JSON) | ✅ Done — ready to import |
| `wf5-test-bucket.json` | Test-bucket helper workflow | ✅ Done — ready to import |
| `scratchpad-verify.mjs` | End-to-end verifier for the imported webhook | ✅ Done |
| `perfecto-ai-demo.html` | **Standalone chat SPA** — n8n agent brain + live store API, all 8 contract block types | ✅ Done (2026-09-21) — hosting not wired yet |

---

## 5. Work breakdown & progress

### Part 0 — Scaffold `fastmart-ai` (separate app)
- [x] Create dir
- [x] Write `PLAN.md`
- [x] Write `docker-compose.yml` (n8n pinned + Postgres own volume; `N8N_ENCRYPTION_KEY`, `N8N_SECURE_COOKIE=true`, `TZ=Asia/Dhaka`, `GENERIC_TIMEZONE=Asia/Dhaka`, `N8N_PORT`; `extra_hosts` for local ddev)
- [x] Write `.env.example` + `.env`
- [x] Write `README.md`
- [x] Verify: `docker compose up -d` → n8n at `http://localhost:5678` (✅ 2026-09-01)

### Part 1 — 2-week de-risk spike (do FIRST; fails fast)
- [x] **Step 1.** n8n `HTTP Request` → live store `/api` (v3) — reachability ✅ (local store; live deferred — user chose local-only)
- [x] **Step 2.** Verify **guest cart**: anonymous `/api/carts/*` → auto-mint guest user? (`is_guest_user`) ✅ (path confirmed; local `carts` table missing AUTO_INCREMENT — fixed locally)
- [x] **Step 3.** Minimal agent: Webhook → AI Agent (PG memory + `ShoppingAssistant` system prompt) → `search_products` HTTP tool → reply ✅ (proven once; Gemini tool-calling is nondeterministic — needs prompt/agent tuning in full build)
- [x] **Step 4.** One cart action (whatever step 2 revealed) ✅ (add + read-back proven)
- [x] **Step 5.** React widget → n8n webhook (full-response wait) ✅ **browser-verified end-to-end** 2026-09-02. Widget fork (`biz-buddy` `storefront-widget.tsx`, n8n default + Laravel opt-out) tested from the real widget page at `http://localhost:8000` → n8n executions 84–87 all success: "Show me bestsellers" → real products ৳, cart view → `cart-table`, greeting, etc. Contract + gotchas: `spike-checklist.md` / `WIDGET-CONTRACT.md`.
- [x] **Step 6.** One WhatsApp + one email from n8n (proves multi-channel + credentials) — 🔒 blocked on creds/HTTPS env (documented in spike-checklist)
- [x] **Step 7.** Decide source of embeddings at full-build (biz-buddy PG vs re-create in store DB) ✅ (`product_embeddings` in biz-buddy PG; MVP keyword search, full-build calls biz-buddy over HTTP)

### Part 2 — Full build (~3–4 weeks, only after spike passes)
- [x] Agent + Postgres memory (copy `ShoppingAssistant` system prompt) — ✅ done 2026-09-03: `agent-chat (prod webhook)` live, PG memory table `chat_memory_fastmart`, remembers past chats (proven)
- [x] Custom HTTP tools: product search, cart, orders, policy lookup — ✅ done 2026-09-03: search-products, product-detail, cart-add, read-cart, cart-summary, remove-line, track-order (policies answered from hardcoded map, as in biz-buddy)
- [x] 4 specialist sub-workflows (product / support / cart / orders) — ✅ done 2026-09-03: all deployed + tested live end-to-end (find → buy → show cart → remove, support answers, order-track). Gotcha fixed: `$fromAI` inside `queryParameters` does NOT resolve in httpRequestTool 4.2 as AI tool — params must be embedded in the URL string
- [x] Blocks JSON Code node (price-guard copy of `richTextTotalMismatch`) — ✅ done 2026-09-03: product-grid + cart-table blocks (live re-fetch = ground truth) + price guard on cart/grid totals; verified live. Gotchas: n8n Code node sandbox has NO `$helpers`/`fetch` — use `require('http')` enabled via `NODE_FUNCTION_ALLOW_BUILTIN=http,https,url`; `cart-summary` API returns 0 for guest (tmp-*) carts so totals are computed from the cart read-back
- [x] External eval harness (Node/Python; not n8n-native) — ✅ done 2026-09-03: `dev/eval-harness.mjs` — 10-case battery (product grid, no-fabrication, add→view→remove cart via the store reads the widget uses, support, order-track honesty, PG-memory recall, Bengali). `node dev/eval-harness.mjs` → all green; `--group`, `--webhook`, `--store`, `--out report.json`, exit 0/1. Note: an earlier "guest-cart read flake" theory was disproven 2026-09-03 — it was the lite model misreporting cart state; the store DB was consistent. Cart persistence is still asserted through the workflow's own per-turn store reads (the widget's channel).
- [x] Cart-sync + memory/profile audit — ✅ 2026-09-21: cart sync verified **end-to-end at the DB level** for every path — grid add (row created), variant add (row with `variation`), chat-driven add (the agent writes the *same* `temp_user_id` the SPA sends), qty change (row updated), remove (row deleted), and reload (cart restored). The SPA now **re-reads the cart after every turn**, since the agent can change it without sending a `cart-table` block. Also verified **memory** (n8n PG memory recalls across turns *and* across a reload, keyed by `conversation_id`) and **profile** (skin/concern/budget is honoured in-turn: an "oily skin, acne, ৳1,500" profile produced oily/acne recommendations under budget). Profile persistence was watcher-driven (`$watch`) and therefore unverifiable from tests — made explicit with `saveProfile()` / `setProfile()`.
- [x] Turn resilience — ✅ done 2026-09-21: a provider `503` used to end a turn **invisibly**. n8n replies `HTTP 500` with the body `{"message":"Error in workflow"}`; that is valid JSON, so the SPA parsed it, found no `reply`, and rendered an empty bubble — the customer saw nothing at all (reproduced on the "reorder same items" turn, exec 1015). Fixed: the SPA now requires `r.ok` **and** the contract shape, renders a real error bubble, and offers **Try again** (which re-sends the same turn without duplicating the user bubble; it survives a reload). Also added `retryOnFail` (3 tries) to the **read-only** specialists — `specialist-orders`, `specialist-support`, `specialist-product-discovery` — so transient 503s self-heal. Deliberately NOT on `specialist-cart` or the orchestrator: n8n retries the whole Agent node, so a retry after a partial run could double-add to a cart. Those two surface the error instead.
- [x] Session persistence in the SPA — ✅ done 2026-09-21: the transcript is stored (`perfecto_chat_v1`, capped at 60 messages) and restored on load alongside `perfecto_conversation_id` and the panel's open state (`perfecto_chat_open`); corrupt entries are filtered, and only **Reset session** clears it. The server side was already durable — n8n PG memory and the store's guest cart are keyed by `conversation_id` (verified: same id recalls a fact from an earlier request, a different id does not). Before this fix only the id persisted, so a reload wiped the visible conversation.
- [x] Order tracking presentation — ✅ done 2026-09-21: `order-status` block (9th OutputBlock type). The order specialist reads the raw `track-order` observation (`returnIntermediateSteps`), allowlists display-safe fields, **redacts identity** (name/phone/email/address/area — never sent to the client, even if the model echoes them), and emits `META_ORDER_JSON` + `[BLOCK order-status]`; the main Response node parses that into the block and strips both markers. The SPA renders a progress stepper (Order Placed → Confirmed → **Packaging** → Out for Delivery → Delivered, terminal `cancelled`/`returned`/`failed`), items, totals and status badges. Prose is limited to 1–2 sentences. Verified: 3 observation shapes + PII-redaction unit tests, Response-node block-building test, SPA stepper tests, and live end-to-end (order found → card; unknown code → honest "not found"; product-grid + cart unaffected).
- [x] Agent honesty on tool failure — ✅ done 2026-09-21: the order prompt now forbids reporting a tool/connection error as "order not found" (that is what turned the earlier `fastmart-pro.test` connection refusal into a false *"I couldn't find your order"*). Also corrected the prompt's stale `PERF-XXXX` code example and added "pass the code exactly as given" (codes are long).
- [x] Standalone chat SPA (`perfecto-ai-demo.html`) — ✅ done 2026-09-21: the old simulated prototype is now real. Talks to the agent-chat webhook (full-response wait, `conversation_id` in localStorage). **Fully live storefront** (2026-09-21): branding/contact from `/api/v3/business-settings`, nav from `/api/v3/categories?parent_id=0`, grid/search/filter/sort/pagination from `/api/v4/products` (`type`/`category_id`/`keyword`/`sort`), product detail from `/api/v3/products/{id}` with variants from `/api/v4/products/variants`, quiz options from `/api/v3/skin-concerns`, and the store's own guest cart (read/add/change-quantity/remove). Relative image paths are absolutized; missing/broken images get an inline placeholder; a sample-data fallback keeps chat working if the store is CORS-blocked. Single file, no build (Tailwind + Alpine CDN). Verified: 42 stubbed behavior checks + 22 checks against the **live** store + the live webhook contract — not yet opened in a browser. Hosting not wired yet.
- [x] Model provider → **Command Code** — ✅ done 2026-09-22: the agent-chat workflow and its 4 specialists run on Command Code's OpenAI-compatible gateway (`https://api.commandcode.ai/provider/v1`, model `deepseek/deepseek-v4.1-flash`) through n8n credential `OpenAI compatible Commandcode` (`mlmhRJXXejblFl1S`, type `openAiApi`), replacing the `Gemini API Palm v3` (`googlePalmApi`) node. `dev/build-workflows.mjs` / `dev/build-main.mjs` emit `lmChatOpenAi` + `openAiApi`; the endpoint is taken from the credential's **Base URL** field, so no URL is baked into the node. The **n8n Assistant** moved to the same key + endpoint (`N8N_INSTANCE_AI_MODEL` / `_API_KEY` / `_URL`) — that half is env-only, so it can be switched back with a `.env` edit, while the workflows need a rebuild + redeploy. Gotcha (fixed 2026-09-22): the Assistant's model id must be `custom/deepseek/deepseek-v4.1-flash`, not `deepseek/deepseek-v4.1-flash`. instance-ai splits the value at the first `/` and treats the head as an n8n provider, and `deepseek` is a provider n8n ships — so the bare id was routed through `@ai-sdk/deepseek` and sent as `deepseek-v4.1-flash`, which the gateway rejects (`Model ... is not supported on this endpoint`, surfacing as `No output generated`). The workflow OpenAI node sends the id verbatim, so it never hit this. `custom/` is the generic OpenAI-compatible provider and strips only itself. `gemini-sig-proxy` remains in the stack but is no longer routed to. Provider switching is now **env-driven, not a code edit**: `dev/model-config.mjs` holds a descriptor per provider and both builders read it, so `MODEL_PROVIDER=gemini node dev/build-main.mjs` (plus a redeploy) restores the old Gemini graph, and `MODEL=` swaps the model id inside a provider. Documented in `README.md`.

### Part 3 — Deploy to VPS
**How-to:** `README.md` → **Deploy (production)** — clone, `.env`, `docker compose up -d`, then site + TLS, reverse proxy, workflow migration, widget cutover, verification and backups. Tick the items below as you go.
- [x] Store host no longer hardcoded — `STORE` in `dev/prompts.js` reads `STORE_BASE_URL` (build-time); the `search-products` tool in `dev/build-workflows.mjs` fixed to use it like the other 6 tools (2026-09-15). Workflows are now built per environment.
- [ ] Pull `fastmart-ai` to VPS
- [ ] Reverse proxy (Caddy/nginx) behind same domain/subdomain with **HTTPS** (required for WhatsApp/Messenger webhooks)
- [ ] Firewall n8n; back up n8n's Postgres volume
- [ ] Point widget at the n8n webhook
- [ ] Serve the standalone chat SPA (`perfecto-ai-demo.html`) via nginx — planned `/assistant/` on `ai.perfectobd.com`

### Perf tuning (unplanned, done 2026-09-03 after eval-harness complaints of slow turns)
- [x] Latency investigation: add-to-cart was 9 serialized LLM calls (~29s). Fixed by: model `gemini-3.6-flash` → `gemini-3.7-flash` (benched 6 models in `dev/model-bench.mjs`; `3.5-flash-lite` was 2.6x faster but hallucinated cart state — rejected), specialist recommends straight from search results (no per-candidate product-detail fetches), no post-add cart re-read (Response node renders cart-table on successful cart-add), guest id required in every cart task (was wasting a nested round-trip), cart specialist hardened to never guess cart state. **Result: support 8.7→6.2s, search 25.5→10.5s, add 28.8→10.0s; eval 10/10.** Tooling kept: `dev/exec-timing.mjs`, `dev/model-bench.mjs`.
- [ ] (optional, next perf step) Collapse two-agent design for simple flows (single agent + direct tools) → target ~5s add-to-cart. Bigger refactor; eval battery is the safety net.

### Perf + correctness audit of widget session `tmp-widget-muawwsi3mrqj6f` (2026-09-22)
Traced all 10 turns of one real session from n8n's Postgres (`fastmart_ai.chat_memory_fastmart` for the transcript, `execution_data`/`execution_entity` for time + tokens). Total was **385,651 tokens / 238s**, of which two turns were ~90%: the "oily skin under ৳1,000" turn burned **298,306 tokens in 134.9s** and "add some random products" **50,099 tokens in 42.1s**.
- **Root cause — the search tool returned the store's raw payload.** `search-products` was an `httpRequestTool` hitting `/api/v4/products`, whose response is ~13 KB for 5 products. The specialist's agent issued up to **38 parallel searches in 10 iterations** (~483 KB of tool output), the prompt grew to ~540 KB, and `product_discovery` hit `maxIterations` and returned **"Agent stopped due to max iterations."** with nothing — so the orchestrator re-ran it with a reworded task (the second call alone was 145k input tokens for zero output).
- [x] **Slim search tool** — new `tool-search-products` sub-workflow (`dev/out/searchTool.json`) calls the same endpoint and returns one compact line per product (`id | name | price | stock | rating`, ~700 chars for 6 products). `search-products` in `specialist-product_discovery` is now a `toolWorkflow` pointing at it (renamed `search_products` — toolWorkflow names allow letters/numbers/underscores only).
- [x] **Iteration caps** — `options.maxIterations` (default 10) is now 6 on every specialist and 8 on the orchestrator, so a pathological turn is bounded instead of running to n8n's default.
- [x] **Prompt discipline** — `PRODUCT_DISCOVERY`: one search per distinct product (two when browsing one vague need), core name only, and it must always finish with an answer (the old "keep re-running with looser terms" was a licence to loop). `ORCHESTRATOR`: call each specialist at most once per message, never cart-add an out-of-stock product, and answer profile questions ("what is my skin type", "show my profile") yourself from CURRENT SHOPPING CONTEXT **plus what the customer said earlier in the chat** instead of routing to support.
- **Result (same turns, re-measured):** "oily skin under ৳1,000" **298,306 → 5,006 tok / 134.9s → 14.6s**; "add some random products" **50,099 → 4,960 tok / 42.1s → 14.5s**; every eval turn now lands at **2.4–5k tok / 3.5–13s**. Eval battery 10/10 green.
- **Contract gap (documented, not fixable in-workflow):** `token_usage` in the widget response is always `null` on n8n 2.37.6 — the Agent node's output is only `{output, intermediateSteps}`, and n8n's expression proxy cannot read the `ai_languageModel` sub-node that holds the real per-call usage (`$('OpenAI Chat Model')`, `$node[...]`, `.all()/.first()` all throw *No data found from main input*). Real cost is read out-of-band from n8n's Postgres by `dev/prod-bench.mjs`, which sums the orchestrator **and** its child specialist executions. See `WIDGET-CONTRACT.md`.

### Audit of widget session `tmp-widget-mucaz12ji1d1dx` (2026-09-22, post-fix)
3 turns (track order → "reorder those items" → "add all the alternatives"), 15.2k tokens / 38s total — cheap — but the reorder flow surfaced five real defects:
- **PII leak — the delivery city reached the customer.** The reply said *"1-2 business days within Dhaka"*. `ORDER_STATUS_FORMAT_JS` redacted name/phone/email/address/area/postal but **not `city`/`state`/`country`**, and matched case-sensitively while the stored address is lowercase (`jatrbari dhaka`) — so "Dhaka" survived. Redaction is now case-insensitive and covers city/state/country plus their individual words; the order prompt also says to say "your area" instead of naming the place.
- **Reorder gave up on an item that was in stock.** The specialist crammed two products into ONE keyword — `"Anua Niacinamide TXA Serum Sheglam Good Grip Hydrating Primer"` — so neither matched, and the orchestrator hardened "couldn't find it" into *"not found in the catalog"*. Product 100 (Sheglam Good Grip Hydrating Primer) is in stock at ৳700. Fixed: one search per distinct product, core name only (drop sizes/specs), and no "it doesn't exist" claims.
- **Out-of-stock items were rendered as buyable product cards.** The grid carried ids 5/6 (out of stock), so "add the alternatives you suggested" resolved to *those*. Fixed: the specialist puts only in-stock ids in `META_PRODUCT_IDS`, and the Response node drops out-of-stock cards — variant-aware, because the store reports a variant product's PARENT as `in_stock=false` while its sizes hold the real stock (id 1: parent false, 30ml qty 13).
- **The reply contradicted the cart.** It reported "Anua Rice 70 added / 3W Clinic Cica failed" while the store cart actually held 3W Clinic Cica. Prompt now: report each cart-add outcome against the product you actually sent, and never claim success without its own success result.
- **Variant products could not be added at all.** `cart-add` never passed the store's `variant` param, so any size-option product 500s with *"Attempt to read property price on null"*. It now passes the option **name** (`45ml`), the search result marks which products need a chosen option, and the agent asks the customer when they haven't named one. Also fixed: replies used markdown tables, which the SPA renders as raw `|` (its formatter only handles `**bold**`) — the prompt now forbids tables.
- **Re-verified end-to-end:** tracking (no city, correct totals), reorder (*Sheglam Good Grip 45ml* added ৳1,250 — matches the store cart), variant add (asks 15ml/45ml, then adds), non-variant add unaffected, eval battery **10/10**.

---

## 6. Tradeoffs / accepted cuts

- No token streaming (accepted).
- Form-style approvals instead of inline (accepted).
- Widget cart = store's cart; guest-cart bridge if the API doesn't auto-mint.
- Evals live outside n8n (external harness).
- Embeddings split across two DBs — decide at full-build.

---

## 7. Progress legend

- `⬜` not started · `🟡` in progress · `✅` done · `❌` blocked · `↩️` deferred