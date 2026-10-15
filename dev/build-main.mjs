// Builds the Part 2 MAIN agent-chat workflow (context + memory + orchestrator
// + specialist tools + direct store tools + response). Specialists' workflow
// ids are injected from the deploy step (passed via env or edited below).
import fs from 'node:fs';
import * as P from './prompts.js';
import { MODEL_NODE, modelNodeFields } from './model-config.mjs';
import { stableId } from './node-id.mjs';

const OUT = 'dev/out';
// Credential names are instance-specific. Read from .n8n-credentials.json
// (created once by the user), falling back to the names bootstrap-creds uses.
let credConfig = {};
try { credConfig = JSON.parse(fs.readFileSync('dev/../.n8n-credentials.json', 'utf8')); } catch {}
const PG_CRED_NAME = process.env.PG_CRED_NAME || credConfig.PG_CRED_NAME || 'fastmart Postgres (fastmart_ai DB)';
const PG_CRED_ID = process.env.PG_CRED_ID || credConfig.PG_CRED_ID || 'EsaKbJSqeQFEMuwd';
const PG_CRED = { id: PG_CRED_ID, name: PG_CRED_NAME };
// Gates the public webhook with JWT Auth (static shared secret — see
// N8N_WEBHOOK_JWT_SECRET in .env.example and dev/create-webhook-jwt-cred.mjs).
// Same fallback-literal convention as SPEC above: only correct for THIS
// instance when run standalone, but sync.mjs's own verify() step already
// checks every built workflow's credential references resolve by NAME on the
// target instance and fails loudly if not — so a stale/wrong literal here can
// never silently deploy with the wrong (or no) credential attached.
const WEBHOOK_JWT_CRED_NAME = process.env.WEBHOOK_JWT_CRED_NAME || credConfig.WEBHOOK_JWT_CRED_NAME || 'fastmart Webhook JWT';
const WEBHOOK_JWT_CRED_ID = process.env.WEBHOOK_JWT_CRED_ID || credConfig.WEBHOOK_JWT_CRED_ID || 'NlmmYmXG8iwr20Rp';
const WEBHOOK_JWT_CRED = { id: WEBHOOK_JWT_CRED_ID, name: WEBHOOK_JWT_CRED_NAME };

// Ids produced by dev/deploy.mjs — resolved LIVE by dev/sync.mjs, which deploys
// each workflow first and reads its real id back from the instance. The literals
// below are only a last-resort fallback for a hand-run build; they belong to the
// instance they were copied from and will be wrong anywhere else.
const SPEC = {
  productDiscovery: process.env.PRODUCT_DISCOVERY_ID || 'DQ39wgxL370oX15x',
  supportSpecialist: process.env.SUPPORT_SPECIALIST_ID || '84zzrn7RoIof8lhC',
  cartSpecialist: process.env.CART_SPECIALIST_ID || '1epRnYl6wTXaIxMf',
  orderSpecialist: process.env.ORDER_SPECIALIST_ID || 'TMlk5KZqAZB5ysy7',
};
const N8N = { spec: SPEC };

// tool-current-offers (dev/build-workflows.mjs) is a direct tool on the
// orchestrator, not a specialist, so it has no pre-existing instance id on a
// fresh install — same placeholder convention as SEARCH_TOOL_ID/DETAIL_TOOL_ID
// in build-workflows.mjs. dev/sync.mjs deploys it first and fills this in.
const OFFERS_TOOL_ID = process.env.OFFERS_TOOL_ID || 'REPLACE_WITH_OFFERS_TOOL_ID';

// Node ids are DERIVED FROM THE NODE NAME, not random — see dev/node-id.mjs.
// A random id on every build breaks canvas groups and any other n8n-side
// reference to the old id when the workflow is PATCHed.
const node = (o) => ({ id: o.id || stableId(o.name), disabled: false, ...o });
const pos = (x, y) => [x, y];

const WEBHOOK_ID = '9c2a1d7e-4b4f-4d9e-9c0a-1f2a3b4c5d6e';

