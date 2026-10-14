// eval-harness.mjs — external end-to-end eval battery for the agent-chat webhook.
// Talks to the n8n webhook exactly like the widget does (full-response wait) and
// verifies BEHAVIOR against the real store (products, cart side-effects).
//
// Not n8n-native by design (PLAN.md Part 2): keeps the grader independent of the
// thing being graded, and can run against local or VPS later.
//
// Usage:
//   node dev/eval-harness.mjs [--webhook URL] [--store URL] [--group all|contract|product|search|cart|hitl|support|memory|profile|language|offers]
//   node dev/eval-harness.mjs --out report.json
//
// Exit code 0 = no HARD failures; 1 = at least one HARD failure.
// Asserts are tagged: hard = deterministic/structural (blocks, numbers, side-effects),
//                     soft = LLM prose (may vary wording).
//
// Conventions honored from the store repo: never touch the store DB; only its HTTP API.

import fs from 'node:fs';

const ARGS = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]?.startsWith('--') ? true : (arr[i + 1] ?? true)] : null)).filter(Boolean));
const WEBHOOK = ARGS.webhook ?? 'http://localhost:5678/webhook/spike/agent-chat';
const STORE = String(ARGS.store ?? 'http://fastmart-pro.test').replace(/\/+$/, '');
const GROUP = ARGS.group ?? 'all';
// The webhook requires JWT Auth as of 2026-10-14 (static shared-secret bearer
// token — see WIDGET-CONTRACT.md). --token overrides env, env overrides the
// dev instance's own default so a bare `node dev/eval-harness.mjs` still works
// against this instance without extra setup.
const AUTH_TOKEN = ARGS.token ?? process.env.N8N_WEBHOOK_AUTH_TOKEN ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwZXJmZWN0by13aWRnZXQiLCJpYXQiOjE3OTE5ODA3NDIsImV4cCI6MjEwNzM0MDc0Mn0.UjEBut1tocYYicFMF-D-nJ5CQuKxGFSRRZTuJRmF4o4';
const REPORT = ARGS.out ? String(ARGS.out) : null;
const TIMEOUT_MS = 120000;
const RUN = 'e' + Date.now().toString(36); // unique per run -> no cross-run chat-memory bleed
const CART_ID = `tmp-evalc-${RUN}`;
const MEM_ID = `tmp-evalm-${RUN}`;

const now = () => Date.now();
let passed = 0, failed = 0, warns = 0, cases = [];

function stripExtraneous(t) {
  // store error/debug pages can prefix JSON in dev. Pick the EARLIEST of { or [ —
  // the cart read returns a JSON ARRAY, and looking only for "{" left the trailing
  // "]" in place (invalid JSON), which made storeCart() silently return [].
  const i = t.indexOf('{');
  const j = t.indexOf('[');
  const start = Math.min(i < 0 ? Infinity : i, j < 0 ? Infinity : j);
  return start === Infinity ? t : t.slice(start);
}
async function postChat(body) {
  // The workflow now requires `user_id` (see WIDGET-CONTRACT.md, 2026-10-12) and
  // no longer mints one on its own — the real widget always has one before it
  // sends the first message, so mirror conversation_id into it (or mint a fresh
  // one when a case sends neither) the same way the real widget does.
  const full = { ...body };
  if (full.user_id === undefined) full.user_id = full.conversation_id ?? ('tmp_eval_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  const t0 = now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` }, body: JSON.stringify(full), signal: ctrl.signal });
    const txt = stripExtraneous(await r.text());
    const json = txt ? JSON.parse(txt) : null;
    return { status: r.status, json, ms: now() - t0 };
  } catch (e) {
    return { status: 0, json: null, ms: now() - t0, error: e.message };
  } finally { clearTimeout(timer); }
}
async function storeCart(userId) {
  const r = await fetch(`${STORE}/api/v3/carts/${encodeURIComponent(userId)}`, { method: 'POST' });
  const t = await r.text();
  const rows = [];
  try {
    const j = JSON.parse(stripExtraneous(t));
    if (Array.isArray(j)) {
      for (const shop of j) for (const it of (shop?.cart_items ?? [])) {
        if (!it) continue;
        rows.push({ id: String(it.id ?? rows.length + 1), product_id: it.product_id, name: it.product_name, variation: it.variation ?? null, price: Number(it.price) || 0, quantity: Number(it.quantity) || 0 });
      }
    }
  } catch {}
  return rows;
}
// The orchestrator prompt legitimately picks either block for a product list
// (grid vs. carousel) — recognize both, otherwise this falsely "fails" on a
// correct answer purely because the model chose the other valid layout.
const cardsOf = (d) => d.blocks?.find((b) => b.type === 'product-grid' || b.type === 'product-carousel')?.products ?? [];
const cartOf = (d) => d.blocks?.find((b) => b.type === 'cart-table');
const checkoutOf = (d) => d.blocks?.find((b) => b.type === 'checkout');

