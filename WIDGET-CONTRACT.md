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
- **Verified live 2026-09-02** against workflow `agent-chat (prod webhook)` (workflow id `oAlPFsGVYAlhZami` in the local instance).

## Request body

```jsonc
{
  "message": "find me a serum under 2000 taka",   // user text (required)
  "conversation_id": "tmp-widget-<uuid>",           // optional; widget keeps it in localStorage
  "profile": { "skin": "Oily", "concern": "Acne", "budget": "Under Tk 1500" }, // optional, quiz
  "action": { "type": "variant-selected", "product_id": 100, "variant": "45ml", "quantity": 1 } // optional; resumes a human-in-the-loop step
}
```

`action` is how the widget answers a `variant-picker` / `approval` block (see **Human-in-the-loop** below). Omit it for a normal turn.

## Response (HTTP 200, `application/json`)

```jsonc
{
  "reply": "string",                 // agent text (mirror of $fromAI('output'))
  "conversation_id": "string",       // echoed when provided, else a fresh guest id
  "blocks": [ ...OutputBlock... ],   // may be empty array
  "suggestions": ["string", ...],    // optional; guided next-step chips (<=3 shown)
  "token_usage": null                // reserved; see note below
}
```

- `suggestions` is **optional**. When present, the widget renders them as the "Suggested next steps" chips under the reply and they take precedence over the client-derived ones. When absent, the widget derives contextual chips from the turn's blocks and the customer's profile, so every reply still offers a clear next step. A legacy `chips` array is also accepted.

- **No token streaming, no inline approvals.** The widget waits for the full body (plain `response.json()`), shows a spinner meanwhile.
- `token_usage` is **always `null`** — re-verified on n8n `2.40.5` (2026-09-22, the current `latest` image) and it was `null` on `2.37.6` before that, so it is a platform limit rather than a bug we can fix in the workflow: the Agent node's output is only `{output, intermediateSteps}` (this version never emits `tokenUsage`), and n8n's expression data proxy cannot read the `ai_languageModel` sub-node that actually holds the per-call usage — `$('OpenAI Chat Model')`, `$node[...]` and `.all()`/`.first()` all throw `No data found from 'main' input`. The field is kept in the response so a future n8n that does expose it needs no contract change. **For real per-turn cost, read n8n's own Postgres** (`metadata.tracing['llm.tokens.in'|'out']` per execution), which is what `dev/prod-bench.mjs` does — it sums the orchestrator **and** its child specialist executions.
- `reply` may be empty when `blocks` is non-empty (a blocks-only turn, e.g. cart table).
- `blocks` types are the widget's existing `OutputBlock` union:
  `product-grid` | `product-carousel` | `comparison` | `category-carousel` | `rich-text` | `info-cards` | `chips` | `cart-table` | `order-status` | `variant-picker` | `approval`.

### `order-status` (order tracking)

Emitted when the order specialist finds an order. **It carries no personal data** — the specialist strips identity before building it, so the customer's name, phone, email and address never leave the n8n host:

```jsonc
{ "type": "order-status", "order": {
  "code": "TEST2026080810292989",
  "placedAt": "08-08-2026",
  "status": "pending",              // store delivery_status -> drives the progress stepper
  "statusLabel": "Order Placed",
  "paymentStatus": "unpaid", "paymentStatusLabel": "Unpaid", "paymentMethod": "Sslcommerz Payment",
  "shippingType": "Home Delivery", "shippingMethod": "Pathao",
  "eta": "1-2 business days",
  "itemCount": 1, "subtotal": 1900, "shippingCost": 60, "discount": 0, "tax": 0, "total": 1960,
  "items": [ { "name": "Anua Peach 77 Niacin Essence Toner", "variant": null, "quantity": 1, "price": 1900, "image": "uploads/all/1(31).jpg" } ]
} }
```

