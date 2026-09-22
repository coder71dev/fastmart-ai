// Builds the Part 2 MAIN agent-chat workflow (context + memory + orchestrator
// + specialist tools + direct store tools + response). Specialists' workflow
// ids are injected from the deploy step (passed via env or edited below).
import fs from 'node:fs';
import * as P from './prompts.js';
import { MODEL_NODE, modelNodeFields } from './model-config.mjs';

const OUT = 'dev/out';
const PG_CRED = { id: 'EsaKbJSqeQFEMuwd', name: 'fastmart Postgres (fastmart_ai DB)' };

// ids produced by dev/deploy.mjs
const SPEC = {
  productDiscovery: 'DQ39wgxL370oX15x',
  supportSpecialist: '84zzrn7RoIof8lhC',
  cartSpecialist: '1epRnYl6wTXaIxMf',
  orderSpecialist: 'TMlk5KZqAZB5ysy7',
};
const N8N = { spec: SPEC };

const rand = () => Math.random().toString(36).slice(2, 8);
const node = (o) => ({ id: o.id || rand(), disabled: false, ...o });
const pos = (x, y) => [x, y];

const WEBHOOK_ID = '9c2a1d7e-4b4f-4d9e-9c0a-1f2a3b4c5d6e';

// ---------------------------------------------------------------------------
// Prepare Input + context builder (Code)
// ---------------------------------------------------------------------------
const PREPARE_CODE = `
const body = $input.first().json.body ?? {};
const msgRaw = (body.message ?? '').toString().trim();
const cid = (body.conversation_id ?? '').toString().trim();
const profile = (body.profile && typeof body.profile === 'object') ? body.profile : null;
const evalMode = body.eval === true || body.eval === 'true';
if (!msgRaw) throw new Error('widget: message is required');
const userId = (cid && cid.startsWith('tmp')) ? cid : ('tmp-widget-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

const base = ($env.STORE_BASE_URL || 'http://fastmart-pro.test').replace(/\\/+$/, '');

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
async function call(url, opts) {
  try {
    const t = await httpText(url, { method: opts && opts.method ? opts.method : 'GET', body: opts && opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null });
    return firstJson(t);
  } catch (e) {
    return null;
  }
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
  if (Array.isArray(read)) {
    for (const shop of read) {
      for (const it of (shop && shop.cart_items) || []) {
        if (!it) continue;
        const price = Number(it.price) || 0;
        const qty = Number(it.quantity) || 0;
        items.push({ product_id: it.product_id, name: it.product_name || 'Product', quantity: qty, line: price * qty });
        count += qty;
      }
    }
  }
  const sum = await call(base + '/api/v3/cart-summary/' + encodeURIComponent(userId));
  if (sum) total = sum.grand_total != null ? sum.grand_total : (sum.grand_total_value != null ? sum.grand_total_value : null);
  if (total == null) total = items.reduce((s2, i2) => s2 + i2.line, 0);
}

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

if (profile) {
  const bits = [];
  if (profile.skin) bits.push('Skin: ' + profile.skin);
  if (profile.concern) bits.push('Concern: ' + profile.concern);
  if (profile.budget) bits.push('Budget: ' + profile.budget);
  if (bits.length) parts.push('CUSTOMER PROFILE: ' + bits.join(' | '));
}

const ctx = 'CURRENT SHOPPING CONTEXT (authoritative - trust this over conversation history):\\n' + parts.join('\\n');
const systemPrompt = ${JSON.stringify(P.ORCHESTRATOR)} + '\\n\\n' + ctx;

return [{ json: { chatInput: msgRaw, userId, sessionId: userId, conversationId: userId, profile, evalMode, systemPrompt } }];
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
  return String(s ?? '').replace(/META_PRODUCT_IDS:[^\\n]*\\n?/gi, '').replace(/META_ORDER_JSON:[^\\n]*\\n?/gi, '').trim();
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
const base = ($env.STORE_BASE_URL || 'http://fastmart-pro.test').replace(/\\/+$/, '');
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
async function call(url, opts) {
  try {
    const t = await httpText(url, { method: opts && opts.method ? opts.method : 'GET', body: opts && opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null });
    return firstJson(t);
  } catch (e) {
    return null;
  }
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
    const vars = Array.isArray(p.variant) ? p.variant.map((v) => ({ id: Number(v.id) || 0, name: String(v.variant ?? v.name ?? ''), price: Number(v.discount_price ?? v.price ?? 0) || 0 })).filter((v) => v.id) : [];
    const desc = String(p.short_description ?? p.description ?? '').replace(/<[^>]+>/g, '').replace(/\\s+/g, ' ').trim().slice(0, 300) || null;
    return { id, name, slug: String(p.slug ?? ''), price, rating: Number(p.rating ?? 0) || 0, reviewCount: Number(p.num_of_sale ?? p.total_reviews ?? 0) || 0, description: desc, image: p.thumbnail_image ?? null, thumbnail: p.thumbnail_image ?? null, category: cat, brand, hasVariants: vars.length > 0, variants: vars };
  } catch (e) {
    return null;
  }
}
const out = { reply: '', conversation_id: null, blocks: [], token_usage: null };
try { out.conversation_id = $('Prepare Input').first().json.userId; } catch {}
let userId = null;
try { userId = $('Prepare Input').first().json.userId; } catch {}
const wantsGrid = /\\[BLOCK\\s+product-grid\\]/i.test(replyTxt);
const wantsCart = /\\[BLOCK\\s+cart-table\\]/i.test(replyTxt);
const wantsOrder = /\\[BLOCK\\s+order-status\\]/i.test(replyTxt);
let ids = [];
try {
  const m = replyTxt.match(/META_PRODUCT_IDS:\\s*([\\d,\\s]+|none)/i);
  if (m && m[1] && !/^none$/i.test(m[1].trim())) {
    ids = [...new Set(m[1].split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite))].slice(0, 5);
  }
} catch {}
// The orchestrator often drops META/marker lines when rephrasing, so also read
// the specialists' raw tool results (intermediateSteps observations). The
// product specialist always appends META_PRODUCT_IDS + [BLOCK product-grid];
// the cart specialist appends [BLOCK cart-table]. A successful cart-add this
// turn also warrants the cart table (its true total is re-read live below).
let wantsGridObs = false;
let wantsCartObs = false;
let wantsOrderObs = false;
let cartAddRan = false;
let orderMeta = null;
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
    if (/\\[BLOCK\\s+order-status\\]/i.test(s)) wantsOrderObs = true;
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
const doGrid = wantsGrid || wantsGridObs;
const doCart = wantsCart || wantsCartObs || cartAddRan;
const doOrder = wantsOrder || wantsOrderObs || !!orderMeta;
const blocks = [];
if (doOrder && orderMeta) blocks.push({ type: 'order-status', order: orderMeta });
if (doGrid && ids.length) {
  try {
    const cards = [];
    for (const pid of ids) {
      const det = await call(base + '/api/v3/products/' + pid);
      const obj = det && Array.isArray(det.data) ? det.data[0] : (det && det.data && typeof det.data === 'object' ? det.data : null);
      // Never render an out-of-stock item as a product card: the customer reads the grid
      // as buyable (and "add the ones you suggested" resolves to these ids). The store's
      // v3 detail carries in_stock — BUT a variant product reports the PARENT as
      // in_stock=false / current_stock=0 while its sizes hold the real stock (e.g. product
      // 1 is in_stock=false with a 30ml variant qty=13), so only drop it when no size has
      // stock either.
      const varr = Array.isArray(obj?.variant) ? obj.variant : [];
      const variantInStock = varr.some((v) => Number(v.qty) > 0);
      const parentOut = !!obj && (obj.in_stock === false || obj.in_stock === 0 || obj.in_stock === '0');
      if (parentOut && !variantInStock) continue;
      const card = toCard(obj);
      if (card) cards.push(card);
    }
    if (cards.length) {
      blocks.push({ type: 'product-grid', products: cards });
      const gridTotal = cards.reduce((s, c) => s + c.price, 0);
      replyTxt = guardTotal(replyTxt, gridTotal);
    }
  } catch {}
}
if (doCart && userId) {
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
      blocks.push({ type: 'cart-table', items: rows, total, count });
      replyTxt = guardTotal(replyTxt, total);
    }
  } catch {}
}
out.blocks = blocks;
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
    parameters: { httpMethod: 'POST', path: 'spike/agent-chat', responseMode: 'lastNode', options: {} },
    name: 'Webhook',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: pos(0, 0),
    webhookId: WEBHOOK_ID,
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
connections['Prepare Input'] = { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] };
connections[MODEL_NODE.nodeName] = { ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]] };
connections['PG Memory'] = { ai_memory: [[{ node: 'AI Agent', type: 'ai_memory', index: 0 }]] };
connections['AI Agent'] = { main: [[{ node: 'Response', type: 'main', index: 0 }]] };

const wf = {
  name: 'agent-chat (prod webhook)',
  nodes,
  connections,
  settings: { executionOrder: 'v1' },
};
fs.writeFileSync(`${OUT}/agentChat.json`, JSON.stringify(wf, null, 2));
console.log('built agentChat.json');
console.log('model:', MODEL_NODE.provider, '->', MODEL_NODE.model);