// ---------------------------------------------------------------------------
// Prepare Input + context builder (Code)
// ---------------------------------------------------------------------------
const PREPARE_CODE = `
const body = $input.first().json.body ?? {};
let msgRaw = (body.message ?? body.chatInput ?? '').toString().trim();
const userId = (body.user_id ?? body.userId ?? '').toString().trim();
const profile = (body.profile && typeof body.profile === 'object') ? body.profile : null;
const evalMode = body.eval === true || body.eval === 'true';
if (!msgRaw) {
  msgRaw = 'Hi';
}
if (!userId) {
  return [{ json: { error: 'user_id is required', status: 400 }, pairedItem: { item: 0 } }];
}

const base = ($env.STORE_BASE_URL || 'https://stg-admin.perfectobd.com').replace(/\\/+$/, '');

function textOf(r) {
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') {
    if ('body' in r) return typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return JSON.stringify(r);
  }
  return String(r ?? '');
}
function firstJson(s) {
  if (s == null) return null;
  const i = s.indexOf('{');
  const j = s.indexOf('[');
  const start = (i < 0 ? j : (j < 0 ? i : Math.min(i, j)));
  if (start < 0) return null;
  try { return JSON.parse(s.slice(start)); } catch { return null; }
}
function httpText(url, { method, body } = {}) {
  return new Promise((resolve) => {
    let u = null;
    try { u = new (require('url').URL)(url); } catch (e) { return resolve(null); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve(null);
    const httpMod = require(u.protocol === 'https:' ? 'https' : 'http');
    const headers = body != null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(String(body)) } : {};
    const req = httpMod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: method || 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 5000000) { req.destroy(); resolve(null); } });
      res.on('end', () => resolve(data));
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    if (body != null) req.write(String(body));
    req.end();
  });
}
// One retry on a transient failure (network blip, store cold-start) before
// giving up - live-verified 2026-10-14: a customer's "proceed to checkout"
// got a confidently-worded reply ("your cart is ready... total ৳2,210") with
// an EMPTY blocks array, because this single unretried cart-read failed once
// and the whole checkout/cart-table block silently never got built - the
// worst combination, a confident reply with nothing for the customer to act
// on. The store endpoint itself was healthy moments before and after (a
// one-off blip, not a systemic outage), so a single retry covers it without
// meaningfully slowing down the common (first-try-succeeds) case.
async function call(url, opts) {
  const method = opts && opts.method ? opts.method : 'GET';
  const body = opts && opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const t = await httpText(url, { method, body });
      const parsed = firstJson(t);
      if (parsed !== null) return parsed;
    } catch (e) {}
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

let cats = [];
let items = [];
let total = null;
let count = 0;

const catsRes = await call(base + '/api/v3/categories?parent_id=0');
if (catsRes && Array.isArray(catsRes.data)) {
  cats = catsRes.data.slice(0, 12).map((c) => c && c.name).filter(Boolean);
}

if (userId.startsWith('tmp')) {
  const read = await call(base + '/api/v3/carts/' + encodeURIComponent(userId), { method: 'POST' });
  let rawList = [];
  if (Array.isArray(read)) {
    rawList = read;
  } else if (read && typeof read === 'object') {
    if (Array.isArray(read.data)) rawList = read.data;
    else rawList = [read];
  }
  for (const shop of rawList) {
    for (const it of (shop && (shop.cart_items || shop.items)) || []) {
      if (!it) continue;
      const price = Number(it.price || it.calculable_price || 0) || 0;
      const qty = Number(it.quantity) || 0;
      const pname = it.product_name || it.name || 'Product';
      items.push({ product_id: it.product_id || it.id, name: pname, quantity: qty, line: price * qty });
      count += qty;
    }
  }
  const sum = await call(base + '/api/v3/cart-summary/' + encodeURIComponent(userId));
  if (sum) total = sum.grand_total != null ? sum.grand_total : (sum.grand_total_value != null ? sum.grand_total_value : null);
  if (total == null) total = items.reduce((s2, i2) => s2 + i2.line, 0);
}

// Human-in-the-loop resume: the widget sends an "action" when the customer taps
// a size option (variant-picker) or approves/declines a cart change (approval).
// Turn it into an explicit instruction the orchestrator obeys verbatim — see the
// ORCHESTRATOR prompt's "CUSTOMER ACTION" section. Without this the resumed turn
// would just be a bare sentence and the model would re-decide from scratch.
function intOf(v) { const n = parseInt(String(v == null ? '' : v), 10); return Number.isFinite(n) && n > 0 ? n : 0; }
function optName(v) { return String(v == null ? '' : v).trim().slice(0, 60); }
function buildActionLine(a) {
  if (!a || typeof a !== 'object') return '';
  const t = String(a.type || '');
  if (t === 'variant-selected') {
    const pid = intOf(a.product_id);
    if (!pid) return '';
    return 'CUSTOMER ACTION: variant-selected product_id=' + pid + ' variant=' + (optName(a.variant) || '(none)') + ' quantity=' + (intOf(a.quantity) || 1) + '. Call cart-add now with these exact values, then confirm what was added.';
  }
  if (t === 'approval') {
    const items = Array.isArray(a.items) ? a.items.filter((x) => x && intOf(x.product_id)).slice(0, 10) : [];
    const list = items.map((x) => 'product_id=' + intOf(x.product_id) + ' variant=' + (optName(x.variant) || '(none)') + ' quantity=' + (intOf(x.quantity) || 1)).join('; ');
    if (String(a.decision) === 'approve') {
      if (!items.length) return '';
      return 'CUSTOMER ACTION: approval approved for cart-add. Items: ' + list + '. Call cart-add once per item with these exact values now, then confirm what was added.';
    }
    if (String(a.decision) === 'decline') {
      return 'CUSTOMER ACTION: approval declined for cart-add.' + (items.length ? ' Items: ' + list + '.' : '') + ' Do NOT add anything - acknowledge in one short sentence and offer an alternative.';
    }
  }
  return '';
}
const action = (body.action && typeof body.action === 'object') ? body.action : null;
const actionLine = buildActionLine(action);

const parts = [];
parts.push('[guest cart user: ' + userId + ']');
if (cats.length) parts.push('CATEGORIES: ' + cats.join(', '));
let cartTxt = 'CURRENT CART (' + count + ' item' + (count === 1 ? '' : 's');
if (total != null) cartTxt += ', total: ৳' + total;
cartTxt += '):';
if (items.length) {
  cartTxt += '\\n' + items.map((i2) => '- [product_id: ' + i2.product_id + '] ' + i2.name + ' × ' + i2.quantity + ' — ৳' + i2.line).join('\\n');
} else {
  cartTxt += ' (empty)';
}
parts.push(cartTxt);

// Always emit this line, even with nothing saved — an explicit "not provided"
// per field is what lets the orchestrator tell "nothing known yet" apart from
// "this turn just has no CUSTOMER PROFILE block", and ask for exactly the
// fields actually missing instead of guessing or re-asking ones it already has.
parts.push('CUSTOMER PROFILE: Skin: ' + ((profile && profile.skin) || 'not provided') +
  ' | Concern: ' + ((profile && profile.concern) || 'not provided') +
  ' | Budget: ' + ((profile && profile.budget) || 'not provided'));

if (actionLine) parts.push(actionLine);

const ctx = 'CURRENT SHOPPING CONTEXT (authoritative - trust this over conversation history):\\n' + parts.join('\\n');
const systemPrompt = ${JSON.stringify(P.ORCHESTRATOR)} + '\\n\\n' + ctx;

return [{ json: { chatInput: msgRaw, userId, sessionId: userId, conversationId: userId, profile, evalMode, action, systemPrompt } }];
`;

// ---------------------------------------------------------------------------
// HTTP tools (direct on orchestrator)
// ---------------------------------------------------------------------------
function httpToolParams({ name, description, method, url, queryParams }) {
  const p = {
    name,
    description,
    toolDescription: description,
    method,
    url,
    authentication: 'none',
    sendHeaders: false,
    sendBody: false,
    options: { response: { response: { neverError: true, responseFormat: 'text', outputPropertyName: 'data' } } },
  };
  if (queryParams) {
    p.sendQuery = true;
    p.specifyQuery = 'manually';
    p.queryParameters = { parameters: queryParams };
  }
  return p;
}

