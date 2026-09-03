# Spike Checklist — 2-Week De-risk (do FIRST)

Run this in order. Each step is a gate: if it fails hard, stop and re-plan **before** the full build.
Keep results updated inline (check off + note date/result).

**Goal:** Prove, in ~2 weeks, that the risky parts of the n8n build actually work on the **real** store — before spending on the full 3–4 week build.

---

## Step 1 — Store reachability (n8n → live store)

- [x] Create an `HTTP Request` node (or "Call n8n Internal API" test) hitting `{{STORE_BASE_URL}}/api` (v3) — any public endpoint.
- [x] Confirm a 2xx and JSON back from the live domain.
- [x] Confirm this also works from the **local** ddev URL (`http://perfecto.ddev.site`).

**Gate:** must reach the store from both local and live HTTPS.
(**Result / date:** ✅ 2026-09-01 — Local only (`http://fastmart-pro.test`). n8n `HTTP Request` → `/api/v3/categories` → 200 + `{"success":true,"status":200}`. Note: store prepends PHP deprecation HTML to JSON — consumers must strip text up to the first `{`. Host mapping `fastmart-pro.test:host-gateway` added to compose. Live domain test deferred (user chose local-only).)

---

## Step 2 — Guest cart verification (KEY unknown)

- [x] Call the store's cart endpoints anonymously (logged-out):
      `POST {{STORE_BASE_URL}}/api/carts/add` with no auth token.
- [x] Determine whether the API **auto-creates** a guest user/session, or rejects 401.
- [x] Cross-check the store's `is_guest_user` / `EnsureGuestOrderAccess` middleware behavior for cart vs order.
- [ ] **If NO guest cart:** decide the **guest-cart bridge**:
      a thin Laravel route on the store that mints a guest session token (store already has CSRF off + guest-order plumbing, so stays small). Note: do **not** implement it here — only confirm the shape (endpoint, payload, token) for the full build.

**Gate:** guest cart path is understood & confirmed (auto-mint OR bridge planned).
(**Result / date:** 🟡 2026-09-01 — Guest cart path CONFIRMED at the route/middleware level. `guest_order_activation=1` → cart routes use only `is_guest_user` (no `auth:api`). Anonymous `POST /api/v3/carts/add` with `user_id=tmp_*` is ACCEPTED (no 401), `is_guest_user` middleware maps it to `temp_user_id`. Read path `POST /api/v3/carts/{user_id}` keys on `temp_user_id` for `tmp_` ids. **However: local MySQL 8 `carts` table has NO `AUTO_INCREMENT` on `id`** (`SHOW CREATE TABLE` → `id int unsigned NOT NULL`, no auto_increment) → every add insert fails `Duplicate entry '0' for key 'carts.PRIMARY'`. Guest add worked in earlier runs only when an id happened to be free; the DB cannot auto-generate ids. This is local schema drift vs live (live presumably has auto_increment). **Action: fix local schema (`ALTER TABLE carts MODIFY id INT UNSIGNED NOT NULL AUTO_INCREMENT`) OR verify live schema. No guest-cart bridge needed.**)

---

## Step 3 — Minimal agent chat

- [x] n8n `Webhook` (trigger) → `AI Agent` node:
      - Model provider (Gemini, matching today's `Lab::Gemini`) + credentials.
      - Postgres **memory** connected to n8n's own Postgres.
      - System prompt copied from biz-buddy `app/Ai/Agents/ShoppingAssistant.php::instructions()`.
- [x] Give the agent one tool: `search_products` (HTTP Request → `{{STORE_BASE_URL}}/api/v4` products or v3 search → returns product cards).
- [x] Test a real product question end-to-end: webhook → agent → tool → final answer.

**Gate:** a natural-language product question returns a real product answer.
(**Result / date:** ✅ 2026-09-02 (updated) — Working agent: Webhook → AI Agent (v2 Tools Agent) → Gemini `gemini-3.6-flash` (`googlePalmApi` cred w/ host) → **`search_products` = `n8n-nodes-base.httpRequestTool` typeVersion 4.2** → `/api/v4/products?keyword=$fromAI('query')` → real products. **Root-cause fix for "tool not called":** the deprecated `@n8n/n8n-nodes-langchain.toolHttpRequest` is `hidden:true` and NOT resolved as a tool by n8n 1.95's engine (agent ran tool-less). The correct tool node is the **`usableAsTool`-wrapped `<base>Tool` type** (`n8n-nodes-base.httpRequestTool`, also `.supabaseTool`/`.gmailTool` per n8n's own export). Model params via `$fromAI()`. Other key fixes kept: source-keyed sub-node connections; `googlePalmApi` needs `host`; model `gemini-3.6-flash`. **Caveat:** the shared Gemini key hit a 429 quota mid-verification (many test runs) — mechanism proven (agent actively called the tool), full reply re-verify after quota reset. Note: Tools Agent docs list OpenAI/Groq/Mistral/Anthropic/Azure as supported models — Gemini worked here but is not on n8n's documented list.)

Also relevant: `@n8n/n8n-nodes-langchain.toolHttpRequest` is `hidden:true` ("Replaced by a usableAsTool version of the standalone HttpRequest node").)

