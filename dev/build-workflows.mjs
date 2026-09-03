// Builds n8n workflow JSON for Part 2 (specialists + agent-chat main).
//   node dev/build-workflows.mjs
// Writes into dev/out/ ready for dev/deploy.mjs.
import fs from 'node:fs';
import * as P from './prompts.js';

const OUT = 'dev/out';
fs.mkdirSync(OUT, { recursive: true });

const GEMINI_CRED = { id: 'NZ6P1UaAuMYlAFa1', name: 'Gemini API Palm v3' };
const MODEL = 'models/gemini-3.6-flash';
const rand = () => Math.random().toString(36).slice(2, 8);

const node = (o) => ({ id: o.id || rand(), disabled: false, ...o });
const pos = (x, y) => [x, y];

// ---- language model node (shared) -----------------------------------------
function modelNode(x, y) {
  return node({
    parameters: { modelName: MODEL, options: { temperature: 0.2 } },
    name: 'Gemini Model',
    type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
    typeVersion: 1,
    position: pos(x, y),
    credentials: { googlePalmApi: GEMINI_CRED },
  });
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
function specialistWorkflow(name, promptText, { tools = [], formatJs, prepareJs } = {}) {
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
      options: { systemMessage: promptText, returnIntermediateSteps: false },
    },
    name: 'AI Agent',
    type: '@n8n/n8n-nodes-langchain.agent',
    typeVersion: 2,
    position: pos(400, 0),
  });
  nodes.push(agent);
  connections['Sub Trigger'] = { main: [[{ node: 'Prepare Task', type: 'main', index: 0 }]] };
  connections['Prepare Task'] = { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] };
  connections['Gemini Model'] = { ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]] };

  nodes.push(modelNode(400, -180));

  let ty = 180;
  for (const t of tools) {
    const tn = node({
      parameters: t.params,
      name: t.name,
      type: 'n8n-nodes-base.httpRequestTool',
      typeVersion: 4.2,
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
const text = String(raw ?? '').replace(/<[^>]+>/g, '').trim();
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
// Specialists
// ---------------------------------------------------------------------------

const productDiscovery = specialistWorkflow('specialist-product-discovery', P.PRODUCT_DISCOVERY, {
  tools: [
    {
      name: 'search-products',
      params: httpTool({
        name: 'search-products',
        description: P.TOOL.searchProducts,
        method: 'GET',
        url: `=http://fastmart-pro.test/api/v4/products?keyword={{ encodeURIComponent($fromAI('query', 'product keyword to search', 'string')) }}&limit=5{{ $fromAI('brand', 'optional brand name filter', 'string') ? '&brand=' + encodeURIComponent($fromAI('brand', 'optional brand name filter', 'string')) : '' }}`,
        // NOTE: max_price intentionally NOT passed: store Meilisearch index has no
        // filterable attributes, so ?max_price= crashes the API (unit_price not filterable).
        // Budget is enforced by the specialist prompt from returned prices instead.
      }),
    },
    {
      name: 'product-detail',
      params: httpTool({
        name: 'product-detail',
        description: P.TOOL.productDetail,
        method: 'GET',
        url: `=${P.STORE}/api/v3/products/{{ $fromAI('product_id', 'the product id to get details for', 'number') }}`,
      }),
    },
  ],
  formatJs: `const out = $input.first().json.output;
const raw = typeof out === 'string' ? out : (out?.output ?? JSON.stringify(out));
let text = String(raw ?? '').replace(/<[^>]+>/g, '');
const m = text.match(/META_PRODUCT_IDS:\\s*([\\d,\\s]+|none)/i);
let product_ids = [];
if (m && m[1] && !/^none$/i.test(m[1].trim())) {
  product_ids = m[1].split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite);
}
// KEEP the META_PRODUCT_IDS footer in text: the orchestrator parses product ids from it.
// The main workflow Response node strips it before replying to the customer.
text = text.replace(/\\\\n{2,}/g, '\\\\n').trim();
return [{ json: { text, product_ids } }];`,
});

const supportSpecialist = specialistWorkflow('specialist-support', P.SUPPORT_SPECIALIST, {});

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
const text = String(raw ?? '').replace(/<[^>]+>/g, '').replace(/\\n{2,}/g, '\\n').trim();
return [{ json: { text } }];`,
});

const orderSpecialist = specialistWorkflow('specialist-orders', P.ORDER_MANAGEMENT, {
  tools: [
    {
      name: 'track-order',
      params: httpTool({
        name: 'track-order',
        description: 'Look up an order by its code (e.g. PERF-1234) to get status, items, price, and delivery estimate. Call with no code to see nothing - always ask the customer for a code first.',
        method: 'GET',
        url: `=${P.STORE}/api/v3/track-order?code={{ encodeURIComponent($fromAI('order_code', 'the order code like PERF-1234', 'string')) }}`,
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

console.log('built specialists:', Object.keys(specMap).join(', '));
console.log('out dir:', OUT);
