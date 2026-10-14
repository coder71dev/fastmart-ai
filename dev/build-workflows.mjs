// Builds n8n workflow JSON for Part 2 (specialists + agent-chat main).
//   node dev/build-workflows.mjs
// Writes into dev/out/ ready for dev/deploy.mjs.
import fs from 'node:fs';
import * as P from './prompts.js';
import { MODEL_NODE, modelNodeFields } from './model-config.mjs';
import { stableId } from './node-id.mjs';

const OUT = 'dev/out';
fs.mkdirSync(OUT, { recursive: true });

// Node ids are DERIVED FROM THE NODE NAME, not random — see dev/node-id.mjs.
// A random id on every build breaks canvas groups and any other n8n-side
// reference to the old id when the workflow is PATCHed.
const node = (o) => ({ id: stableId(o.name), disabled: false, ...o });
const pos = (x, y) => [x, y];

// Sub-workflow id for the slim search tool (assigned by n8n on deploy). On a
// fresh install: deploy dev/out/searchTool.json first, then rebuild with
// SEARCH_TOOL_ID=<id> so the specialist's tool node points at it.
const SEARCH_TOOL_ID = process.env.SEARCH_TOOL_ID || 'REPLACE_WITH_SEARCH_TOOL_ID';
// Same deal for the slim product-detail tool (DETAIL_CODE below): deploy
// dev/out/productDetailTool.json first, then rebuild with DETAIL_TOOL_ID=<id>.
const DETAIL_TOOL_ID = process.env.DETAIL_TOOL_ID || 'REPLACE_WITH_DETAIL_TOOL_ID';

// ---- language model node (shared; provider chosen in model-config.mjs) -----
function modelNode(x, y) {
  return node({ ...modelNodeFields(), position: pos(x, y) });
}

// ---- HTTP request tool (httpRequestTool 4.2, proven in spike) ------------
function httpTool({ name, description, method, url, queryParams, bodyParams }) {
  const p = {
    name,
    description,
    toolDescription: description,
    method,
    url,
    authentication: 'none',
    sendHeaders: false,
    options: { response: { response: { neverError: true, responseFormat: 'text', outputPropertyName: 'data' } } },
  };
  if (queryParams) {
    p.sendQuery = true;
    p.specifyQuery = 'manually';
    p.queryParameters = { parameters: queryParams };
  } else if (bodyParams) {
    p.sendBody = true;
    p.specifyBody = 'json';
    p.jsonBody = '={{ JSON.stringify({' + bodyParams.map((q) => JSON.stringify(q.name) + ': ' + q.expr).join(', ') + '}) }}';
  } else {
    p.sendBody = false;
  }
  return p;
}

// Generic tool text builder for specialist prompts (kept minimal; prompts are
// already self-describing, tools carry their own descriptions).

// ---- sub-workflow specialist -------------------------------------------------
function specialistWorkflow(name, promptText, { tools = [], formatJs, prepareJs, returnSteps = false, retry = false, maxIterations = 6 } = {}) {
  const nodes = [];
  const connections = {};

  nodes.push(
    node({
      parameters: { events: 'worklfow_call', inputSource: 'passthrough' },
      name: 'Sub Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1.2,
      position: pos(0, 0),
    }),
  );

  const prepare = node({
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        prepareJs ||
        `const q = $input.first().json.query ?? '';
return [{ json: { chatInput: String(q).trim() } }];`,
    },
    name: 'Prepare Task',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: pos(200, 0),
  });
  nodes.push(prepare);

  const agent = node({
    parameters: {
      promptType: 'define',
      text: '={{ $json.chatInput }}',
      // maxIterations caps how many LLM round-trips a specialist may spend. The
      // default (10) let product_discovery burn 38 parallel searches and then
      // return "Agent stopped due to max iterations." — see PLAN.md perf notes.
      options: { systemMessage: promptText, returnIntermediateSteps: !!returnSteps, maxIterations },
    },
    name: 'AI Agent',
    type: '@n8n/n8n-nodes-langchain.agent',
    typeVersion: 2,
    position: pos(400, 0),
    // The model API returns transient 503s under load; a retry keeps a blip from
    // costing the customer an answer. Only enabled for READ-ONLY specialists —
    // retrying a workflow that already mutated the cart could double-add.
    ...(retry ? { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 } : {}),
  });
  nodes.push(agent);
  connections['Sub Trigger'] = { main: [[{ node: 'Prepare Task', type: 'main', index: 0 }]] };
  connections['Prepare Task'] = { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] };
  connections[MODEL_NODE.nodeName] = { ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]] };

  nodes.push(modelNode(400, -180));

  let ty = 180;
  for (const t of tools) {
    const tn = node({
      parameters: t.params,
      name: t.name,
      type: t.type || 'n8n-nodes-base.httpRequestTool',
      typeVersion: t.typeVersion || 4.2,
      position: pos(640, ty),
    });
    nodes.push(tn);
    connections[tn.name] = { ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]] };
    ty += 160;
  }

  const fmt = node({
    parameters: {
      language: 'javaScript',
      jsCode:
        formatJs ||
        `const out = $input.first().json.output;
const raw = typeof out === 'string' ? out : (out?.output ?? JSON.stringify(out));
let text = String(raw ?? '').replace(/<[^>]+>/g, '').trim();
// Never hand the orchestrator the agent's raw "Agent stopped due to max
// iterations." — it used to be paraphrased into a vague apology for the
// customer. Product discovery salvages a real answer instead; the others say so
// plainly. (Same leak class, fixed in one place per specialist.)
if (/max iterations/i.test(text)) text = 'I could not finish that just now — could you rephrase it or narrow it down a little?';
return [{ json: { text } }];`,
    },
    name: 'Format Out',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: pos(400, 260),
  });
  nodes.push(fmt);
  connections['AI Agent'] = { main: [[{ node: 'Format Out', type: 'main', index: 0 }]] };

  const wf = { name, nodes, connections, settings: { executionOrder: 'v1' } };
  return wf;
}