function check(name, hard, fn) {
  return async () => {
    const t0 = now();
    const rec = { name, hard, at: new Date().toISOString(), ms: 0, ok: false, level: '', detail: '' };
    try {
      const res = await fn();
      rec.ms = now() - t0;
      rec.ok = !!res.ok;
      rec.detail = res.detail ?? '';
      rec.level = rec.ok ? 'pass' : hard ? 'FAIL' : 'WARN';
    } catch (e) {
      rec.ms = now() - t0;
      rec.ok = false;
      rec.level = hard ? 'FAIL' : 'WARN';
      rec.detail = 'threw: ' + e.message;
    }
    if (rec.level === 'pass') passed++;
    else if (rec.level === 'FAIL') failed++;
    else warns++;
    cases.push(rec);
    console.log(`  ${rec.level === 'pass' ? 'PASS' : rec.level}  ${name}  (${(rec.ms / 1000).toFixed(1)}s)${rec.detail ? ' — ' + rec.detail : ''}`);
  };
}
function run(group, list) { return list.filter((c) => group === 'all' || c[1] === group).map(([name, grp, hard, fn]) => check(name, hard, fn)); }

// ---------------------------------------------------------------------------
// Case battery
// ---------------------------------------------------------------------------
const battery = [];

// ---- product --------------------------------------------------------------
battery.push(['product-grid on serum search', 'product', true, async () => {
  const { status, json } = await postChat({ message: 'find me face serums' });
  if (status !== 200 || !json) return { ok: false, detail: `http ${status} / no json` };
  const cards = cardsOf(json);
  const bad = cards.filter((c) => !c.id || !c.name || !(c.price > 0) || !c.image);
  if (!cards.length) return { ok: false, detail: 'no product-grid block' };
  if (bad.length) return { ok: false, detail: `${bad.length} invalid cards` };
  const taka = (json.reply || '').includes('\u09f3');
  return { ok: true, detail: `${cards.length} cards, price ok, taka=${taka}` };
}]);

battery.push(['no invented product for nonsense query', 'product', false, async () => {
  const { json } = await postChat({ message: 'do you sell the ZzzqQx brand of face serum?' });
  const r = json?.reply ?? '';
  const namesItAsReal = /ZzzqQx[^\n]{0,80}\u09f3/.test(r); // recommending a price for the fake brand
  const negates = /not|no |don'?t|couldn|unavailable|can'?t|doesn'?t|carry/i.test(r);
  return { ok: r.length > 10 && negates && !namesItAsReal, detail: r.slice(0, 90) };
}]);