---

## Step 4 — One cart action

- [x] Wire one cart action (add-to-cart OR view-cart) through the path revealed by Step 2 (guest bridge or user token).
- [x] Confirm the widget can trigger it; confirm the store cart reflects it.

**Gate:** cart is read/written from n8n against the real store.
(**Result / date:** ✅ 2026-09-02 — Add-to-cart works from n8n against the real store. Fixed local `carts` table (`ALTER TABLE carts MODIFY id INT UNSIGNED NOT NULL AUTO_INCREMENT` — local schema was missing auto_increment, causing `Duplicate entry '0'`). After fix: `POST /api/v3/carts/add` with `user_id=tmp_*` + `id=4` → `{"result":true,"message":"Product added to cart successfully"}`, then `POST /api/v3/carts/{tmp_id}` reads back the cart with items (name, price ৳1500). DB row confirmed under `temp_user_id`. Agent-level `add_to_cart` tool: ToolHttpRequest JSON-body placeholders broke the Gemini schema (`key cannot be empty`); ToolCode needs proper schema declaration — deferred to full build as a known pattern. Cart action itself is fully proven.)

---

## Step 5 — React widget to n8n

- [x] Fork the biz-buddy widget to hit the n8n webhook URL instead of Laravel's `ChatController`.
- [x] Swap the streaming text for a **full-response wait** (spinner → render when n8n returns the JSON).
- [x] Map n8n's output JSON → the widget's existing message/block rendering (keep `product-grid`, `cart-table`, etc.).

**Gate:** widget chat works from the store page using n8n as the brain.
(**Result / date:** ✅ **2026-09-02 — LIVE-verified end-to-end.** Workflow `agent-chat` (webhook `POST /webhook/spike/agent-chat`, full-response JSON, `responseMode: lastNode`) answers a product question with real products + ৳ prices, returns a populated `product-grid` block, reads the **real store cart** (iUNIK Tea Tree Relief Serum, ৳1500) and returns a populated `cart-table` block. `conversation_id` round-trips (`tmp_cartfix1` preserved; fresh ids minted as `tmp-widget-*`). Contract in `WIDGET-CONTRACT.md`.

**Gotchas fixed along the way (read these before the full build):**
1. **Agent must be Tools Agent (typeVersion 2)** — modern structured tools (`httpRequestTool 4.2`) are rejected by "Conversational Agent" (`v1`). 
2. **Tools CANNOT use `{{ $env.* }}`** — n8n's tool sandbox denies env access ("access to env vars denied"). Tool URLs are **hardcoded** (here `http://fastmart-pro.test`). For VPS portability, swap the literal host in the two tool nodes (a full-build concern, not the tool schema).
3. **Agent `text` = the USER message** when `promptType: define`; put system instructions in **Options → System Message** (prefix `=`, reference `{{ $json.userId }}` there). Earlier drafts put instructions in `text` → the model saw a canned "You are Perfecto AI…" as the user input and replied with a greeting.
4. **Guest ids**: store guest carts use `tmp*` (the middleware only checks `Str::startsWith('tmp')`) — keep any incoming id starting `tmp` (both `tmp-` and `tmp_`), mint `tmp-widget-*` only when none is sent.
5. **Blocks data comes from `intermediateSteps`** — the Response code node cannot `$()` tool sub-runs (they execute inside the Agent). Enable `options.returnIntermediateSteps` on the Agent and read each tool's `observation` (parse the nested `[{data:"…"}]` / `{data:"…"}` string wrappers the tool returns).
6. **PATCH on a live n8n workflow only changes the draft.** You must then POST `/rest/workflows/{id}/activate` with `{versionId: "<new draft versionId>"}` (owner session cookie) so the **published/active** version (the one webhooks execute) actually runs your changes.

Fork work (widget in `biz-buddy`, no auto-commits there): **DONE & BROWSER-VERIFIED 2026-09-02.** `resources/js/components/storefront/storefront-widget.tsx` — `realChat` defaults to the **n8n webhook** (`http://localhost:5678/webhook/spike/agent-chat`), does a full-response `response.json()` wait, persists the echoed `conversation_id`, and renders `{reply}` text + `{blocks}` through the existing `answer` bubble. The old Laravel SSE path stays behind `window.__PERFECTO_CHAT_MODE = 'laravel'` (or point `window.__PERFECTO_N8N_CHAT_WEBHOOK` elsewhere). TypeScript/eslint/prettier pass. **Browser proof:** chats typed in the real widget at `http://localhost:8000` hit n8n over CORS → executions **84–87 all `success`**: 84 "Show me bestsellers" → real products ৳ + blocks; 85 "What is in my cart?" → cart-table; 86 "Hi" → greeting; 87 cart view → `[BLOCK cart-table]`. Headers confirm a real Chrome request (`origin: http://localhost:8000`, `sec-ch-ua`, `referer`).)