// ---------------------------------------------------------------------------
// Slim product-search tool (its own sub-workflow).
// The store's /api/v4/products returns ~13 KB of JSON per call; the specialist
// used to shove that raw payload into its context on every search, which is what
// drove one turn to ~145k input tokens. This tool hits the same endpoint and
// returns one compact line per product — same facts, a fraction of the tokens.
// ---------------------------------------------------------------------------
const SEARCH_CODE = `
const j = $input.first().json ?? {};
const kw = String(j.query ?? j.input ?? '').trim().slice(0, 120) || 'popular';
const base = ($env.STORE_BASE_URL || 'http://fastmart-pro.test').replace(/\\/+$/, '');

// The store's keyword search ranks by RELEVANCE, never by price, and "limit=6"
// only ever samples that relevance-ranked order. For a price-driven ask (e.g.
// "cheapest facewash") the actual lowest-priced match in the catalogue often
// isn't even in that top-6 slice, and even among what IS returned, leaving the
// sort to the model is unreliable. When the ask looks price-driven, fetch a
// wider pool and re-sort it ourselves by the REAL price the customer pays —
// see num()/nonformated_price below, not the store's own "sort=price_low_high"
// (verified 2026-10-12: that sorts by the pre-discount "stroked" price, so a
// steeply-discounted item can rank behind a barely-discounted pricier one).
const wantsCheapest = /\\b(cheap(est)?|lowest|budget|afford(able)?|inexpensive|less\\s+than|under|below)\\b/i.test(kw);

// The price-indicator word above is an instruction to THIS TOOL (trigger the
// re-sort below) - it is never part of a product's actual name, so leaving it
// IN the STORE query breaks the literal-match search entirely (verified
// 2026-10-14: "cheapest facewash" = 0 results on both fastmart-pro.test and
// stg-admin.perfectobd.com, though "facewash" alone matches fine) - the exact
// same trap RATING_RE/COLOR_RE below already guard against, just missed for
// price. A trailing number right after it (e.g. "under 800 taka") is stripped
// too, for the same reason: a bare number also matches no product name.
// (global because a real phrasing like "affordable X under 500" matches this
// pattern TWICE - without /g, .replace() only strips the first occurrence and
// "under 500" survives in the store query, undoing the fix for that case.)
const PRICE_RE = /\\b(cheap(est)?|lowest|budget|afford(able)?|inexpensive|less\\s+than|under|below)\\b(\\s*(৳|bdt|taka)?\\s*[\\d,]+\\s*(taka|bdt|৳)?)?/gi;

// "Highest/top/best rated" or "most reviewed" (no specific product named) has
// nothing to search BY keyword — the catalogue's rating data is barely
// populated (verified 2026-10-14: a 1000-product sample out of 2687 total has
// only ~30 items with any rating at all, every one a 5.0 with 1-2 reviews) and
// none of those happen to match the "popular" fallback keyword this tool used
// before, so a customer asking for the highest-rated product got back
// whatever "popular" matched — all rating:0 — never the real 5-star items.
// The store's own sort= param is also a no-op here (verified: rating_high_low,
// top_rated, best_rating, highest_rating all return the identical order as no
// sort param at all) so there is no server-side rating sort to lean on either.
// Fix: strip the rating phrase out, then — IF a real product/category keyword
// is left (e.g. "serum" in "top rated serum") — keep searching scoped to it,
// just with a wider pool to rank within. Only go fully catalogue-wide (no
// keyword) when the ask has nothing left to scope by (e.g. just "highest
// rated products"). Same "fetch wide, re-sort for real" pattern as cheapest.
const RATING_RE = /\\b(highest|top|best|most)[\\s-]+(rated|rating|review(?:ed|s)?)\\b(\\s+(products?|items?|ones?))?/i;
const wantsRating = RATING_RE.test(kw);
const ratingResidual = wantsRating ? kw.replace(RATING_RE, ' ').replace(/\\s{2,}/g, ' ').trim() : '';
let workingKw = wantsRating ? ratingResidual : kw;
if (wantsCheapest) workingKw = workingKw.replace(PRICE_RE, ' ').replace(/\\s{2,}/g, ' ').trim() || workingKw;

// Color/shade asks ("maroon lipstick") are a dead end on both sides: the store's
// keyword search is a literal text match against the product NAME only, so a
// color word that appears nowhere in any product's name returns ZERO results
// (verified 2026-10-13: "maroon lipstick" = 0 hits, "lipstick" alone = 10) — so
// the color word must come OUT of the store query. And shades are free-text
// marketing names ("Brick Pink", "Scarlet Whisper"), never literal colors, so
// there is nothing to filter on even if it did match — only the model's own
// color judgment can map "maroon" to the shade list. The store's product list
// already carries choice_options (shade names) on every item; this tool just
// has to stop throwing that away and stop sending the color word to the store.
const COLOR_RE = /\\b(red|pink|hot\\s*pink|maroon|wine|burgundy|oxblood|nude|beige|brown|chocolate|black|white|blue|navy|green|yellow|orange|purple|violet|lilac|gold(en)?|silver|coral|peach|mauve|berry|rose|plum|rust|bronze|copper|gr[ae]y|lavender|mint|teal|turquoise|cream|ivory|tan|olive|magenta|fuchsia|crimson|scarlet|charcoal)\\b/i;
const wantsColor = COLOR_RE.test(workingKw);
const storeKw = wantsColor ? (workingKw.replace(COLOR_RE, ' ').replace(/\\s{2,}/g, ' ').trim() || workingKw) : workingKw;

// Returns { ok, status, body } — the STATUS matters. The old version resolved
// null on any trouble and threw the status away, so a 500 from the store (its
// Meilisearch down) was indistinguishable from "no products matched": the agent
// told the customer "not in our catalogue" about a product sitting on the
// homepage. A failed search must never be reported as an empty one.
function httpText(url) {
  return new Promise((resolve) => {
    let u = null;
    try { u = new (require('url').URL)(url); } catch (e) { return resolve({ ok: false, status: 0, body: null }); }
    const mod = require(u.protocol === 'https:' ? 'https' : 'http');
    const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 2000000) { req.destroy(); resolve({ ok: false, status: res.statusCode, body: null }); } });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: data }));
      res.on('error', () => resolve({ ok: false, status: res.statusCode, body: null }));
    });
    req.on('error', () => resolve({ ok: false, status: 0, body: null }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, status: 0, body: null }); });
    req.end();
  });
}
function firstJson(s) {
  if (s == null) return null;
  const i = s.indexOf('{'); const k = s.indexOf('[');
  const start = i < 0 ? k : (k < 0 ? i : Math.min(i, k));
  if (start < 0) return null;
  try { return JSON.parse(s.slice(start)); } catch (e) { return null; }
}
function num(v) { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; }
function taka(n) { return '\u09f3' + Math.round(Number(n) || 0).toLocaleString('en-US'); }

const ratingScoped = wantsRating && !!storeKw;
const fetchLimit = wantsRating ? (ratingScoped ? 50 : 300) : (wantsCheapest ? 30 : 6);
const kwParam = (wantsRating && !ratingScoped) ? '' : ('keyword=' + encodeURIComponent(storeKw) + '&');
const res = await httpText(base + '/api/v4/products?' + kwParam + 'limit=' + fetchLimit);
const parsed = firstJson(res.ok ? res.body : null);
let arr = parsed && Array.isArray(parsed.data) ? parsed.data : [];
if (wantsCheapest && arr.length) {
  const priceOf = (p) => num(p.nonformated_price) || num(p.main_price) || num(p.web_price);
  arr = arr.slice().sort((a, b) => priceOf(a) - priceOf(b)).slice(0, 6);
}
let noRatingData = false;
if (wantsRating) {
  const rated = arr.filter((p) => num(p.rating) > 0);
  if (rated.length) {
    arr = rated.sort((a, b) => num(b.rating) - num(a.rating) || num(b.total_reviews) - num(a.total_reviews) || num(b.num_of_sale) - num(a.num_of_sale)).slice(0, 6);
  } else {
    // Even the wide pool had nothing rated — be honest about it instead of
    // silently handing back unrelated rating:0 products as "highest rated".
    noRatingData = true;
    arr = [];
  }
}

// A search that never ran is NOT a search that found nothing. Say so in a form
// the specialist cannot mistake for an empty catalogue, and forbid the wording
// that made the bug visible ("couldn't find it in our catalogue").
if (!parsed) {
  return [{ json: { text: 'SEARCH UNAVAILABLE - the store search did not run' + (res.status ? ' (HTTP ' + res.status + ')' : ' (no response)') +
    '. Do NOT say the product does not exist, is out of stock, or is not in the catalogue - you have no result either way. Tell the customer the catalogue search is temporarily unavailable and to try again in a moment.\\nMETA_PRODUCT_IDS: none' } }];
}

if (!arr.length) {
  if (noRatingData) {
    return [{ json: { text: 'NO RATING DATA - scanned a wide sample of the catalogue and found no product with a real customer rating yet. Do NOT invent or imply a "highest rated" product. Tell the customer the store does not have enough reviews yet to rank by rating, and offer to recommend by popularity/best-sellers instead.\\nMETA_PRODUCT_IDS: none' } }];
  }
  return [{ json: { text: 'No products matched "' + kw + '". Try a broader or different keyword.' } }];
}

const lines = arr.map((p) => {
  const price = num(p.nonformated_price) || num(p.main_price) || num(p.web_price);
  const was = num(p.stroked_price);
  const stock = p.in_stock ? ('IN STOCK (' + (Number(p.current_stock) || 0) + ' left)') : 'OUT OF STOCK';
  const size = p.custom_size ? ' ' + String(p.custom_size) : '';
  const disc = (was > price && price > 0) ? ' (was ' + taka(was) + ')' : '';
  const hasOpts = (p.variant_product === true || Number(p.variant_product) > 0);
  const shadeNames = wantsColor && Array.isArray(p.choice_options) && Array.isArray(p.choice_options[0] && p.choice_options[0].options)
    ? p.choice_options[0].options.slice(0, 12)
    : null;
  const opts = shadeNames && shadeNames.length
    ? ' | SHADES: ' + shadeNames.join(', ')
    : (hasOpts ? ' | SIZE OPTIONS (choose one)' : ' | no size options');
  // Rating is advertised in this tool's own description but was never actually
  // in the line (verified 2026-10-14) — most products have none, so only show
  // it when the store actually has a real rating for this product.
  const rating = num(p.rating);
  const reviews = num(p.total_reviews);
  const ratingTxt = rating > 0 ? (' | ' + rating.toFixed(1) + '★ (' + reviews + ' review' + (reviews === 1 ? '' : 's') + ')') : '';
  return '- id=' + p.id + ' | ' + String(p.name ?? '').trim() + size + ' | ' + taka(price) + disc + ' | ' + stock + opts + ratingTxt;
});

const text = 'Search "' + kw + '" - ' + arr.length + ' result(s), prices in BDT (\u09f3):\\n' + lines.join('\\n') +
  '\\nPass an id= to cart-add or product_detail. Only recommend or add items marked IN STOCK. A size printed in the product name (e.g. "(50ml)") is part of the name — it is NOT an option. Only a line marked "SIZE OPTIONS" needs a chosen option name (call product_detail for the exact names).' +
  (wantsColor ? '\\nA line marked "SHADES" lists that product' + "'" + 's real shade names (not literal colors) - use your own color judgment to pick the one(s) that plausibly match what the customer asked for, and pass the EXACT shade text as the variant when it is added to cart.' : '');
return [{ json: { text } }];
`;