// ---- contract ---------------------------------------------------------------
// user_id became REQUIRED 2026-10-12 (see WIDGET-CONTRACT.md) \u2014 the workflow no
// longer mints one from conversation_id on its own. This calls the webhook raw
// (not through postChat, which deliberately back-fills user_id for every other
// case here) so it actually exercises the "neither field sent" path a brand new,
// misconfigured, or third-party caller could hit.
battery.push(['user_id is required \u2014 a request with neither field 400s, not 500s', 'contract', true, async () => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let r;
  try {
    r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH_TOKEN}` }, body: JSON.stringify({ message: 'hello' }), signal: ctrl.signal });
  } finally { clearTimeout(timer); }
  const txt = stripExtraneous(await r.text());
  let json = null; try { json = txt ? JSON.parse(txt) : null; } catch {}
  // A clean 400 with the documented error is correct; a 500 ("Error in workflow")
  // means the missing-id case crashes downstream nodes instead of failing cleanly
  // \u2014 this is exactly the failure mode a 2026-10-12 incident produced live.
  const ok = r.status === 400 && json?.error === 'user_id is required';
  return { ok, detail: `http ${r.status} \u2014 ${JSON.stringify(json)}` };
}]);

// ---- cart (sequential on one guest id: add -> view -> remove) -------------
// Cart totals/blocks come from the store's own cart reads inside the workflow
// (independent cookie-less HTTP requests each turn — the same channel the widget
// uses), so agreement across turns IS the persistence check. Direct host DB/API
// read-backs of guest (tmp-*) carts are unstable in this store (session nuances),
// so we assert what the end user actually sees.
let cartTotal = 0;
let cartLineName = '';

// Product choice matters here: "iUNIK Tea Tree Relief Serum" used to be this
// case's product, but the catalog carries TWO products with that exact name
// (one in-stock, one not) and repeated eval runs against the shared staging
// store eventually depleted the in-stock one's real inventory to 0 (verified
// 2026-10-14 directly against the store) — a false "FAIL" with nothing wrong
// in the workflow, not a flake to chase. Swapped to a uniquely-named,
// no-variant product so this case tests the add/persist/remove flow itself,
// not catalog stock levels.
battery.push(['cart add reports a real persisted line', 'cart', true, async () => {
  const d0 = await postChat({ message: 'add Dot & Key 10% Vitamin C+E Super Bright Face Serum to my cart', conversation_id: CART_ID });
  if (d0.status !== 200 || !d0.json) return { ok: false, detail: 'http/chat failed' };
  const ct = cartOf(d0.json);
  if (!ct || !(ct.total > 0) || !ct.items?.length) return { ok: false, detail: `no cart-table (total ${ct?.total})` };
  cartTotal = ct.total;
  cartLineName = ct.items[0].name ?? '';
  const grid = cardsOf(d0.json);
  const priceMatch = grid.some((g) => g.price === ct.total) || ct.items.every((i) => i.price * i.quantity === ct.total);
  const replyTotal = (d0.json.reply ?? '').replace(/,/g, '').includes(String(cartTotal));
  if (!priceMatch) return { ok: false, detail: 'grid/cart totals disagree' };
  if (!replyTotal) return { ok: false, detail: 'reply does not quote the cart total' };
  return { ok: true, detail: `add reported ${cartLineName} total ${cartTotal}` };
}]);

battery.push(['cart persists to a later view', 'cart', true, async () => {
  const { json } = await postChat({ message: 'show me my cart', conversation_id: CART_ID });
  const ct = cartOf(json);
  if (!ct || !(ct.total > 0)) return { ok: false, detail: `later view empty (total ${ct?.total})` };
  if (ct.total !== cartTotal) return { ok: false, detail: `view total ${ct.total} != add total ${cartTotal}` };
  return { ok: true, detail: `view sees same line total ${ct.total}` };
}]);

battery.push(['cart remove empties it', 'cart', true, async () => {
  await postChat({ message: 'remove the serum from my cart', conversation_id: CART_ID });
  const { json } = await postChat({ message: 'is my cart empty now?', conversation_id: CART_ID });
  const ct = cartOf(json);
  const reply = json?.reply ?? '';
  // NOTE: the dev store's guest-cart READ is intermittently flaky — a line added
  // one turn can read as empty the next (store-side session quirk, documented in
  // PLAN.md). The chat is honest to what the store returns, so the remove case
  // asserts the user-visible outcome: after remove, no view still shows the
  // serum with a non-zero total. If the line already vanished (store flake),
  // every read says empty — correct from the customer's perspective.
  const stillShowsSerum = !!ct && ct.total > 0 && (ct.items ?? []).some((i) => /iUNIK|serum/i.test(i.name ?? ''));
  const saysEmpty = /(empty|nothing|no item|none|৳\s*0)/i.test(reply);
  return { ok: !stillShowsSerum && saysEmpty, detail: reply.slice(0, 120) };
}]);

// ---- checkout (block-signal only — this app never builds a checkout URL/redirect) ---
// Uses a different product than the cart group's (the iUNIK one is known-flaky on
// the shared staging catalog, see AGENTS.md §5) so this doesn't inherit that flake.
const CHECKOUT_ID = `tmp-evalco-${RUN}`;
battery.push(['checkout intent with items emits the checkout block', 'cart', true, async () => {
  // A known no-variant, reliably-searchable product (same pattern as the HITL
  // battery picking product 100 deliberately) - "cheapest facewash" would risk
  // landing on a size-option product and pausing on a variant-picker instead of
  // actually adding, leaving nothing to check out.
  const add = await postChat({ message: 'add Dot & Key 10% Vitamin C+E Super Bright Face Serum to my cart', conversation_id: CHECKOUT_ID });
  if (add.status !== 200 || !add.json) return { ok: false, detail: 'add turn failed' };
  const { status, json } = await postChat({ message: "I'm ready to checkout", conversation_id: CHECKOUT_ID });
  if (status !== 200 || !json) return { ok: false, detail: `http ${status}` };
  const co = checkoutOf(json);
  if (!co) return { ok: false, detail: `no checkout block: ${JSON.stringify((json.blocks || []).map((b) => b.type))}` };
  const ok = co.total > 0 && Array.isArray(co.items) && co.items.length > 0 && (json.suggestions ?? []).length === 0;
  return { ok, detail: `total=${co.total} items=${co.items?.length} suggestions=${JSON.stringify(json.suggestions)}` };
}]);

battery.push(['checkout intent with an empty cart does not emit the block', 'cart', true, async () => {
  const { status, json } = await postChat({ message: 'I want to checkout', conversation_id: `tmp-evalco-empty-${RUN}` });
  if (status !== 200 || !json) return { ok: false, detail: `http ${status}` };
  const co = checkoutOf(json);
  const reply = json.reply ?? '';
  const saysEmpty = /(empty|nothing|no item|haven'?t added)/i.test(reply);
  return { ok: !co && saysEmpty, detail: reply.slice(0, 120) };
}]);

// ---- human-in-the-loop (variant-picker / approval) -------------------------
// A paused tool call resumes when the widget posts a structured `action`. These
// cases drive that path directly (they do NOT need product search), which is
// exactly what the SPA sends when the customer taps an option / Approve.
// Product 100 (Sheglam Good Grip Hydrating Primer) has size options 15ml/45ml.
const HITL_VARIANT_CART = `tmp-evalh-${RUN}v`;
const HITL_APPROVE_CART = `tmp-evalh-${RUN}a`;
const HITL_DECLINE_CART = `tmp-evalh-${RUN}d`;

battery.push(['variant-picker choice resumes the add', 'hitl', true, async () => {
  const { status, json } = await postChat({ message: 'Add Sheglam Good Grip Hydrating Primer (15ml)', conversation_id: HITL_VARIANT_CART, action: { type: 'variant-selected', product_id: 100, variant: '15ml', quantity: 1 } });
  if (status !== 200 || !json) return { ok: false, detail: `http ${status}` };
  const rows = await storeCart(HITL_VARIANT_CART);
  const line = rows.find((r) => Number(r.product_id) === 100 && /15ml/i.test(String(r.variation || '')));
  if (!line) return { ok: false, detail: `store cart has no 15ml line: ${JSON.stringify(rows)}` };
  return { ok: true, detail: `store line ${line.name} (${line.variation}) @${line.price}` };
}]);

battery.push(['approval approve executes the cart-add', 'hitl', true, async () => {
  const { status, json } = await postChat({ message: 'Yes, add it', conversation_id: HITL_APPROVE_CART, action: { type: 'approval', decision: 'approve', action: 'cart-add', items: [{ product_id: 100, variant: '45ml', quantity: 1, name: 'Sheglam Good Grip (45ml)' }] } });
  if (status !== 200 || !json) return { ok: false, detail: `http ${status}` };
  const rows = await storeCart(HITL_APPROVE_CART);
  const line = rows.find((r) => Number(r.product_id) === 100 && /45ml/i.test(String(r.variation || '')));
  if (!line) return { ok: false, detail: `store cart has no 45ml line: ${JSON.stringify(rows)}` };
  return { ok: true, detail: `store line ${line.variation} @${line.price}` };
}]);

battery.push(['approval decline changes nothing', 'hitl', true, async () => {
  const { status, json } = await postChat({ message: 'No thanks', conversation_id: HITL_DECLINE_CART, action: { type: 'approval', decision: 'decline', action: 'cart-add', items: [{ product_id: 100, variant: '45ml', quantity: 1, name: 'Sheglam Good Grip (45ml)' }] } });
  if (status !== 200 || !json) return { ok: false, detail: `http ${status}` };
  const rows = await storeCart(HITL_DECLINE_CART);
  if (rows.length) return { ok: false, detail: `decline still added: ${JSON.stringify(rows)}` };
  const saysNo = (json.reply || '').length > 0;
  return { ok: saysNo, detail: (json.reply || '').slice(0, 110) };
}]);

// Search-dependent: the agent must OFFER the picker (not guess a size) for a
// size-option product. Soft — it needs the store's search index to be up.
battery.push(['size-option product is asked via picker, not guessed', 'hitl', false, async () => {
  const { json } = await postChat({ message: 'add the Sheglam Good Grip Hydrating Primer to my cart' });
  const vp = json?.blocks?.find((b) => b.type === 'variant-picker');
  if (!vp) return { ok: false, detail: 'no variant-picker block: ' + JSON.stringify((json?.blocks || []).map((b) => b.type)) };
  const ok = vp.options?.length >= 2 && vp.options.every((o) => o.name && typeof o.price === 'number');
  return { ok, detail: `${vp.productName}: ${JSON.stringify(vp.options)}` };
}]);

// ---- search quality ---------------------------------------------------------
// "cheapest facewash" used to surface a pricier item (or even miss the catalog's
// actually-cheapest match entirely) because the search tool never sorted by
// price — see dev/build-workflows.mjs SEARCH_CODE (fixed 2026-10-12). Catalog
// prices can drift, so this asserts the STRUCTURAL guarantee (ascending order
// among whatever cards came back), not a specific product or price.
battery.push(['"cheapest" query returns price-ascending results', 'search', true, async () => {
  const { json } = await postChat({ message: 'cheapest facewash' });
  const cards = cardsOf(json);
  if (cards.length < 2) return { ok: false, detail: `only ${cards.length} card(s), can't verify ordering` };
  const prices = cards.map((c) => c.price);
  const ascending = prices.every((p, i) => i === 0 || p >= prices[i - 1]);
  return { ok: ascending, detail: `prices: ${JSON.stringify(prices)}` };
}]);