// Specialist Workflow Tool factory
function specTool(name, description, workflowId) {
  return {
    name,
    params: {
      name,
      description,
      source: 'database',
      workflowId: { value: workflowId },
      workflowInputs: { mappingMode: 'defineBelow', value: null },
    },
  };
}

const SPECIALIST_TOOLS = [
  specTool('product_discovery', P.TOOL.productDiscovery, SPEC.productDiscovery),
  specTool('support_specialist', P.TOOL.supportSpecialist, SPEC.supportSpecialist),
  specTool('cart_specialist', P.TOOL.cartSpecialist, SPEC.cartSpecialist),
  specTool('order_management', P.TOOL.orderManagement, SPEC.orderSpecialist),
  // Not a specialist sub-agent on purpose: "show me current offers" needs no
  // multi-step reasoning, just a straight read, so it skips a whole LLM
  // round-trip the same way cart-add does. Backed by tool-current-offers
  // (dev/build-workflows.mjs OFFERS_CODE).
  specTool('get_current_offers', P.TOOL.currentOffers, OFFERS_TOOL_ID),
];

// Cart-add stays on orchestrator (orchestrator searches via product_discovery, then adds directly)
// NOTE: $fromAI in queryParams does NOT resolve in httpRequestTool 4.2 as AI tool
// (proven: search-products sent no keyword). Embed params directly in URL instead.
// The `variant` argument is the option NAME (e.g. "45ml"), not an id — the store reads
// it as a string and 500s with "Attempt to read property price on null" if a variant
// product is added without it. Passed only when non-empty so plain products are unaffected.
const CART_ADD_TOOL = {
  name: 'cart-add',
  params: httpToolParams({
    name: 'cart-add',
    description: P.TOOL.cartAdd,
    method: 'POST',
    url: `=${P.STORE}/api/v3/carts/add?user_id={{ encodeURIComponent($fromAI('user_id', 'the guest cart user id shown in CURRENT SHOPPING CONTEXT', 'string')) }}&id={{ $fromAI('product_id', 'the product id to add (from product_discovery results)', 'number') }}&quantity={{ $fromAI('quantity', 'quantity to add (1-10)', 'number') }}{{ $fromAI('variant', 'the exact size/option name for a product that has size options (e.g. 45ml); empty for products with no options', 'string') ? '&variant=' + encodeURIComponent($fromAI('variant', 'the exact size/option name for a product that has size options (e.g. 45ml); empty for products with no options', 'string')) : '' }}`,
  }),
};