function searchToolWorkflow() {
  const nodes = [];
  const connections = {};
  nodes.push(
    node({
      parameters: { events: 'worklfow_call', inputSource: 'passthrough' },
      name: 'Sub Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1.2,
      position: pos(0, 0),
    }),
  );
  nodes.push(
    node({
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: SEARCH_CODE },
      name: 'Search',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: pos(240, 0),
    }),
  );
  connections['Sub Trigger'] = { main: [[{ node: 'Search', type: 'main', index: 0 }]] };
  return { name: 'tool-search-products', nodes, connections, settings: { executionOrder: 'v1' } };
}

// ---------------------------------------------------------------------------
// Slim product-detail tool (its own sub-workflow).
// /api/v3/products/{id} returns ~14.5k chars for ONE product — photos, tags,
// meta, rating breakouts and a 7k-char HTML description. Measured on exec 1731:
// that single observation was 14,553 chars (~3,638 tokens), 93% of ALL tool
// output in the turn, and the specialist re-sends it on every later LLM call.
// This returns only what the agent actually uses: identity, price and stock,
// the exact size-option names with their prices and stock, and the description
// as plain text (the HTML strips down to ~450 chars — no real loss).
// ---------------------------------------------------------------------------
const DETAIL_CODE = `
const j = $input.first().json ?? {};
const pidRaw = String(j.query ?? j.input ?? j.product_id ?? j.id ?? '');
const pid = (pidRaw.match(/[0-9]+/) || [''])[0];
const base = ($env.STORE_BASE_URL || 'http://fastmart-pro.test').replace(/\\/+$/, '');

if (!pid) {
  return [{ json: { text: 'No product id was passed. Pass the numeric id from a search_products result, e.g. 1.' } }];
}

// Returns { ok, status, body } — the status matters: a failed lookup must never
// read as "this product does not exist" (the same trap the search tool had).
function httpText(url) {
  return new Promise((resolve) => {
    let u = null;
    try { u = new (require('url').URL)(url); } catch (e) { return resolve({ ok: false, status: 0, body: null }); }
    const mod = require(u.protocol === 'https:' ? 'https' : 'http');
    const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 2000000) { req.destroy(); resolve({ ok: false, status: res.statusCode, body: null }); } });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: data }));
      res.on('error', () => resolve({ ok: false, status: res.statusCode, body: null }));
    });
    req.on('error', () => resolve({ ok: false, status: 0, body: null }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, status: 0, body: null }); });
    req.end();
  });
}
function firstJson(s) {
  if (s == null) return null;
  const i = s.indexOf('{'); const k = s.indexOf('[');
  const start = i < 0 ? k : (k < 0 ? i : Math.min(i, k));
  if (start < 0) return null;
  try { return JSON.parse(s.slice(start)); } catch (e) { return null; }
}
function num(v) { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; }
function taka(n) { return '\u09f3' + Math.round(Number(n) || 0).toLocaleString('en-US'); }
function strip(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \\t\\r\\n]+/g, ' ')
    .trim();
}

const res = await httpText(base + '/api/v3/products/' + encodeURIComponent(pid));
const parsed = firstJson(res.ok ? res.body : null);
if (!parsed) {
  return [{ json: { text: 'DETAIL UNAVAILABLE - the store did not return this product' + (res.status ? ' (HTTP ' + res.status + ')' : ' (no response)') +
    '. Do NOT say the product does not exist or is out of stock - you have no result either way. Recommend from the search result you already have, or say the catalogue is temporarily unavailable.' } }];
}
const p = Array.isArray(parsed.data) ? parsed.data[0] : parsed.data;
if (!p) return [{ json: { text: 'No product found with id=' + pid + '.' } }];

const brand = p.brand && typeof p.brand === 'object' ? (p.brand.name ?? '') : (p.brand ?? '');
const cat = p.category && typeof p.category === 'object' ? (p.category.name ?? '') : (p.category ?? '');
const out = ['Product id=' + p.id + ' | ' + String(p.name ?? '').trim() + (brand ? ' | brand ' + brand : '') + (cat ? ' | category ' + cat : '')];

const variants = Array.isArray(p.variant) ? p.variant : [];
if (variants.length) {
  const opts = variants.map((v) => ({ name: String(v.variant ?? 'option'), price: num(v.discount_price) || num(v.price), qty: num(v.qty) }));
  const inStock = opts.filter((o) => o.qty > 0);
  const from = Math.min.apply(null, (inStock.length ? inStock : opts).map((o) => o.price));
  out.push('Price: from ' + taka(from) + ' (price and stock are per size option)');
  out.push('SIZE OPTIONS - pass exactly ONE of these as the variant argument:');
  for (const o of opts) out.push('- ' + o.name + ' | ' + taka(o.price) + ' | ' + (o.qty > 0 ? o.qty + ' in stock' : 'OUT OF STOCK'));
} else {
  out.push('Price: ' + taka(num(p.calculable_price) || num(p.main_price)) + ' | ' + (p.in_stock ? 'IN STOCK (' + num(p.current_stock) + ' left)' : 'OUT OF STOCK'));
  out.push('Size options: NONE - do NOT pass a variant for this product.');
}
out.push('Rating: ' + (num(p.rating) || 'none') + ' | sold: ' + num(p.num_of_sale));
const desc = strip(p.description);
const short = strip(p.short_description);
if (desc) out.push('Description: ' + desc);
if (short && short !== desc) out.push('Short description: ' + short);

return [{ json: { text: out.join('\\n') } }];
`;