// A color/shade ask like "maroon lipstick" used to return ZERO results — the
// store's keyword search is a literal match against the product NAME only, and
// no product is ever literally named a color (fixed 2026-10-13: the color word
// is stripped before the store call; shade names are surfaced so the model can
// judge the match itself). The exact shade picked is a judgment call (soft);
// that real products come back at all is the hard, structural guarantee.
battery.push(['color/shade search ("maroon lipstick") finds real products', 'search', true, async () => {
  const { json } = await postChat({ message: 'I want a maroon lipstick' });
  const cards = cardsOf(json);
  return { ok: cards.length > 0, detail: cards.length ? `${cards.length} cards: ${cards.map((c) => c.name).join(', ')}` : (json?.reply ?? '').slice(0, 120) };
}]);

// The model is asked (dev/prompts.js PRODUCT_DISCOVERY) not to re-list
// "- **Name** – ৳price" in prose when the product-grid card already shows it,
// which proved unreliable through 3 prompt rewrites, so a deterministic strip
// backstop lives in the Response node (dev/build-main.mjs, 2026-10-13). This
// is the regression test for that backstop, not for prompt wording.
battery.push(['multi-product reply does not re-list names/prices already on the cards', 'search', true, async () => {
  const { json } = await postChat({ message: 'cheapest facewash' });
  const cards = cardsOf(json);
  if (cards.length < 2) return { ok: false, detail: `only ${cards.length} card(s), test needs 2+` };
  const lines = (json?.reply ?? '').split('\n');
  const redundantLines = lines.filter((l) => {
    const t = l.trim();
    if (!/^[-*•●‣·]\s*/.test(t)) return false;
    const rest = t.replace(/^[-*•●‣·]\s*/, '');
    const boldSpans = rest.match(/\*\*(.+?)\*\*/g) || [];
    return boldSpans.length === 1 && !/\b(shade|step|morning|night|variant)\b/i.test(rest);
  });
  return { ok: redundantLines.length === 0, detail: redundantLines.length ? JSON.stringify(redundantLines) : `clean prose, ${cards.length} cards carry the details` };
}]);