// ---------------------------------------------------------------------------
// Response (Code) - contract JSON + blocks + price-guard.
// Port of biz-buddy ChatController::buildBlocks / richTextTotalMismatch:
//  - [BLOCK product-grid]  -> {type:'product-grid', products:[ProductCardData]}
//    (ids from META_PRODUCT_IDS, re-fetched live = ground truth; empty resolves dropped)
//  - [BLOCK cart-table]    -> {type:'cart-table', items, total, count} (live re-read)
//  - price guard: a ৳ figure next to the word "total" that contradicts the
//    emitted cards/cart is replaced with the true total, so the user never
//    sees a price that fights the cards beside it.
//  - markers + META footer are stripped from reply (system-only metadata).
// Block failures must NEVER break the reply: everything is wrapped in try/catch.
// ---------------------------------------------------------------------------
const RESPONSE_CODE = `
const d = $input.first().json.output;
const raw = typeof d === 'string' ? d : (d && typeof d === 'object' && 'output' in d ? d.output : JSON.stringify(d));
let replyTxt = typeof d === 'string' ? d : String(raw ?? '');
// Gemini occasionally emits a mojibake rune (αº│) for ৳ — normalize it so the
// price guard and currency formatter can see the real amounts.
replyTxt = replyTxt.replace(/[\u03b1\u00ba\u2502]{2,3}/g, '\u09f3');
function plainText(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\\[BLOCK[^\\]]*\\]/gi, '')
    .replace(/\\n{2,}/g, '\\n')
    .trim();
}
function stripFooter(s) {
  return String(s ?? '')
    .replace(/META_PRODUCT_IDS:[^\\n]*\\n?/gi, '')
    .replace(/META_ORDER_JSON:[^\\n]*\\n?/gi, '')
    .replace(/META_VARIANT_PRODUCT_ID:[^\\n]*\\n?/gi, '')
    .replace(/META_APPROVAL_JSON:[^\\n]*\\n?/gi, '')
    .replace(/META_COMPARISON_JSON:[^\\n]*\\n?/gi, '')
    .replace(/META_SUGGESTIONS:[^\\n]*\\n?/gi, '')
    .trim();
}
function normalizeCurrency(s) {
  return String(s ?? '').replace(/(\\d[\\d,]*(?:\\.\\d{1,2})?)\\s*৳/g, '৳$1');
}
function fmtTaka(n) {
  return '৳' + Math.round(Number(n) || 0).toLocaleString('en-US');
}
function guardTotal(reply, actual) {
  return String(reply ?? '').replace(/(total[^৳\\d\\n]{0,30}৳\\s*)(\\d[\\d,]*)/gi, (m, pre, num) => {
    const v = parseFloat(String(num).replace(/,/g, ''));
    if (!Number.isFinite(v) || Math.abs(v - actual) < 0.01) return m;
    return pre + fmtTaka(actual).slice(1);
  });
}
// The model is asked (dev/prompts.js) not to re-list "- **Name** – ৳price" when
// the product-grid card already shows it, but that instruction is not reliably
// followed — verified live 2026-10-13: it still wrote the list, in varying
// formats (different bullet glyphs, a trailing generic clause), after 3
// escalating prompt rewrites. This is the deterministic backstop. A line only
// counts as redundant (and gets stripped) when it names ONE product in bold
// AND, once the bold span/price/discount parenthetical are removed, nothing
// but punctuation is left — i.e. the line is LITERALLY just "name + price",
// adding no fact the card doesn't already show. This is a real check, not
// just "has exactly one bold span": verified live 2026-10-15, a full-profile
// moisturizer recommendation wrote three perfectly good bullets, each one
// bold product name followed by a real why-it-fits clause (no price on the
// line at all) — the OLD one-bold-span-means-redundant check stripped all
// three anyway, leaving the intro sentence ("...ranging from ৳1,050 to
// ৳1,450:") dangling with nothing after its colon, a reply that reads as
// cut off. A SECOND bold span or the word "shade"/"step"/"morning"/"night"/
// "variant" (a color-search shade pick, a routine step, a size the card
// can't show) also always means real information, left alone regardless.
function stripRedundantProductLines(s) {
  const lines = String(s ?? '').split('\\n');
  const bulletRe = /^[-*•●‣·]\\s*/;
  const isRedundant = (raw) => {
    const l = raw.trim();
    if (!bulletRe.test(l)) return false;
    const rest = l.replace(bulletRe, '');
    const boldSpans = rest.match(/\\*\\*(.+?)\\*\\*/g) || [];
    if (boldSpans.length !== 1) return false; // 0 = not naming a product; 2+ = likely a shade/variant call-out
    // Keywords that mean the line carries real structure beyond "here is this
    // product again" — a chosen shade, a routine step, or a size the card's
    // own name/price can't convey — leave those lines alone.
    if (/\\b(shade|step|morning|night|variant)\\b/i.test(rest)) return false;
    const withoutBold = rest.replace(/\\*\\*(.+?)\\*\\*/, '');
    const bare = withoutBold
      .replace(/৳\\s*[\\d,]+(?:\\.\\d+)?/g, '') // the price itself
      .replace(/\\(was[^)]*\\)/gi, '') // "(was ৳X, -N%)" discount parenthetical
      .replace(/[\\s–—\\-•:,.()]+/g, ''); // leftover dashes/punctuation/whitespace
    return bare.length === 0; // nothing but name + price(+discount) survives
  };
  const kept = lines.filter((l) => !isRedundant(l));
  // Only treat it as the redundant-list pattern (and actually drop anything) when
  // 2+ lines matched — a single bolded name+price is normal single-product prose.
  if (lines.length - kept.length < 2) return s;
  let result = kept.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  // Belt-and-suspenders: if stripping still leaves an introductory "...ranging
  // from X to Y:" sentence with nothing after it, a dangling colon reads as a
  // cut-off reply even though the product cards below carry every item — turn
  // it into a period rather than ship something that looks broken.
  if (/:\\s*$/.test(result)) result = result.replace(/:\\s*$/, '.');
  return result;
}
const base = ($env.STORE_BASE_URL || 'https://stg-admin.perfectobd.com').replace(/\\/+$/, '');
function textOf(r) {
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') {
    if ('body' in r) return typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return JSON.stringify(r);
  }
  return String(r ?? '');
}
function firstJson(s) {
  if (s == null) return null;
  const i = s.indexOf('{');
  const j = s.indexOf('[');
  const start = (i < 0 ? j : (j < 0 ? i : Math.min(i, j)));
  if (start < 0) return null;
  try { return JSON.parse(s.slice(start)); } catch { return null; }
}
// The order specialist's output arrives wrapped (observation is JSON text like
// [{text:"...META_ORDER_JSON: {\\"code\\":...}"}]), so the META line's quotes are
// escaped at the outer level. Dig through strings/arrays/{text,data,json,output}
// until the plain text is reached, then parse the footer.
function orderMetaFrom(v, depth) {
  const d = depth || 0;
  if (d > 6 || v == null) return null;
  if (typeof v === 'string') {
    const direct = v.match(/META_ORDER_JSON:\\s*(\\{[^\\n]*\\})/);
    if (direct) { try { return JSON.parse(direct[1]); } catch (e) {} }
    const parsed = firstJson(v);
    if (parsed !== null && typeof parsed === 'object') return orderMetaFrom(parsed, d + 1);
    return null;
  }
  if (Array.isArray(v)) {
    for (const x of v) { const r = orderMetaFrom(x, d + 1); if (r) return r; }
    return null;
  }
  if (typeof v === 'object') {
    if (typeof v.text === 'string') { const r = orderMetaFrom(v.text, d + 1); if (r) return r; }
    for (const k of ['data', 'json', 'output']) {
      if (v[k] !== undefined) { const r = orderMetaFrom(v[k], d + 1); if (r) return r; }
    }
  }
  return null;
}
// One retry on a transient failure (network blip, store cold-start) before
// giving up - live-verified 2026-10-14: a customer's "proceed to checkout"
// got a confidently-worded reply ("your cart is ready... total ৳2,210") with
// an EMPTY blocks array, because this single unretried cart-read failed once
// and the whole checkout/cart-table block silently never got built - the
// worst combination, a confident reply with nothing for the customer to act
// on. The store endpoint itself was healthy moments before and after (a
// one-off blip, not a systemic outage), so a single retry covers it without
// meaningfully slowing down the common (first-try-succeeds) case.
async function call(url, opts) {
  const method = opts && opts.method ? opts.method : 'GET';
  const body = opts && opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const t = await httpText(url, { method, body });
      const parsed = firstJson(t);
      if (parsed !== null) return parsed;
    } catch (e) {}
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}
function httpText(url, { method, body } = {}) {
  return new Promise((resolve) => {
    let u = null;
    try { u = new (require('url').URL)(url); } catch (e) { return resolve(null); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve(null);
    const httpMod = require(u.protocol === 'https:' ? 'https' : 'http');
    const headers = body != null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(String(body)) } : {};
    const req = httpMod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: method || 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 5000000) { req.destroy(); resolve(null); } });
      res.on('end', () => resolve(data));
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    if (body != null) req.write(String(body));
    req.end();
  });
}
function toCard(p) {
  try {
    if (!p || typeof p !== 'object') return null;
    const id = Number(p.id) || 0;
    const name = String(p.name ?? '').trim();
    const price = Number(p.calculable_price ?? p.nonformated_price ?? p.price ?? 0) || 0;
    if (!id || !name || !(price > 0)) return null;
    const brand = p.brand && typeof p.brand === 'object' ? (p.brand.name ?? null) : (p.brand ?? null);
    const cat = p.category && typeof p.category === 'object' ? (p.category.name ?? null) : (p.category ?? null);
    // qty travels all the way to the widget's variant-picker/quick-view (the
    // only place it was previously used), kept here too so a SINGLE place
    // computes "is this variant purchasable" for both that and in_stock below.
    const vars = Array.isArray(p.variant) ? p.variant.map((v) => ({ id: Number(v.id) || 0, name: String(v.variant ?? v.name ?? ''), price: Number(v.discount_price ?? v.price ?? 0) || 0, qty: Number(v.qty) || 0 })).filter((v) => v.id) : [];
    const desc = String(p.short_description ?? p.description ?? '').replace(/<[^>]+>/g, '').replace(/\\s+/g, ' ').trim().slice(0, 300) || null;
    // The store's v3 detail reports the PARENT as in_stock=false / current_stock=0
    // for a variant product even when one of its SIZES has real stock (e.g.
    // product 1 is parent in_stock=false with a 30ml variant qty=13) - so this is
    // "is ANYTHING about this product purchasable", not just the parent flag.
    // snake_case to match what the widget's own toCard() already reads off a raw
    // store product (p.in_stock) - the chat block is just another product source.
    const parentOut = p.in_stock === false || p.in_stock === 0 || p.in_stock === '0';
    const inStock = !parentOut || vars.some((v) => v.qty > 0);
    // variant_product (not just hasVariants) because the widget's OWN toCard()
    // (perfecto-ai-demo.html) decides whether a card needs a size choice by
    // checking p.variant_product / p.variant / p.choice_options - the raw store
    // field names, which this chat-block object never had. Without it a variant
    // product from a chat card silently fell through to a plain Add click (no
    // variant argument), which the store's cart-add rejects.
    return { id, name, slug: String(p.slug ?? ''), price, rating: Number(p.rating ?? 0) || 0, reviewCount: Number(p.num_of_sale ?? p.total_reviews ?? 0) || 0, description: desc, image: p.thumbnail_image ?? null, thumbnail: p.thumbnail_image ?? null, category: cat, brand, hasVariants: vars.length > 0, variants: vars, variant_product: vars.length > 0 ? 1 : 0, in_stock: inStock };
  } catch (e) {
    return null;
  }
}
const out = { reply: '', conversation_id: null, blocks: [], suggestions: [], token_usage: null };
try { out.conversation_id = $('Prepare Input').first().json.userId; } catch {}
let userId = null;
try { userId = $('Prepare Input').first().json.userId; } catch {}
const wantsGrid = /\\[BLOCK\\s+product-grid\\]/i.test(replyTxt);
const wantsCart = /\\[BLOCK\\s+cart-table\\]/i.test(replyTxt);
const wantsCheckout = /\\[BLOCK\\s+checkout\\]/i.test(replyTxt);
const wantsOrder = /\\[BLOCK\\s+order-status\\]/i.test(replyTxt);
// Human-in-the-loop steps the agent asks for: a size choice (variant-picker) and
// a confirm-before-changing-cart (approval). Both are blocks-only turns — the
// customer's tap comes back on the NEXT request as a structured action.
const wantsVariant = /\\[BLOCK\\s+variant-picker\\]/i.test(replyTxt);
const wantsApproval = /\\[BLOCK\\s+approval\\]/i.test(replyTxt);
const wantsComparison = /\\[BLOCK\\s+comparison\\]/i.test(replyTxt);
let ids = [];
try {
  const m = replyTxt.match(/META_PRODUCT_IDS:\\s*([\\d,\\s]+|none)/i);
  if (m && m[1] && !/^none$/i.test(m[1].trim())) {
    ids = [...new Set(m[1].split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite))].slice(0, 5);
  }
} catch {}
// The variant-picker carries only the product id; the OPTIONS are rebuilt live
// from the store below (same ground-truth rule as the product grid) so the
// customer never picks a size the model made up.
let variantId = 0;
try {
  const vm = replyTxt.match(/META_VARIANT_PRODUCT_ID:\\s*(\\d+)/i);
  if (vm) variantId = parseInt(vm[1], 10) || 0;
} catch {}
// The approval payload is the exact cart-add the agent intends; the widget shows
// it and posts it back verbatim on approve.
let approvalMeta = null;
try {
  const am = replyTxt.match(/META_APPROVAL_JSON:\\s*(\\{.*\\})/i);
  if (am) { try { approvalMeta = JSON.parse(am[1]); } catch (e) {} }
} catch {}
// The comparison payload is the agent's own row copy (price/best-for/etc are
// authored text, not re-fetched); only the item cards below are ground truth.
let comparisonMeta = null;
try {
  const cm = replyTxt.match(/META_COMPARISON_JSON:\\s*(\\{.*\\})/i);
  if (cm) { try { comparisonMeta = JSON.parse(cm[1]); } catch (e) {} }
} catch {}
// Guided-move chips the orchestrator authors itself, grounded in this turn
// (dev/prompts.js "SUGGESTED NEXT STEPS") - replaces the widget's old
// context-blind fallback (any product-grid always got the same canned
// "Compare / Add the best match / Show cheaper alternatives" regardless of
// what was actually asked). The widget still falls back to its own guesser
// when this is absent/empty, so a turn the model skips this on is never silent.
let suggestions = [];
try {
  const sm = replyTxt.match(/META_SUGGESTIONS:\\s*(\\[.*?\\])/i);
  if (sm) {
    const parsed = JSON.parse(sm[1]);
    if (Array.isArray(parsed)) suggestions = parsed.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 80)).slice(0, 3);
  }
} catch {}
// The orchestrator often drops META/marker lines when rephrasing, so also read
// the specialists' raw tool results (intermediateSteps observations). The
// product specialist always appends META_PRODUCT_IDS + [BLOCK product-grid];
// the cart specialist appends [BLOCK cart-table]. A successful cart-add this
// turn also warrants the cart table (its true total is re-read live below).
let wantsGridObs = false;
let wantsCartObs = false;
let wantsCheckoutObs = false;
let wantsOrderObs = false;
let cartAddRan = false;
let orderMeta = null;
// Captures the current-offers tool's raw text when it's the general-summary
// call (FLASH SALE:/COMBO OFFER: lines only appear on that branch, never on
// the named-deal branch - see OFFERS_CODE) so the salvage below can compare
// against it.
let offersObsText = '';
try {
  const steps = $input.first().json.intermediateSteps || [];
  for (const st of steps) {
    const toolName = String(st && st.action && st.action.tool || '');
    let s = '';
    const o = st && st.observation;
    if (typeof o === 'string') s = o;
    else if (o != null) { try { s = JSON.stringify(o); } catch {} }
    if (toolName === 'cart-add' && /added to cart successfully/i.test(s)) cartAddRan = true;
    if (!s) continue;
    if (/\\[BLOCK\\s+product-grid\\]/i.test(s)) wantsGridObs = true;
    if (/\\[BLOCK\\s+cart-table\\]/i.test(s)) wantsCartObs = true;
    if (/\\[BLOCK\\s+checkout\\]/i.test(s)) wantsCheckoutObs = true;
    if (/\\[BLOCK\\s+order-status\\]/i.test(s)) wantsOrderObs = true;
    if (toolName === 'get_current_offers' && /FLASH SALE:|COMBO OFFER:/i.test(s)) offersObsText = s;
    // The order specialist emits META_ORDER_JSON carrying the already-PII-free order payload.
    if (!orderMeta) orderMeta = orderMetaFrom(o);
    if (!ids.length) {
      try {
        const parsed = typeof o === 'string' ? JSON.parse(o) : o;
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const it of arr) {
          const pids = it && Array.isArray(it.product_ids) ? it.product_ids : (it && it.json && Array.isArray(it.json.product_ids) ? it.json.product_ids : null);
          if (pids) {
            const clean = [...new Set(pids.map((n) => parseInt(n, 10)).filter(Number.isFinite))].slice(0, 5);
            if (clean.length) { ids = clean; break; }
          }
        }
      } catch {}
      if (!ids.length) {
        const m2 = s.match(/META_PRODUCT_IDS:\\s*([\\d,\\s]+)/i);
        if (m2) ids = [...new Set(m2[1].split(',').map((x) => parseInt(x, 10)).filter(Number.isFinite))].slice(0, 5);
      }
    }
  }
} catch {}
// Deterministic backstop for the same intermittent-drop pattern as
// stripRedundantProductLines below: live-verified 2026-10-15 - the model
// dropped ALL THREE "FLASH SALE:" lines and every "COMBO OFFER:" line from
// its reply roughly 1 in 4 tries, despite dev/prompts.js's explicit "every
// FLASH SALE and COMBO OFFER line it returned must appear in your reply...
// do not make it" instruction - while still correctly listing the plain
// discounted products that came after them in the same tool text. Compare
// the raw tool text (ground truth) against the reply and re-append whatever
// is genuinely missing; matching on the deal/offer NAME (not the whole line)
// tolerates the model's own light reformatting without double-posting it.
if (offersObsText) {
  const dealLines = offersObsText.split('\\n').filter((l) => /^(FLASH SALE|COMBO OFFER):/i.test(l.trim()));
  const missing = dealLines.filter((l) => {
    const name = l.replace(/^(FLASH SALE|COMBO OFFER):\\s*/i, '').split(/\\s+-\\s+/)[0].trim();
    return name && !replyTxt.toLowerCase().includes(name.toLowerCase());
  });
  if (missing.length) {
    replyTxt = replyTxt.trim() + '\\n\\nAlso currently running:\\n' + missing.map((l) => '• ' + l.trim()).join('\\n');
  }
}
const doGrid = wantsGrid || wantsGridObs;
const doCart = wantsCart || wantsCartObs || cartAddRan;
const doCheckout = wantsCheckout || wantsCheckoutObs;
const doOrder = wantsOrder || wantsOrderObs || !!orderMeta;
const blocks = [];
if (doOrder && orderMeta) blocks.push({ type: 'order-status', order: orderMeta });
if (doGrid && !wantsComparison && ids.length) {
  try {
    const cards = [];
    for (const pid of ids) {
      const det = await call(base + '/api/v3/products/' + pid);
      const obj = det && Array.isArray(det.data) ? det.data[0] : (det && det.data && typeof det.data === 'object' ? det.data : null);
      const card = toCard(obj);
      // Never render an item nothing can buy: the customer reads the grid/carousel as
      // buyable (and "add the ones you suggested" resolves to these ids). toCard() itself
      // computes in_stock as parent-OR-any-variant (a variant product can report its PARENT
      // as in_stock=false / current_stock=0 while one of its sizes has real stock, e.g.
      // product 1 is parent in_stock=false with a 30ml variant qty=13), so this is simply
      // "is this card buyable at all" - the UI's own Add button also disables on in_stock
      // (perfecto-ai-demo.html), this is the belt to that suspenders: don't even offer the
      // card if by some race (stock sold out between product_discovery's search and this
      // live re-fetch) nothing on it is purchasable any more.
      if (card && card.in_stock) cards.push(card);
    }
    if (cards.length) {
      // product-grid vs product-carousel is a true 50/50 coin flip, decided HERE in
      // code - not by asking the model to "randomly" pick one in its text. An LLM
      // asked to pick randomly is not actually random (it lands on whatever's most
      // likely in its training), which is exactly why this always came out as
      // product-grid before: nothing upstream ever varied it. This is the one place
      // the rendered block's real type is set, regardless of which specialist or
      // tool (product_discovery, get_current_offers, the routine path, ...)
      // triggered the grid, so flipping it here covers all of them uniformly.
      const layout = Math.random() < 0.5 ? 'product-grid' : 'product-carousel';
      blocks.push({ type: layout, products: cards });
      const gridTotal = cards.reduce((s, c) => s + c.price, 0);
      replyTxt = guardTotal(replyTxt, gridTotal);
      if (cards.length >= 2) replyTxt = stripRedundantProductLines(replyTxt);
    }
  } catch {}
}
// COMPARISON — items re-fetched live (ground truth) in the SAME order as
// META_PRODUCT_IDS; rows are the agent's own copy (price/best-for/etc are
// authored text, not fetched). Items keep their original order with NO
// stock filtering (unlike the grid above) because dropping one would shift
// every row's values out of alignment with its column.
if (wantsComparison && comparisonMeta && Array.isArray(comparisonMeta.rows) && ids.length) {
  try {
    const items = [];
    for (const pid of ids) {
      const det = await call(base + '/api/v3/products/' + pid);
      const obj = det && Array.isArray(det.data) ? det.data[0] : (det && det.data && typeof det.data === 'object' ? det.data : null);
      const card = toCard(obj);
      if (card) items.push(card);
    }
    const rows = comparisonMeta.rows
      .map((r) => ({ label: String(r && r.label || '').trim(), values: Array.isArray(r && r.values) ? r.values.map((v) => String(v ?? '')) : [] }))
      .filter((r) => r.label)
      .slice(0, 8);
    if (items.length && rows.length) blocks.push({ type: 'comparison', items, rows });
  } catch {}
}
if ((doCart || doCheckout) && userId) {
  try {
    const rows = [];
    const read = await call(base + '/api/v3/carts/' + encodeURIComponent(userId), { method: 'POST' });
    if (Array.isArray(read)) {
      for (const shop of read) {
        for (const it of (shop && shop.cart_items) || []) {
          if (!it) continue;
          rows.push({ key: String(it.id ?? (rows.length + 1)), product_id: Number(it.product_id) || 0, variation_id: null, name: String(it.product_name ?? 'Product'), variant_name: String(it.variation ?? '') || null, price: Number(it.price) || 0, quantity: Number(it.quantity) || 0 });
        }
      }
    }
    if (rows.length) {
      // cart-summary API returns 0 for guest (tmp-*) carts (reads server session, not the guest cart),
      // so compute the total from the read-back rows — those carry the authoritative price.
      const total = rows.reduce((s, r) => s + r.price * r.quantity, 0);
      const count = rows.reduce((s, r) => s + r.quantity, 0);
      if (doCart) blocks.push({ type: 'cart-table', items: rows, total, count });
      // checkout: a deliberate, minimal signal - this app's job stops at telling
      // the caller (SPA/mobile) "the customer wants to check out, here is what's
      // in the cart"; where/how to actually send them to checkout is the
      // storefront's own concern, not something this workflow decides or builds
      // a URL for. Gated on a real non-empty cart (same deterministic backstop
      // as the out-of-stock card filter elsewhere in this file) regardless of
      // what the model said - never signal checkout for nothing to buy.
      if (doCheckout) blocks.push({ type: 'checkout', items: rows, total, count });
      replyTxt = guardTotal(replyTxt, total);
    }
  } catch {}
}
// VARIANT PICKER — options re-fetched live (ground truth), so the customer
// chooses from the store's real option names/prices/stock, never the model's.
if (wantsVariant && variantId) {
  try {
    const det = await call(base + '/api/v3/products/' + variantId);
    const obj = det && Array.isArray(det.data) ? det.data[0] : (det && det.data && typeof det.data === 'object' ? det.data : null);
    const varr = Array.isArray(obj && obj.variant) ? obj.variant : [];
    const options = varr
      .map((v) => ({ name: String(v.variant ?? v.name ?? '').trim(), price: Number(v.discount_price ?? v.price ?? 0) || 0, qty: Number(v.qty) || 0 }))
      .filter((o) => o.name);
    if (obj && options.length) {
      blocks.push({ type: 'variant-picker', productId: Number(obj.id) || variantId, productName: String(obj.name ?? '').trim(), image: obj.thumbnail_image ?? null, options });
    }
  } catch {}
}
// APPROVAL — the agent's intended cart-add, shown for human verification. Only
// items with a real numeric product_id survive; the widget posts them back
// verbatim when the customer approves.
if (wantsApproval && approvalMeta && Array.isArray(approvalMeta.items)) {
  const items = approvalMeta.items
    .map((x) => ({ product_id: Number(x.product_id) || 0, name: String(x.name ?? '').trim(), variant: x.variant ? String(x.variant) : null, quantity: Math.max(1, Math.min(10, Number(x.quantity) || 1)), price: Number(x.price) || 0 }))
    .filter((x) => x.product_id > 0)
    .slice(0, 10);
  if (items.length) {
    blocks.push({ type: 'approval', action: String(approvalMeta.action || 'cart-add'), summary: String(approvalMeta.summary || 'Confirm this cart change').slice(0, 200), items, approveLabel: 'Add to cart', denyLabel: 'Cancel' });
  }
}
out.blocks = blocks;
// Deterministic backstop for the same reason as stripRedundantProductLines below
// and the exhausted-iterations salvage elsewhere in this codebase: the prompt
// asks the model not to emit suggestions on a variant-picker/approval/checkout
// turn (the customer's immediate next step is already the block itself), but
// that is a prompt instruction, not a guarantee - never trust it alone. The
// widget's own chip precedence checks data.suggestions BEFORE it checks for
// these block types, so an un-caught suggestions array would bury the actual
// action under more pills.
out.suggestions = (wantsVariant || wantsApproval || doCheckout) ? [] : suggestions;
const replyClean = normalizeCurrency(plainText(stripFooter(replyTxt))).replace(/[\u03b1\u00ba\u2502]{2,3}/g, '\u09f3').slice(0, 8000);
out.reply = replyClean;
// token_usage stays null on this n8n version and that is not fixable in-workflow:
// the Agent node's output is {output, intermediateSteps} (it never emits
// tokenUsage), and n8n's data proxy cannot reach the ai_languageModel sub-node
// where the per-call usage actually lives — every accessor ($('OpenAI Chat Model'),
// $node[...], .all()/.first()) throws "No data found from main input".
// The real per-turn cost is read out-of-band from n8n's Postgres runData by
// dev/prod-bench.mjs (orchestrator + child specialist executions). See README.
let usage = null;
try { usage = $input.first().json.tokenUsage; } catch {}
if (usage) out.token_usage = { promptTokens: usage.promptTokens || 0, completionTokens: usage.completionTokens || 0, totalTokens: usage.totalTokens || 0 };
return [{ json: out }];
`;