function productDetailToolWorkflow() {
  const nodes = [];
  const connections = {};
  nodes.push(
    node({
      parameters: { events: 'worklfow_call', inputSource: 'passthrough' },
      name: 'Sub Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1.2,
      position: pos(0, 0),
    }),
  );
  nodes.push(
    node({
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: DETAIL_CODE },
      name: 'Detail',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: pos(240, 0),
    }),
  );
  connections['Sub Trigger'] = { main: [[{ node: 'Detail', type: 'main', index: 0 }]] };
  return { name: 'tool-product-detail', nodes, connections, settings: { executionOrder: 'v1' } };
}

// ---------------------------------------------------------------------------
// Slim current-offers tool (its own sub-workflow), wired directly onto the
// MAIN orchestrator (see build-main.mjs) rather than through product_discovery:
// "show me current offers" needs no multi-step product reasoning, just a
// straight read, so it skips a whole sub-agent round-trip the same way
// cart-add does. Composes three store endpoints the catalog already exposes
// (confirmed against fastmart-pro source, no store-side change needed):
//   - GET /api/v3/flash-deals            — active time-boxed campaigns
//   - GET /api/v4/combo-offers           — bundled multi-product deals
//   - GET /api/v3/products/discounted    — individual products on discount
// All three are unauthenticated storefront endpoints, same convention as
// SEARCH_CODE/DETAIL_CODE above.
// ---------------------------------------------------------------------------
const OFFERS_CODE = `
const base = ($env.STORE_BASE_URL || 'http://fastmart-pro.test').replace(/\\/+$/, '');

// Same ok/status-aware fetch as search/detail - a failed call must never read
// as "no offers right now" (see AGENTS.md §2/§5 on silent n8n failures).
function httpText(url) {
  return new Promise((resolve) => {
    let u = null;
    try { u = new (require('url').URL)(url); } catch (e) { return resolve({ ok: false, status: 0, body: null }); }
    const mod = require(u.protocol === 'https:' ? 'https' : 'http');
    const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 2000000) { req.destroy(); resolve({ ok: false, status: res.statusCode, body: null }); } });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: data }));
      res.on('error', () => resolve({ ok: false, status: res.statusCode, body: null }));
    });
    req.on('error', () => resolve({ ok: false, status: 0, body: null }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ ok: false, status: 0, body: null }); });
    req.end();
  });
}
function firstJson(s) {
  if (s == null) return null;
  const i = s.indexOf('{'); const k = s.indexOf('[');
  const start = i < 0 ? k : (k < 0 ? i : Math.min(i, k));
  if (start < 0) return null;
  try { return JSON.parse(s.slice(start)); } catch (e) { return null; }
}
function num(v) { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; }
function taka(n) { return '৳' + Math.round(Number(n) || 0).toLocaleString('en-US'); }
// flash-deals' "date" and combo-offers' "end_date" are both unix SECONDS
// (confirmed against the store's FlashDealCollection resource and GiftOffer::scopeValid,
// both compared against PHP time()) - multiply by 1000 for a JS Date.
function daysLeft(unixSeconds) {
  const ms = Number(unixSeconds) * 1000 - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.ceil(ms / 86400000);
}

const [flashRes, comboRes, discRes] = await Promise.all([
  httpText(base + '/api/v3/flash-deals'),
  httpText(base + '/api/v4/combo-offers?per_page=5'),
  httpText(base + '/api/v3/products/discounted?limit=12'),
]);
const flashParsed = firstJson(flashRes.ok ? flashRes.body : null);
const comboParsed = firstJson(comboRes.ok ? comboRes.body : null);
const discParsed = firstJson(discRes.ok ? discRes.body : null);

// All three calls failing is a real outage, not "there happen to be no offers" -
// the same trap the search tool guards against.
if (!flashParsed && !comboParsed && !discParsed) {
  return [{ json: { text: 'OFFERS UNAVAILABLE - the store did not return any promotion data just now. Do NOT say there are no current offers - you have no result either way. Tell the customer offers info is temporarily unavailable and to check back shortly.\\nMETA_PRODUCT_IDS: none' } }];
}

const flashDeals = flashParsed && Array.isArray(flashParsed.data) ? flashParsed.data : [];
const combos = comboParsed && Array.isArray(comboParsed.data) ? comboParsed.data : [];
const discRaw = discParsed && Array.isArray(discParsed.data) ? discParsed.data : [];

const lines = [];
for (const d of flashDeals.slice(0, 3)) {
  const left = daysLeft(d && d.date);
  const title = String((d && (d.title || d.subtitle)) || 'Flash Sale').trim();
  lines.push('FLASH SALE: ' + title + (left ? ' - ends in ' + left + ' day' + (left === 1 ? '' : 's') : ''));
}
for (const c of combos.slice(0, 3)) {
  const left = daysLeft(c && c.end_date);
  const name = String((c && (c.combo_name || c.offer_title)) || 'Combo Offer').trim();
  const cnt = Number(c && c.products_count) || 0;
  lines.push('COMBO OFFER: ' + name + ' - ' + taka(c && c.combo_price) + (cnt ? ' for ' + cnt + ' items' : '') + (left ? ', ends in ' + left + ' day' + (left === 1 ? '' : 's') : ''));
}

// Biggest real savings first - that is what "current offers" means to a customer,
// not whatever random order the store API happened to return.
const discounted = discRaw.map((p) => {
  const price = num(p.nonformated_price) || num(p.main_price) || num(p.web_price);
  const was = num(p.stroked_price);
  const pct = (was > price && was > 0) ? Math.round((1 - price / was) * 100) : 0;
  return { p, price, was, pct };
}).filter((x) => x.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 6);

const ids = [];
for (const { p, price, was, pct } of discounted) {
  const stock = p.in_stock ? ('IN STOCK (' + (Number(p.current_stock) || 0) + ' left)') : 'OUT OF STOCK';
  const size = p.custom_size ? ' ' + String(p.custom_size) : '';
  lines.push('- id=' + p.id + ' | ' + String(p.name ?? '').trim() + size + ' | ' + taka(price) + ' (was ' + taka(was) + ', -' + pct + '%) | ' + stock);
  if (p.in_stock) ids.push(p.id);
}

if (!lines.length) {
  return [{ json: { text: 'No active flash sales, combo offers or discounted products right now - check back soon!\\nMETA_PRODUCT_IDS: none' } }];
}

const text = "Here's what's on offer right now:\\n" + lines.join('\\n') +
  (ids.length ? '\\nMETA_PRODUCT_IDS: ' + ids.slice(0, 6).join(',') + '\\n[BLOCK product-grid]' : '\\nMETA_PRODUCT_IDS: none');
return [{ json: { text } }];
`;

