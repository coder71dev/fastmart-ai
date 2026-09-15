# Plan — Perfecto AI Shopping Assistant on n8n

**Status:** ✅ **Spike PASSED 2026-09-02.** Part 1: 5/7 gates green — Steps 1–5 & 7 done; Step 6 blocked on external creds/HTTPS (documented, revisit at Part 3). n8n brain + store HTTP API + guest cart + widget webhook contract all proven live against the local store. **Part 2 — Full build DONE 2026-09-03 (5/5): agent+memory, store tools, 4 specialists, blocks JSON + price-guard, external eval harness — all tested live end-to-end (10/10 eval green).**
**Last updated:** 2026-09-15
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
| `docker-compose.yml` | Production stack: n8n + Postgres + n8n Assistant (sandbox/SearXNG/Gemini proxy). `docker compose up -d` after `.env` — no edits | ✅ Done (2026-09-15) |
| `docker-compose.dev.yml` | Local-dev overlay: dev-only Meilisearch + `fastmart-pro.test` host mapping + plain HTTP | ✅ Done (2026-09-15) |
| `.env.example` | Env template | ✅ Done |
| `README.md` | Quick start | ✅ Done |
| `spike-checklist.md` | 2-week de-risk spike | ✅ Done (4/7 green, 2 blocked, Step 5 near-done) |
| `WIDGET-CONTRACT.md` | **Widget ⇄ n8n webhook contract** (final) | ✅ Done (2026-09-02) |
| `wf4-agent-chat.json` | **Production webhook workflow** (agent + guest cart + blocks JSON) | ✅ Done — ready to import |
| `wf5-test-bucket.json` | Test-bucket helper workflow | ✅ Done — ready to import |
| `scratchpad-verify.mjs` | End-to-end verifier for the imported webhook | ✅ Done |

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

### Part 3 — Deploy to VPS
**How-to:** `README.md` → **Deploy (production)** — clone, `.env`, `docker compose up -d`, then site + TLS, reverse proxy, workflow migration, widget cutover, verification and backups. Tick the items below as you go.
- [x] Store host no longer hardcoded — `STORE` in `dev/prompts.js` reads `STORE_BASE_URL` (build-time); the `search-products` tool in `dev/build-workflows.mjs` fixed to use it like the other 6 tools (2026-09-15). Workflows are now built per environment.
- [ ] Pull `fastmart-ai` to VPS
- [ ] Reverse proxy (Caddy/nginx) behind same domain/subdomain with **HTTPS** (required for WhatsApp/Messenger webhooks)
- [ ] Firewall n8n; back up n8n's Postgres volume
- [ ] Point widget at the n8n webhook

### Perf tuning (unplanned, done 2026-09-03 after eval-harness complaints of slow turns)
- [x] Latency investigation: add-to-cart was 9 serialized LLM calls (~29s). Fixed by: model `gemini-3.6-flash` → `gemini-3.7-flash` (benched 6 models in `dev/model-bench.mjs`; `3.5-flash-lite` was 2.6x faster but hallucinated cart state — rejected), specialist recommends straight from search results (no per-candidate product-detail fetches), no post-add cart re-read (Response node renders cart-table on successful cart-add), guest id required in every cart task (was wasting a nested round-trip), cart specialist hardened to never guess cart state. **Result: support 8.7→6.2s, search 25.5→10.5s, add 28.8→10.0s; eval 10/10.** Tooling kept: `dev/exec-timing.mjs`, `dev/model-bench.mjs`.
- [ ] (optional, next perf step) Collapse two-agent design for simple flows (single agent + direct tools) → target ~5s add-to-cart. Bigger refactor; eval battery is the safety net.

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