// ---------------------------------------------------------------------------
// Assemble workflow
// ---------------------------------------------------------------------------
function modelNode(x, y) {
  return node({ ...modelNodeFields(), position: pos(x, y) });
}

const nodes = [];
const connections = {};

nodes.push(
  node({
    // responseNode (not lastNode): a missing user_id must come back as a real
    // HTTP 400 with the documented error body, not whatever the last node that
    // happened to run produced. lastNode mode has no per-execution status code,
    // so the "clean 400" Prepare Input already builds as DATA never reached the
    // client as one — the malformed item just flowed into AI Agent, which has no
    // chatInput to work with, and crashed into an opaque 500 "Error in workflow"
    // instead (verified live 2026-10-13, see dev/eval-harness.mjs "contract" group).
    // authentication: 'jwtAuth' gates this public endpoint behind a static
    // shared-secret bearer token (see WEBHOOK_JWT_CRED above). Every caller
    // (widget, eval-harness, any other integration) must send
    // Authorization: Bearer <token> or n8n rejects the request before it ever
    // reaches Prepare Input - see WIDGET-CONTRACT.md for the caller-side change.
    parameters: { httpMethod: 'POST', path: 'spike/agent-chat', responseMode: 'responseNode', authentication: 'jwtAuth', options: {} },
    name: 'Webhook',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: pos(0, 0),
    webhookId: WEBHOOK_ID,
    credentials: { jwtAuth: WEBHOOK_JWT_CRED },
  }),
);
nodes.push(
  node({
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: PREPARE_CODE },
    name: 'Prepare Input',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: pos(220, 0),
  }),
);
nodes.push(
  node({
    // True branch = Prepare Input's { error, status } shape (missing user_id) —
    // respond 400 immediately and never reach AI Agent/PG Memory, which have
    // nothing to work with and were what actually threw the 500 before this.
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
        combinator: 'and',
        conditions: [
          {
            id: 'user-id-missing',
            leftValue: "={{ $json.error || '' }}",
            rightValue: 'user_id is required',
            operator: { type: 'string', operation: 'equals' },
          },
        ],
      },
      options: {},
    },
    name: 'User ID Present?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.3,
    position: pos(340, 0),
  }),
);
nodes.push(
  node({
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json }}',
      options: { responseCode: 400 },
    },
    name: 'Respond 400',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.4,
    position: pos(460, 200),
  }),
);
nodes.push(
  node({
    parameters: {
      respondWith: 'json',
      responseBody: '={{ $json }}',
      options: {},
    },
    name: 'Respond Success',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.4,
    position: pos(940, 0),
  }),
);
nodes.push(
  node({
    parameters: {
      promptType: 'define',
      text: '={{ $json.chatInput }}',
      // Cap orchestrator round-trips. The default (10) let a single "add random
      // products" turn spend 8 LLM calls chasing out-of-stock items.
      options: { systemMessage: '={{ $json.systemPrompt }}', returnIntermediateSteps: true, maxIterations: 8 },
    },
    name: 'AI Agent',
    type: '@n8n/n8n-nodes-langchain.agent',
    typeVersion: 2,
    position: pos(460, 0),
  }),
);
nodes.push(modelNode(460, -200));