function offersToolWorkflow() {
  const nodes = [];
  const connections = {};
  nodes.push(
    node({
      parameters: { events: 'worklfow_call', inputSource: 'passthrough' },
      name: 'Sub Trigger',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1.2,
      position: pos(0, 0),
    }),
  );
  nodes.push(
    node({
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: OFFERS_CODE },
      name: 'Offers',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: pos(240, 0),
    }),
  );
  connections['Sub Trigger'] = { main: [[{ node: 'Offers', type: 'main', index: 0 }]] };
  return { name: 'tool-current-offers', nodes, connections, settings: { executionOrder: 'v1' } };
}

// ---------------------------------------------------------------------------
// Specialists
// ---------------------------------------------------------------------------

const productDiscovery = specialistWorkflow('specialist-product-discovery', P.PRODUCT_DISCOVERY, {
  retry: true,
  // returnIntermediateSteps is what lets Format Out salvage a real answer from
  // the searches when the agent burns its iterations (see formatJs below).
  // Read-only specialist, so there is no cart-safety reason to withhold steps.
  returnSteps: true,
  tools: [
    {
      name: 'search_products',
      type: '@n8n/n8n-nodes-langchain.toolWorkflow',
      typeVersion: 2.1,
      params: {
        name: 'search_products',
        description: P.TOOL.searchProducts,
        source: 'database',
        workflowId: { value: SEARCH_TOOL_ID },
        workflowInputs: { mappingMode: 'defineBelow', value: null },
      },
      // NOTE: the search returns a compact list (see searchToolWorkflow). The
      // store's own search cannot filter by price (Meilisearch has no filterable
      // attributes — ?max_price= 500s), so budget is enforced by the prompt from
      // the returned prices.
    },
    {
      // Underscored, because a toolWorkflow name allows letters, numbers and
      // underscores only. Backed by the slim tool (DETAIL_CODE) rather than the
      // raw store payload — see its comment for the measurement.
      name: 'product_detail',
      type: '@n8n/n8n-nodes-langchain.toolWorkflow',
      typeVersion: 2.1,
      params: {
        name: 'product_detail',
        description: P.TOOL.productDetail,
        source: 'database',
        workflowId: { value: DETAIL_TOOL_ID },
        workflowInputs: { mappingMode: 'defineBelow', value: null },
      },
    },
  ],
  formatJs: `const inp = $input.first().json;
const out = inp.output;
const raw = typeof out === 'string' ? out : (out?.output ?? JSON.stringify(out));
let text = String(raw ?? '').replace(/<[^>]+>/g, '');

function idsFrom(s) {
  const m = String(s).match(/META_PRODUCT_IDS:\\s*([\\d,\\s]+|none)/i);
  if (!m || !m[1] || /^none$/i.test(m[1].trim())) return [];
  return [...new Set(m[1].split(',').map((x) => parseInt(x, 10)).filter(Number.isFinite))];
}
let product_ids = idsFrom(text);

// When the agent runs out of iterations it returns the bare string
// "Agent stopped due to max iterations." — no answer at all, though the searches
// it did run are sitting in intermediateSteps. That string must never reach the
// customer (the orchestrator used to paraphrase it as "the search didn't
// complete"), and the turn must still be useful, so rebuild the reply from the
// results already collected. This is deterministic — no model call, so it cannot
// loop or fail the way the agent did.
// Only replace the model's text when it produced NO answer at all. A reply that
// simply omitted the META footer (e.g. "this comes in 15ml or 45ml — which one?")
// is a real answer and must be left alone: overwriting it with a product list
// would silently discard a clarifying question.
const exhausted = /max iterations/i.test(text);
if (exhausted) {
  let budget = null;
  try {
    const task = String($('Sub Trigger').first().json.query ?? '');
    const bm = task.match(/under\\s*(?:৳|BDT\\s*)?([\\d,]+)/i);
    if (bm) { const n = parseInt(String(bm[1]).replace(/,/g, ''), 10); if (n > 0) budget = n; }
  } catch (e) {}

  const found = [];
  const seen = {};
  for (const st of (inp.intermediateSteps || [])) {
    if (String((st && st.action && st.action.tool) || '') !== 'search_products') continue;
    let obs = st && st.observation;
    if (Array.isArray(obs)) obs = obs.map((x) => (x && x.text) || '').join('\\n');
    else if (obs && typeof obs === 'object') obs = obs.text || '';
    for (const line of String(obs || '').split('\\n')) {
      const m = line.match(/^- id=(\\d+) \\| (.+?) \\| ৳([\\d,]+)[^|]*\\| ([^|]+)\\|/);
      if (!m) continue;
      const id = parseInt(m[1], 10);
      if (!id || seen[id]) continue;
      seen[id] = true;
      if (!/in stock/i.test(m[4])) continue;
      found.push({ id, name: m[2].trim(), price: parseInt(m[3].replace(/,/g, ''), 10) });
    }
  }
  found.sort((a, b) => a.price - b.price);
  const within = budget ? found.filter((p) => p.price <= budget) : found;
  const picks = (within.length ? within : found).slice(0, 4);
  if (picks.length) {
    const head = within.length
      ? 'Here are the best in-stock options I found for you:'
      : 'Nothing in stock came in under ৳' + budget + ', but these are in stock:';
    text = head + '\\n' + picks.map((p) => p.name + ' — ৳' + p.price.toLocaleString('en-US')).join('\\n')
      + '\\nMETA_PRODUCT_IDS: ' + picks.map((p) => p.id).join(',')
      + '\\n[BLOCK product-grid]';
    product_ids = picks.map((p) => p.id);
  } else {
    // Nothing salvageable and no answer from the model — say so honestly.
    text = "I couldn't find anything in stock for that just now. Try a different product name or category and I'll take another look."
      + '\\nMETA_PRODUCT_IDS: none';
    product_ids = [];
  }
}

// KEEP the META_PRODUCT_IDS footer in text: the orchestrator parses product ids from it.
// The main workflow Response node strips it before replying to the customer.
text = text.replace(/\\\\n{2,}/g, '\\\\n').trim();
return [{ json: { text, product_ids } }];`,
});