// ---- offers -----------------------------------------------------------------
// "show me current offers" used to have no answer at all (no tool covered it) -
// the agent either refused as off-topic or invented a sale. This asserts a real,
// on-topic answer came back; whether the store currently HAS an active flash
// sale/combo is data, not something this test controls, so it accepts either a
// real offer summary or an honest "nothing on right now" - never a refusal or a
// fabricated discount.
battery.push(['asks for current offers gets a real answer, not a refusal', 'offers', true, async () => {
  const { status, json } = await postChat({ message: 'What offers do you have right now?' });
  if (status !== 200 || !json) return { ok: false, detail: `http ${status}` };
  const r = json.reply ?? '';
  const refused = /shopping assistant here|outside what I can help|can'?t help with that/i.test(r);
  const looksLikeAnswer = /offer|deal|discount|sale|promo|combo/i.test(r) || cardsOf(json).length > 0;
  return { ok: !refused && looksLikeAnswer && r.length > 5, detail: r.slice(0, 150) };
}]);

// ---- support --------------------------------------------------------------
battery.push(['return policy answer', 'support', false, async () => {
  const { json } = await postChat({ message: 'what is your return policy?' });
  const r = json?.reply ?? '';
  return { ok: /\b14\b/.test(r) && /return/i.test(r), detail: r.slice(0, 90) };
}]);
battery.push(['delivery answer', 'support', false, async () => {
  const { json } = await postChat({ message: 'how long does delivery take?' });
  const r = json?.reply ?? '';
  return { ok: /\bday/.test(r) && r.length > 15, detail: r.slice(0, 90) };
}]);
battery.push(['order track is honest for bogus code', 'support', false, async () => {
  const { json } = await postChat({ message: 'track my order PERF-0000' });
  const r = json?.reply ?? '';
  const fabricated = /shipped|delivered|on the way|out for delivery/i.test(r);
  const honest = /not find|couldn'?t|no order|check/i.test(r);
  return { ok: !fabricated && honest, detail: r.slice(0, 110) };
}]);