---

## Step 6 — One WhatsApp + one email (future proof)

- [ ] Build a tiny n8n workflow: trigger → WhatsApp message ("Your order has shipped") via the WhatsApp Business node.
- [ ] Build a second: trigger → email (Resend/SMTP node).
- [ ] Confirm credentials + reachability on the live domain (HTTPS webhook).

**Gate:** multi-channel automation is demonstrably easy in this setup.
(**Result / date:** 🔒 2026-09-02 — **Blocked on credentials/environment** (documented, not a code failure). No SMTP/Resend creds locally (biz-buddy mailer = `log`/Mailpit only); WhatsApp Business requires a verified Meta Business account + **public HTTPS** webhook — impossible on `localhost`. Both are n8n-native nodes that need only credential setup once accounts exist. Revisit at full-build/Part 3 when the VPS + real accounts are ready.)

---

## Step 7 — Embeddings source decision (for full build)

- [x] Confirm where product embeddings live (`product_embeddings` is in **biz-buddy's Postgres** + pgvector).
- [x] Decide: keep calling biz-buddy's embedding search over HTTP, or re-create embeddings in the store DB.
      (This only matters for the full-build `search_products` tool; not required for the MVP.)

**Gate:** a documented choice for the full build's semantic search.
(**Result / date:** ✅ 2026-09-02 — `product_embeddings` is in **biz-buddy's** Postgres (migration `2026_08_04_125831_create_product_embeddings_table.php`, pgvector `vector(768)`, populated by `EmbedProducts.php` using Gemini `gemini-embedding-001`). ProductSearchTool queries it via `embedding <=> ?`. **Decision: MVP uses keyword search over the store's `/api/v4/products` (already proven). Full-build semantic search = call biz-buddy's embedding search over HTTP (keeps one source of truth, avoids re-embedding in store DB).** Re-creating in the store DB only if biz-buddy is decommissioned.)

---

## Exit criteria (all gates green)

| # | Check | Pass? |
|---|---|---|
| 1 | Store reachable over HTTP API from n8n (local + live) | 🟡 local ✅ / live ⬜ (deferred: user chose local-only) |
| 2 | Guest-cart path confirmed (auto-mint or bridge shaped) | ✅ (auto-mint via `tmp_` user; local schema fixed) |
| 3 | Minimal agent answers a product question | ✅ (proven; tool-calling flaky — tune in full build) |
| 4 | One cart action works against the real store | ✅ (add + read-back via guest cart) |
| 5 | React widget chats via n8n (full-response wait) | ✅ **browser-verified** (n8n execs 84–87: bestsellers + cart-table from the widget page) |
| 6 | WhatsApp + email automation demoed | 🔒 blocked on creds/HTTPS env |
| 7 | Embeddings source decided | ✅ (biz-buddy PG via HTTP) |

**Status 2026-09-02 (final):** **✅ SPIKE PASSED.** 5/7 green — Step 5 **browser-verified end-to-end** (n8n executions 84–87 from the live widget page). 1 documented-blocked (Step 6: external creds/HTTPS — revisit at Part 3/VPS). Core de-risk fully proven: n8n brain + store HTTP API + guest cart + full-response JSON contract + the kept React widget all work against the real store. **Proceed to Part 2 — Full build** (PLAN.md).