const supportSpecialist = specialistWorkflow('specialist-support', P.SUPPORT_SPECIALIST, { retry: true });

const cartSpecialist = specialistWorkflow('specialist-cart', P.CART_SPECIALIST, {
  prepareJs: `const q = String($input.first().json.query ?? '');
const um = q.match(/\\[guest cart user: (tmp[^\\]\\s]*)\\]/);
return [{ json: { chatInput: q, guestUserId: um ? um[1] : '' } }];`,
  tools: [
    {
      name: 'read-cart',
      params: httpTool({
        name: 'read-cart',
        description: P.TOOL.getCart,
        method: 'POST',
        url: `=${P.STORE}/api/v3/carts/{{ $fromAI('user_id', 'the guest cart user_id (from [guest cart user: tmp-...])', 'string') }}`,
      }),
    },
    {
      name: 'cart-summary',
      params: httpTool({
        name: 'cart-summary',
        description: P.TOOL.cartSummary,
        method: 'GET',
        url: `=${P.STORE}/api/v3/cart-summary/{{ $fromAI('user_id', 'the guest cart user_id (from [guest cart user: tmp-...])', 'string') }}`,
      }),
    },
    {
      name: 'remove-line',
      params: httpTool({
        name: 'remove-line',
        description: 'Remove one full cart line by its line id (line ids come from read-cart). Executes immediately.',
        method: 'DELETE',
        url: `=${P.STORE}/api/v3/carts/{{ $fromAI('line_id', 'the cart line id to remove', 'number') }}`,
      }),
    },
  ],
  formatJs: `const out = $input.first().json.output;
const raw = typeof out === 'string' ? out : (out?.output ?? JSON.stringify(out));
let text = String(raw ?? '').replace(/<[^>]+>/g, '').replace(/\\n{2,}/g, '\\n').trim();
// Same max-iterations leak class as the other specialists. A cart specialist that
// ran out of turns may or may not have mutated the cart, so it must not guess
// state either way — just say the action did not complete.
if (/max iterations/i.test(text)) text = 'I could not finish that cart action just now — could you try once more?';
return [{ json: { text } }];`,
});

