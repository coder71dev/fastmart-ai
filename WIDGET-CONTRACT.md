# Widget ⇄ n8n Contract (Spike Step 5)

Ends the spike: this is the agreed **webhook contract** the kept React widget will call instead of Laravel's `/widget/chat`. Fork work happens in `biz-buddy` (store repo — no auto-commits there).

---

## Endpoint

```
POST {N8N_BASE_URL}/webhook/spike/agent-chat
Content-Type: application/json
```

- `N8N_BASE_URL` = where n8n is reachable from the browser.
  - Local: `http://localhost:5678`
  - VPS (Part 3): `https://ai.your-domain.com` behind a Caddy/nginx reverse proxy.
- **Always copy the exact URL from the Webhook node's "Production URL" field in the n8n editor.** n8n registers the path exactly as saved in the workflow (here: `spike/agent-chat`, no workflow-id prefix). If a future edit changes the path or adds a `webhookId`, n8n may register `{workflowId}/webhook/spike/agent-chat` instead — the node's Production URL field is the single source of truth.
- **Verified live 2026-09-02** against workflow `agent-chat (prod webhook)` (owner id `oAlPFsGVYAlhZami` in the local instance).

## Request body

```jsonc
{
  "message": "find me a serum under 2000 taka",   // user text (required)
  "conversation_id": "tmp-widget-<uuid>",           // optional; widget keeps it in localStorage
  "profile": { "skin": "Oily", "concern": "Acne", "budget": "Under Tk 1500" } // optional, quiz
}
```

## Response (HTTP 200, `application/json`)

```jsonc
{
  "reply": "string",                 // agent text (mirror of $fromAI('output'))
  "conversation_id": "string",       // echoed when provided, else a fresh guest id
  "blocks": [ ...OutputBlock... ],   // may be empty array
  "token_usage": { "promptTokens": 123, "completionTokens": 45, "totalTokens": 168 }
}
```

- **No token streaming, no inline approvals.** The widget waits for the full body (plain `response.json()`), shows a spinner meanwhile.
- `reply` may be empty when `blocks` is non-empty (a blocks-only turn, e.g. cart table).
- `blocks` types are the widget's existing `OutputBlock` union:
  `product-grid` | `product-carousel` | `comparison` | `category-carousel` | `rich-text` | `info-cards` | `chips` | `cart-table`.

## Guest cart plumbing (verified in Step 2)

The widget's cart IS the store's guest cart. One shared `conversation_id` maps to the store cart's `tmp_*` user id:

- conversation_id `tmp-widget-<uuid>` → guest cart `user_id=tmp-widget-<uuid>` (store's `is_guest_user` middleware reads `tmp*` as `temp_user_id`).
- n8n **echoes** the same id back (see above). If the widget doesn't send one, n8n mints `tmp-widget-<uuid>` and returns it — the widget persists it (its `perfecto_conversation_id` localStorage key) so a session keeps one cart.

## Blocks JSON helpers (what the agent can emit)

The agent (system prompt) can end its answer with **block markers** the workflow's Code node turns into `blocks`. Full-build enriches these (price-guard copy of `richTextTotalMismatch`); the spike supports two of the widget's block types:

- `[BLOCK product-grid]` → `{type:'product-grid', products:[...]}`
- `[BLOCK cart-table]` → `{type:'cart-table', items:[...]}`

Products in blocks come from the store search result; cart-table items are mapped from the store's cart read-back.

---

## File inventory (this spike)

| File | Purpose |
|---|---|
| `wf4-agent-chat.json` | **Production** workflow: Webhook `spike/agent-chat` → Prepare Input → **Tools Agent** (v2, Gemini) with `search-products` + `get-cart` tools | → Response (contract JSON). **Live-verified** 2026-09-02. Notes: tool URLs are hardcoded to the local store (n8n's tool sandbox denies `{{ $env }}`); system instructions live in Options → System Message; blocks are built from the Agent's `intermediateSteps` observations. Agent-level **add-to-cart is deferred to full build** (JSON-body `$fromAI` schema broke Gemini in Step 4). |
| `wf5-test-bucket.json` | **Test-bucket** helper workflow (immediate webhook round-trip check) — optional |
| `scratchpad-verify.mjs` | Fires test conversations (product search, product-grid blocks, cart view) at the webhook URL and prints `reply` + `blocks` + timing. Usage: `node scratchpad-verify.mjs [webhook-url]` (defaults to `http://localhost:5678/webhook/spike/agent-chat`) |

The widget fork (in `biz-buddy`, `storefront-widget.tsx`) POSTs `{message, conversation_id, profile?}` to this webhook by default and renders `{reply, blocks}` as an `answer` bubble. Set `window.__PERFECTO_CHAT_MODE = 'laravel'` on the host page to keep the old SSE brain; override the URL via `window.__PERFECTO_N8N_CHAT_WEBHOOK`.

### How to see it in a browser (verify the widget fork)

1. Start the stack: `docker compose up -d` in `biz-buddy` (app/web/postgres/redis) **and** in `fastmart-ai` (n8n already up). 
2. Rebuild the widget asset from biz-buddy: `docker compose exec node npm run build`.
3. Open the widget page (`http://localhost:8000/widget` per biz-buddy `.env` `APP_URL`) or the page that embeds `biz-buddy-widget.js`.
4. Type "find me a serum under 2000 taka" → expect a real product answer + product grid; "what is in my cart" with a guest cart → expect a cart table.
5. Browser DevTools → Network → the POST to `localhost:5678/webhook/spike/agent-chat` should be 200 and show the contract JSON.

### How to update the workflow in n8n after changing this JSON

n8n's Public API key for this project is read-only (`workflow:list`). To apply a changed `wf4-agent-chat.json`: open the workflow in the editor → menu (⋮) → **Import from File…** → pick the new JSON → Save. (Import into the *same* workflow replaces its nodes; the Active toggle stays.)