// ---- memory (PG memory continuity) -----------------------------------------
battery.push(['remembers earlier detail across turns', 'memory', false, async () => {
  await postChat({ message: 'remember this for later: my skin is very oily and I want under 700 taka', conversation_id: MEM_ID });
  const { json } = await postChat({ message: 'what skin type and budget did I tell you?', conversation_id: MEM_ID });
  const r = json?.reply ?? '';
  return { ok: /oily/i.test(r) && /\b700\b/.test(r), detail: r.slice(0, 110) };
}]);

// ---- profile awareness -------------------------------------------------------
// When recommending for a general need, the orchestrator should give its best
// answer with whatever it knows, then ask ONE combined question for whichever
// of skin/concern/budget CUSTOMER PROFILE marks "not provided" — never block
// the recommendation on it, and never re-ask a field already saved (dev/
// prompts.js ORCHESTRATOR + dev/build-main.mjs Prepare Input, 2026-10-13).
// Wording is the model's own, so these are soft — they check for the shape of
// "did it ask", not an exact phrase.
function trailingQuestion(r) {
  const m = String(r ?? '').match(/[^.!?\n]*\?\s*$/);
  return m ? m[0] : '';
}
const mentionsProfileField = (s) => /\bskin\b|\bconcern\b|\bbudget\b/i.test(s);