// ---------------------------------------------------------------------------
// Order specialist — turns the raw track-order result into a PII-FREE
// `order-status` payload the app renders as a progress card.
//   - reads the track-order observation (needs returnIntermediateSteps)
//   - allowlists only display-safe fields (never name/address/phone/email/user_id)
//   - redacts any identity value the model may have echoed in its prose
//   - emits `META_ORDER_JSON: {...}` + `[BLOCK order-status]` for the main
//     workflow's Response node, which strips both before replying.
// ---------------------------------------------------------------------------
const ORDER_STATUS_FORMAT_JS = `const out = $input.first().json.output;
const rawOut = typeof out === 'string' ? out : (out && typeof out === 'object' && 'output' in out ? out.output : JSON.stringify(out));
let text = String(rawOut == null ? '' : rawOut).replace(/<[^>]+>/g, '').replace(/\\n{2,}/g, '\\n').trim();

function firstJson(s) {
  if (s == null) return null;
  const i = s.indexOf('{');
  const j = s.indexOf('[');
  const start = Math.min(i < 0 ? Infinity : i, j < 0 ? Infinity : j);
  if (start === Infinity) return null;
  try { return JSON.parse(String(s).slice(start)); } catch (e) { return null; }
}
function unwrap(v) {
  let cur = v;
  for (let d = 0; d < 6; d++) {
    if (typeof cur === 'string') { const p = firstJson(cur); if (p === null) return cur; cur = p; continue; }
    if (Array.isArray(cur)) { if (cur.length === 1) { cur = cur[0]; continue; } return cur; }
    if (cur && typeof cur === 'object' && cur.data !== undefined) { cur = cur.data; continue; }
    if (cur && typeof cur === 'object' && cur.json !== undefined && typeof cur.json === 'object') { cur = cur.json; continue; }
    return cur;
  }
  return cur;
}
function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

let order = null;
try {
  const steps = $input.first().json.intermediateSteps || [];
  for (const st of steps) {
    const tool = String((st && st.action && st.action.tool) || '');
    if (tool !== 'track-order') continue;
    const parsed = unwrap(st.observation);
    if (parsed && typeof parsed === 'object' && parsed.code) { order = parsed; break; }
  }
} catch (e) {}

let meta = null;
if (order) {
  const addr = (order.shipping_address && typeof order.shipping_address === 'object') ? order.shipping_address : {};
  const itemsRaw = order.items && Array.isArray(order.items.data) ? order.items.data : (Array.isArray(order.items) ? order.items : []);
  meta = {
    code: String(order.code || ''),
    placedAt: String(order.date || ''),
    status: String(order.delivery_status || ''),
    statusLabel: String(order.delivery_status_string || ''),
    paymentStatus: String(order.payment_status || ''),
    paymentStatusLabel: String(order.payment_status_string || ''),
    paymentMethod: String(order.payment_type || ''),
    shippingType: String(order.shipping_type_string || ''),
    shippingMethod: String(order.shipping_method || ''),
    // Region-aware ETA, but never name the place — the card must not reveal locale.
    eta: /dhaka/i.test(String(addr.city || '')) ? '1-2 business days' : '2-4 business days',
    itemCount: itemsRaw.reduce((s, it) => s + (Number(it.quantity) || 0), 0),
    subtotal: num(order.subtotal),
    shippingCost: num(order.shipping_cost),
    discount: num(order.coupon_discount),
    tax: num(order.tax),
    total: num(order.grand_total),
    items: itemsRaw.slice(0, 10).map((it) => ({
      name: String(it.product_name || ''),
      variant: String(it.variation || '') || null,
      quantity: Number(it.quantity) || 0,
      price: num(it.price),
      image: it.thumbnail_image || null,
    })),
  };
  // Belt and braces: strip identity values from the prose even if the model echoed them.
  // Case-insensitive, and covers the city/state/country plus their individual words: the
  // model wrote "within Dhaka" while the stored address was "jatrbari dhaka" (lowercase),
  // so a case-sensitive exact match missed it and the delivery city leaked to the customer.
  const redact = (s, term) => {
    const t = String(term);
    if (t.length < 2) return s;
    const lt = t.toLowerCase();
    let out = ''; let rest = s;
    for (;;) {
      const i = rest.toLowerCase().indexOf(lt);
      if (i < 0) return out + rest;
      out += rest.slice(0, i) + '[hidden]';
      rest = rest.slice(i + t.length);
    }
  };
  const terms = new Set();
  for (const v of [addr.name, addr.phone, addr.additional_phone, addr.email, addr.address, addr.area, addr.city, addr.state, addr.country, addr.postal_code]) {
    const s = String(v == null ? '' : v).trim();
    if (s.length > 1) terms.add(s);
  }
  for (const v of [addr.area, addr.city, addr.state, addr.address]) {
    for (const w of String(v == null ? '' : v).split(/[\\s,]+/)) if (w.length > 2) terms.add(w);
  }
  for (const t of terms) text = redact(text, t);
}

text = text.replace(/META_ORDER_JSON:[^\\n]*/gi, '').replace(/\\[BLOCK[^\\]]*\\]/gi, '').replace(/\\n{2,}/g, '\\n').trim();
// Same max-iterations leak class as the other specialists: if the agent never got
// a usable answer out, say so plainly instead of passing the raw technical string on.
if (!meta && /max iterations/i.test(text)) text = 'I could not finish looking that order up just now — could you try again in a moment?';
if (meta) text += '\\nMETA_ORDER_JSON: ' + JSON.stringify(meta) + '\\n[BLOCK order-status]';
return [{ json: { text, has_order: !!meta } }];`;