The widget maps `status` onto a 5-step fulfilment flow (Order Placed → Confirmed → **Packaging** → Out for Delivery → Delivered; `cancelled`/`returned`/`failed` render as a terminal state). Keep that map in step with the store's own `delivery_status` values — they are the store's, not ours (`pending`, `confirmed`, `hold`, `packaging`, `picked_up`, `on_the_way`, `shipped`, `delivered` — confirmed against the `orders` table). The ETA line is hidden once the order is delivered or terminal.

## Human-in-the-loop (variant-picker / approval)

Two things pause a cart action and hand it to the customer. Both work the same way: the agent ends its turn with a blocks-only answer, the widget renders buttons, and the customer's tap starts the **next** turn carrying an `action` that resumes the exact call. The cart tool does not run until the customer acts.

This is the in-widget equivalent of n8n's *Human review for tools*. n8n's own version needs an external channel (Slack/Telegram/…); here the customer is the reviewer, inside the widget.

### When the agent asks

| Situation | Block | META footer the agent emits |
|---|---|---|
| Product has size options and the customer hasn't chosen one | `variant-picker` | `META_VARIANT_PRODUCT_ID: <id>` + `[BLOCK variant-picker]` |
| Not a clear single-product buy (ideas / "add some random products"), 2+ products at once, or it would replace the cart | `approval` | `META_APPROVAL_JSON: {…}` + `[BLOCK approval]` |

A single product the customer clearly names and asks to buy is added directly — no gate. The agent prompt carries the exact rules.

### Blocks

```jsonc
// variant-picker — options are re-fetched live from /api/v3/products/{id} (ground truth)
{ "type": "variant-picker", "productId": 100, "productName": "Sheglam Good Grip Hydrating Primer",
  "image": "uploads/all/file_xxx.jpg",
  "options": [ { "name": "15ml", "price": 700, "qty": 5 }, { "name": "45ml", "price": 1250, "qty": 4 } ] }

// approval — items are exactly the cart-add(s) the agent will run on approve
{ "type": "approval", "action": "cart-add", "summary": "Add 2 items to your cart",
  "items": [ { "product_id": 100, "name": "Sheglam Good Grip", "variant": "45ml", "quantity": 1, "price": 1250 } ],
  "approveLabel": "Add to cart", "denyLabel": "Cancel" }
```

### What the widget sends back

The tap posts a normal turn with a structured `action` (same `conversation_id`, so the cart and memory stay put):

```jsonc
// a variant option was tapped -> the agent calls cart-add with these exact values
{ "type": "variant-selected", "product_id": 100, "variant": "45ml", "quantity": 1 }

// approve / decline -> the agent runs (or skips) each item in `items`
{ "type": "approval", "decision": "approve", "action": "cart-add",
  "items": [ { "product_id": 100, "name": "Sheglam Good Grip", "variant": "45ml", "quantity": 1 } ] }
{ "type": "approval", "decision": "decline", "items": [ … ] }
```

The workflow's `Prepare Input` node turns `action` into a `CUSTOMER ACTION: …` line in the agent's context, so the resumed turn executes the add verbatim instead of re-deciding. On decline the agent acknowledges and adds nothing.

> **Verified live 2026-09-28:** variant-selected → store line `Sheglam Good Grip (15ml) @700`; approve → `(45ml) @1250`; decline → no cart change. `node dev/eval-harness.mjs --group hitl` covers all three.

## Guest cart plumbing (verified in Step 2)

The widget's cart IS the store's guest cart. One shared `conversation_id` maps to the store cart's `tmp_*` user id:

- conversation_id `tmp-widget-<uuid>` → guest cart `user_id=tmp-widget-<uuid>` (store's `is_guest_user` middleware reads `tmp*` as `temp_user_id`).
- n8n **echoes** the same id back (see above). If the widget doesn't send one, n8n mints `tmp-widget-<uuid>` and returns it — the widget stores it on the active conversation so a session keeps one cart.
- The widget keeps a **list of conversations** (localStorage `perfecto_sessions_v1`, plus `perfecto_active_session` for the selected one). Each conversation keeps its own `conversation_id`, so switching chats switches the agent's memory *and* its guest cart — the same behaviour the old single-session "Reset session" button had.

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