battery.push(['no saved profile: still recommends, then asks what is missing', 'profile', false, async () => {
  const { json } = await postChat({ message: 'what moisturizer should I use' });
  const cards = cardsOf(json);
  const q = trailingQuestion(json?.reply);
  return { ok: cards.length > 0 && !!q && mentionsProfileField(q), detail: `cards=${cards.length}, trailing question: "${q}"` };
}]);

battery.push(['full saved profile: recommends without re-asking', 'profile', false, async () => {
  const { json } = await postChat({ message: 'what moisturizer should I use', profile: { skin: 'Oily', concern: 'Acne', budget: 'Under Tk 1500' } });
  const cards = cardsOf(json);
  const q = trailingQuestion(json?.reply);
  // A trailing "?" is fine (e.g. "want me to add one?") as long as it is not
  // itself asking for skin/concern/budget, since all three are already known.
  const reaskedProfile = !!q && mentionsProfileField(q);
  return { ok: cards.length > 0 && !reaskedProfile, detail: `cards=${cards.length}, trailing question: "${q}"` };
}]);

battery.push(['partial saved profile: asks only for what is still missing', 'profile', false, async () => {
  const { json } = await postChat({ message: 'what moisturizer should I use', profile: { skin: 'Dry' } });
  const cards = cardsOf(json);
  const q = trailingQuestion(json?.reply);
  const asksBudgetOrConcern = /\bconcern\b|\bbudget\b/i.test(q);
  const reasksSkinType = /what'?s? your skin type|your skin type\b.*\?/i.test(q);
  return { ok: cards.length > 0 && asksBudgetOrConcern && !reasksSkinType, detail: `cards=${cards.length}, trailing question: "${q}"` };
}]);

// ---- language --------------------------------------------------------------
battery.push(['replies in Bengali when asked in Bengali', 'language', false, async () => {
  const { json } = await postChat({ message: 'আপনার রিটার্ন পলিসি কী?' });
  const r = json?.reply ?? '';
  const hasBangla = /[\u0980-\u09FF]/.test(r);
  const hasReturn = /return|রিটার্ন/i.test(r);
  return { ok: r.length > 10 && (hasBangla || hasReturn), detail: r.slice(0, 90) };
}]);

// ---------------------------------------------------------------------------
const toRun = run(GROUP, battery);
console.log(`Eval harness — webhook ${WEBHOOK}\nstore ${STORE}\ngroup=${GROUP}, cases=${toRun.length}, hard=${battery.filter((b) => b[2]).length}\n`);
console.log('Each case waits for a full agent turn (10-60s).\n');

for (const c of toRun) await c();
await new Promise((r) => setTimeout(r, 500));

const summary = { webhook: WEBHOOK, store: STORE, group: GROUP, at: new Date().toISOString(), passed, failed, warns, total: cases.length, cases };
console.log('\n' + '='.repeat(56));
console.log(`SUMMARY  pass=${passed}  fail=${failed}  warn=${warns}  total=${cases.length}`);
if (REPORT) {
  fs.writeFileSync(REPORT, JSON.stringify(summary, null, 2));
  console.log('report ->', REPORT);
}
process.exit(failed > 0 ? 1 : 0);
