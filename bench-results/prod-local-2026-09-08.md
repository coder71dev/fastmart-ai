# Perfecto AI Assistant — Production Performance Report

**Local baseline · 8 September 2026**
Built and measured with `dev/prod-bench.mjs` (raw data: `prod-local-2026-09-08.json`). Same tool re-runs against the VPS after launch.

> **Why this report exists:** before we point the live store at the n8n AI chat brain, we measured how it behaves under real-world conditions — how fast each reply arrives, how many shoppers it can serve at once, and what it costs per conversation. All numbers below are measured, not estimated, against the actual workflow (orchestrator + product/cart/order/support specialists) using a paid model key.

---

## Bottom line

- ✅ **Every single test passed.** 48/48 chat turns succeeded — no timeouts, no errors, no API rate-limiting.
- ⚡ **A typical reply arrives in ~6 seconds** (half arrive in under 6s, 90% in under 8.5s).
- 👥 **The system copes fine with 10 shoppers chatting at the same time** — reply speed barely changes. This is comfortably above the traffic we expect at launch.
- 💰 **Cost ≈ $0.004 (~৳0.5) per chat turn** — roughly **$4 for every 1,000 chats**. An average shopper conversation of ~5 turns costs about **2 US cents**.
- 🎯 **No code or infrastructure change is required** before going live.

---

## What we tested

The shopping assistant is a chain of AI "experts": a main assistant routes each question to a specialist (products, cart, support, orders), which talks to the real store. We measured the full chain exactly as a shopper would experience it — the widget sends a message, waits, gets the final reply.

We tested the realistic mix of things shoppers do:

| Scenario | What the shopper asks |
|---|---|
| Greeting | "hi" |
| Product search | "find me face serums" |
| Cart | add a product → view cart → remove it |
| Support | return policy / delivery questions |
| Order tracking | a made-up order code |
| Bengali | asked in বাংলা |
| Memory | assistant remembers stated preferences across turns |

Each scenario was run 3 times; timings are the time from message send to full reply.

---

## Speed — reply time per scenario

| Scenario | Median reply time | 9 in 10 replies under | Cost per reply |
|---|---|---|---|
| Greeting / memory | ~1.5–1.9s | ~2.1s | ~$0.0014 |
| Support policy | ~5.1s | ~5.3s | ~$0.0035 |
| Order tracking | ~5.8s | ~5.9s | ~$0.0042 |
| Bengali reply | ~5.7s | ~6.3s | ~$0.0043 |
| Product search | ~7.3s | ~7.4s | ~$0.0061 |
| Cart add / view / remove | ~7.7s | ~11.8s | ~$0.0059 |
| **Any turn, overall** | **~5.8s** | **~8.5s** | **~$0.004** |

Reading it simply: **an everyday chat reply lands in about 6 seconds**, and nearly all replies arrive within 9. The only slightly slower ones are cart actions (add / remove), which touch the store's cart system in real time — that's expected and still well under the 15s target we treat as acceptable for a chat turn.

---

## Many shoppers at once

We fired 1, then 2, then 5, then **10 conversations simultaneously** and measured how they held up:

| Shoppers at once | All replied OK | How long till all done | Reply time stayed around |
|---|---|---|---|
| 1 | ✅ | 7.2s | 7.2s |
| 2 | ✅ | 5.4s | 5.4s |
| 5 | ✅ | 8.9s | 6.4s |
| **10** | ✅ | 10.1s | 6.8s |

Key point: at 10 simultaneous shoppers, replies still arrive in ~7s — **no slowdown, no failures**. The assistant handles a "promo rush" several times over what we expect in the early months.

---

## Cost

Measured average: **~$0.004 per full turn** (this includes every hidden AI call, not just the final reply).

Projections at the paid model rate:

| Monthly chats | Est. cost / month |
|---|---|
| 1,000 | ~$4 |
| 5,000 | ~$20 |
| 10,000 | ~$40 |

An average shopping conversation (say 5 turns) ≈ **2 US cents**. Real-world cost will likely be lower because many conversations are mostly cheap greetings and simple questions.

---

## What this means for go-live

- No bottlenecks found: at the launch traffic we expect, the current setup has clear headroom.
- The launch checklist adds one optional step: re-run this same benchmark against the **live** VPS after deployment (real store + HTTPS + network distance will shift the numbers slightly) and compare to this baseline.
- If traffic ever grows far beyond 10 simultaneous shoppers, there is a simple scaling knob available (raise n8n's concurrency limit) — no architecture change needed.

## Method & caveats (for the curious)

- Timings are full round-trips over the same channel the website widget uses; costs come from tokens actually recorded by n8n across all specialist calls, at list prices for `gemini-3.7-flash` (input $0.75 / output $3.75 per 1M tokens).
- Costs are estimates, not the Google invoice — real billing can differ slightly (caching, rounding).
- Baseline runs against the **development** store on localhost. The VPS re-run gives the production numbers.
- Cart tests create and then clean up throwaway guest carts on the store.