nodes.push(
  node({
    parameters: {
      sessionIdType: 'customKey',
      sessionKey: '={{ $json.sessionId }}',
      tableName: 'chat_memory_fastmart',
      contextWindowLength: 14,
    },
    name: 'PG Memory',
    type: '@n8n/n8n-nodes-langchain.memoryPostgresChat',
    typeVersion: 1.4,
    position: pos(460, -420),
    credentials: { postgres: PG_CRED },
  }),
);

let ty = 200;
// Cart-add (direct on orchestrator)
const cartAddNode = node({
  parameters: CART_ADD_TOOL.params,
  name: CART_ADD_TOOL.name,
  type: 'n8n-nodes-base.httpRequestTool',
  typeVersion: 4.2,
  position: pos(760, ty),
});
nodes.push(cartAddNode);
connections[cartAddNode.name] = { ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]] };
ty += 160;

// Specialist tools
for (const t of SPECIALIST_TOOLS) {
  const tn = node({
    parameters: t.params,
    name: t.name,
    type: t.params.workflowId ? '@n8n/n8n-nodes-langchain.toolWorkflow' : 'n8n-nodes-base.httpRequestTool',
    typeVersion: t.params.workflowId ? 2.1 : 4.2,
    position: pos(760, ty),
  });
  nodes.push(tn);
  connections[tn.name] = { ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]] };
  ty += 160;
}