const orderSpecialist = specialistWorkflow('specialist-orders', P.ORDER_MANAGEMENT, {
  returnSteps: true,
  retry: true,
  formatJs: ORDER_STATUS_FORMAT_JS,
  tools: [
    {
      name: 'track-order',
      params: httpTool({
        name: 'track-order',
        description: 'Look up an order by its exact code (e.g. TEST2026080810292989) to get its status, items, price and delivery estimate. Always pass the code exactly as the customer gave it. Call with no code to see nothing - always ask the customer for a code first.',
        method: 'GET',
        url: `=${P.STORE}/api/v3/track-order?code={{ encodeURIComponent($fromAI('order_code', 'the order code exactly as the customer wrote it', 'string')) }}`,
      }),
    },
  ],
});

const specMap = {
  productDiscovery,
  supportSpecialist,
  cartSpecialist,
  orderSpecialist,
};
for (const [k, v] of Object.entries(specMap)) {
  fs.writeFileSync(`${OUT}/${k}.json`, JSON.stringify(v, null, 2));
}
fs.writeFileSync(`${OUT}/searchTool.json`, JSON.stringify(searchToolWorkflow(), null, 2));
fs.writeFileSync(`${OUT}/productDetailTool.json`, JSON.stringify(productDetailToolWorkflow(), null, 2));
fs.writeFileSync(`${OUT}/offersTool.json`, JSON.stringify(offersToolWorkflow(), null, 2));

console.log('built specialists:', Object.keys(specMap).join(', '), '+ searchTool + productDetailTool + offersTool');
console.log('search tool workflow id:', SEARCH_TOOL_ID);
console.log('product-detail tool workflow id:', DETAIL_TOOL_ID);
console.log('model:', MODEL_NODE.provider, '->', MODEL_NODE.model);
console.log('out dir:', OUT);