nodes.push(
  node({
    parameters: { language: 'javaScript', jsCode: RESPONSE_CODE },
    name: 'Response',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: pos(760, 0),
  }),
);

connections['Webhook'] = { main: [[{ node: 'Prepare Input', type: 'main', index: 0 }]] };
connections['Prepare Input'] = { main: [[{ node: 'User ID Present?', type: 'main', index: 0 }]] };
// If output 0 = true (error present) -> Respond 400; output 1 = false (normal) -> AI Agent.
connections['User ID Present?'] = { main: [[{ node: 'Respond 400', type: 'main', index: 0 }], [{ node: 'AI Agent', type: 'main', index: 0 }]] };
connections[MODEL_NODE.nodeName] = { ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]] };
connections['PG Memory'] = { ai_memory: [[{ node: 'AI Agent', type: 'ai_memory', index: 0 }]] };
connections['AI Agent'] = { main: [[{ node: 'Response', type: 'main', index: 0 }]] };
connections['Response'] = { main: [[{ node: 'Respond Success', type: 'main', index: 0 }]] };

const wf = {
  name: 'agent-chat (prod webhook)',
  nodes,
  connections,
  settings: { executionOrder: 'v1' },
};
fs.writeFileSync(`${OUT}/agentChat.json`, JSON.stringify(wf, null, 2));
console.log('built agentChat.json');
console.log('model:', MODEL_NODE.provider, '->', MODEL_NODE.model);
