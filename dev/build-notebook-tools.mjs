// build-notebook-tools.mjs — the "notebook-tools" workflow.
//
// One workflow, three jobs, reachable two ways:
//   - from agent-chat as a sub-workflow (Execute Workflow), action "pre-reply"
//   - from perfecto-ai-ops over POST /webhook/notebook-tools (JWT, same
//     credential as the chat webhook), actions "match" and "embed-missing"
//
// Actions
//   pre-reply      {text, user_key, ip, eval}  → daily-limit decision + the
//                  staff guidance block for this message (golden rules + the
//                  most similar notebook examples). Counts the message.
//   match          {text}                       → same guidance, nothing counted
//                  (the "Try a question" box in perfecto-ai-ops)
//   embed-missing  {}                           → (re)compute the meaning
//                  vectors of notebook rows whose text changed since last time
//
// "Similar" means similar in MEANING: every notebook question (plus its
// other_ways_to_ask) is turned into a vector by an embedding model, the
// customer's message too, and we keep the closest ones (cosine similarity).
// No keyword rules anywhere — the AI reads the examples and follows the
// staff's pattern for differently-worded questions.
//
// Everything here fails OPEN: if the embedding call or a table read breaks,
// the chat still answers (without examples, without counting) — a broken
// notebook must never take the shop assistant down.
import fs from 'node:fs';

const OUT = 'dev/out';
let credConfig = {};
try { credConfig = JSON.parse(fs.readFileSync('.n8n-credentials.json', 'utf8')); } catch {}

const WEBHOOK_JWT_CRED = {
  id: process.env.WEBHOOK_JWT_CRED_ID || credConfig.WEBHOOK_JWT_CRED_ID || 'NlmmYmXG8iwr20Rp',
  name: process.env.WEBHOOK_JWT_CRED_NAME || credConfig.WEBHOOK_JWT_CRED_NAME || 'fastmart Webhook JWT',
};
const EMBED_CRED = {
  id: process.env.EMBED_CRED_ID || credConfig.EMBED_CRED_ID || 'NZ6P1UaAuMYlAFa1',
  name: process.env.EMBED_CRED_NAME || credConfig.EMBED_CRED_NAME || 'Gemini API Palm v3',
};
const WEBHOOK_ID = 'b7e0c6f1-3a52-4d1e-9f0b-6c1d2e3f4a5b';

const stableId = (s) => {
  let h = 0;
  for (const c of 'notebook-tools:' + s) h = (h * 31 + c.charCodeAt(0)) | 0;
  const hex = (Math.abs(h).toString(16) + '00000000').slice(0, 8);
  return `${hex}-0000-4000-8000-${hex}${hex.slice(0, 4)}`;
};
const node = (o) => ({ id: stableId(o.name), ...o });
const table = (name) => ({ __rl: true, mode: 'name', value: name, cachedResultName: name });

// ---- code ---------------------------------------------------------------------

const NORMALIZE_CODE = `
const j = $input.first().json;
const b = (j.body && typeof j.body === 'object') ? j.body : j;
const action = String(b.action || 'match');
return [{ json: {
  action,
  text: String(b.text || '').slice(0, 2000),
  user_key: String(b.user_key || '').slice(0, 120),
  ip: String(b.ip || '').slice(0, 64),
  eval: b.eval === true || b.eval === 'true',
} }];
`;

// Builds the embedding requests. One item per text to embed; a single
// {skip:true} item when there is nothing to embed (so the flow still ends in
// a proper answer instead of stopping on zero items).
const PLAN_CODE = `
const req = $('Normalize Request').first().json;
const rows = $('Notebook Rows').all().map(i => i.json).filter(r => r && r.entry_key);
const settings = {};
for (const i of $('Settings Rows').all()) if (i.json && i.json.setting_key) settings[i.json.setting_key] = i.json.value;
const model = (settings.embedding_model || 'gemini-embedding-001').trim();

function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
// Each way of asking gets its OWN vector: blending them into one text blurs
// the meaning (a Bangla-script phrasing got lost next to a Banglish one).
function phrases(r) {
  return [r.customer_question, ...String(r.other_ways_to_ask || '').split(/\\s*[|\\n]\\s*/)]
    .map(s => String(s || '').trim()).filter(Boolean).slice(0, 12);
}

if (req.action === 'embed-missing') {
  const out = [];
  for (const r of rows) {
    if (r.enabled === false) continue;
    const ps = phrases(r);
    const h = hash('v2|' + model + '|' + ps.join('\\n'));
    if (!ps.length || h === (r.embedded_hash || '')) continue;
    ps.forEach((text, i) => out.push({ json: { entry_key: r.entry_key, phrase: i, text, hash: h, model } }));
  }
  if (!out.length) return [{ json: { skip: true, model } }];
  return out;
}
if (!req.text.trim()) return [{ json: { skip: true, model } }];
return [{ json: { text: req.text, model } }];
`;

const RESULT_CODE = `
const req = $('Normalize Request').first().json;
const rows = $('Notebook Rows').all().map(i => i.json).filter(r => r && r.entry_key && r.enabled !== false);
const settings = {};
for (const i of $('Settings Rows').all()) if (i.json && i.json.setting_key) settings[i.json.setting_key] = i.json.value;
const planned = $('Plan Embeddings').all().map(i => i.json);
let vectors = [];
try { vectors = $('Embed Text').all().map(i => i.json); } catch (e) { vectors = []; }
const num = (k, d) => { const n = parseFloat(settings[k]); return Number.isFinite(n) ? n : d; };

function unit(v) {
  if (!Array.isArray(v) || !v.length) return null;
  let s = 0; for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map(x => x / n);
}
function vecOf(resp) { return resp && resp.embedding && Array.isArray(resp.embedding.values) ? resp.embedding.values : null; }

// ---- embed-missing: hand the new vectors to "Save Embeddings" -------------
if (req.action === 'embed-missing') {
  if (planned[0] && planned[0].skip) return [{ json: { job: 'embed', done: true, embedded: 0, failed: 0 } }];
  // group phrase vectors back into one row; a row with ANY failed phrase is
  // left for the next run (its hash is not saved, so it is retried)
  const byKey = new Map();
  planned.forEach((p, i) => {
    const g = byKey.get(p.entry_key) || { hash: p.hash, vecs: [], bad: false };
    const v = unit(vecOf(vectors[i]));
    if (!v) g.bad = true; else g.vecs.push(v.map(x => Math.round(x * 1000) / 1000));
    byKey.set(p.entry_key, g);
  });
  const out = [];
  let failed = 0;
  for (const [entry_key, g] of byKey) {
    if (g.bad || !g.vecs.length) { failed++; continue; }
    out.push({ json: { job: 'embed', entry_key, embedding: JSON.stringify(g.vecs), embedded_hash: g.hash } });
  }
  if (!out.length) return [{ json: { job: 'embed', done: true, embedded: 0, failed } }];
  out[0].json.failed = failed;
  return out;
}

// ---- match / pre-reply -----------------------------------------------------
const q = (!planned[0] || planned[0].skip) ? null : unit(vecOf(vectors[0]));
const k = Math.max(0, Math.min(10, Math.round(num('examples_per_reply', 5))));
const minSim = num('min_similarity', 0.80);

const scored = [];
if (q) {
  for (const r of rows) {
    let vs = null;
    try { vs = r.embedding ? JSON.parse(r.embedding) : null; } catch (e) { vs = null; }
    if (!Array.isArray(vs)) continue;
    if (typeof vs[0] === 'number') vs = [vs];
    let best = -1;
    for (const v of vs) {
      if (!Array.isArray(v) || v.length !== q.length) continue;
      let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * q[i];
      if (s > best) best = s;
    }
    if (best > -1) scored.push({ r, sim: Math.round(best * 1000) / 1000 });
  }
  scored.sort((a, b) => b.sim - a.sim);
}
// keep only examples close to the best one: unrelated rows sit ~0.80-0.87 for
// almost any message, so a fixed floor alone lets noise in next to a 0.96 hit
const margin = num('relative_margin', 0.06);
const floor = scored.length ? Math.max(minSim, scored[0].sim - margin) : minSim;
const examples = scored.filter(x => x.sim >= floor).slice(0, k);
const golden = rows.filter(r => r.golden_rule && r.lesson);

const lines = [];
// Whether example 1 is the same question (high score and clearly ahead of the
// runner-up) - only decides how plainly the guidance tells the model to answer
// it ITSELF instead of calling a specialist. The notebook never supplies the
// reply text: examples show the decision and tone, the model writes the words.
let strong = false;
if (golden.length || examples.length) {
  lines.push('STAFF NOTEBOOK — how Perfecto\\'s support staff handle questions like this. This OVERRIDES your own general knowledge and any product search. These are EXAMPLES of the decision and tone, NOT text to paste: always write your own reply in your own words, in the customer\\'s language.');
  if (golden.length) {
    lines.push('Golden rules (always apply):');
    for (const r of golden) lines.push('- ' + r.lesson);
  }
  lines.push('ADDRESS: never default to "ম্যাম"/"mam". When the customer\\'s gender is unknown, write "স্যার/ম্যাম" in Bengali or "Sir/Ma\\'am" in English. If CUSTOMER PROFILE shows Gender (or the customer said it), use স্যার/Sir for a man and ম্যাম/Ma\\'am for a woman. The staff examples below say ম্যাম as staff shorthand — adapt it, never copy it blindly.');
  if (examples.length) {
    lines.push('');
    lines.push('Past customer questions most similar in meaning to this message, with how staff answered. Follow the SAME decision (e.g. if staff suggested no product, suggest no product, show no product cards, write META_PROFILE_ASK: [] and never ask about budget) and keep the same FACTS exact (numbers, links, policy) — but write the reply yourself; do not paste the staff text.');
    examples.forEach((x, i) => {
      const r = x.r;
      lines.push('');
      lines.push((i + 1) + '. Customer: ' + r.customer_question);
      lines.push('   Staff answer: ' + String(r.staff_answer || '').replace(/\\n/g, '\\n   '));
      if (r.lesson) lines.push('   Lesson: ' + r.lesson);
    });
    lines.push('');
    // A clear winner (high score AND well ahead of the runner-up) is the same
    // question asked another way. Live 2026-11-01 the model still handed
    // "bkash number" to support_specialist, whose older policy text has no
    // bKash number — so say plainly: answer it yourself, no tool.
    const top = examples[0], second = scored[1];
    const strongAt = num('strong_match', 0.87);
    strong = !!top && top.sim >= strongAt && (!second || top.sim - second.sim >= 0.03);
    if (strong) {
      lines.push('STRONG MATCH: example 1 is the same question as this message. Answer it yourself in your own words, following that example\\'s decision and facts — do NOT call support_specialist, product_discovery or any other tool for it.');
    } else {
      lines.push('If none of these examples really fits the message, ignore them and answer normally — but the golden rules still apply.');
    }
  }
}
const guidance = lines.join('\\n');
// staff_answer + lesson travel too: agent-chat uses them only to repair a
// leaked guidance header deterministically (prod 2026-11-03 exec 5542). They
// are internal guidance, never a canned reply.
const matches = examples.map(x => ({
  entry_key: x.r.entry_key,
  similarity: x.sim,
  customer_question: x.r.customer_question,
  copy_exactly: !!x.r.copy_exactly,
  staff_answer: String(x.r.staff_answer || ''),
  lesson: String(x.r.lesson || ''),
}));
const nearMisses = scored.filter(x => x.sim < minSim).slice(0, 3).map(x => ({ entry_key: x.r.entry_key, similarity: x.sim }));

const base = { job: req.action, guidance, matches, near_misses: nearMisses, golden_count: golden.length, embedded: !!q };
if (req.action !== 'pre-reply') return [{ json: base }];

// ---- daily limit -----------------------------------------------------------
const tz = settings.limit_timezone || 'Asia/Dhaka';
let day;
try { day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
catch (e) { day = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10); }
const limit = Math.max(0, Math.round(num('daily_limit', 20)));
const ipLimit = limit * Math.max(1, num('ip_limit_multiplier', 3));
const usage = {};
for (const i of $('Usage Today').all()) if (i.json && i.json.user_key) usage[i.json.user_key] = Number(i.json.count) || 0;
const userKey = req.user_key ? 'u:' + req.user_key : '';
const ipKey = req.ip ? 'ip:' + req.ip : '';
const userCount = userKey ? (usage[userKey] || 0) : 0;
const ipCount = ipKey ? (usage[ipKey] || 0) : 0;

// staff test runs (perfecto-ai-ops auto-test) and eval-harness runs are never limited or counted
const exempt = req.eval || /^ops-test-/.test(req.user_key) || !userKey;
const over = !exempt && limit > 0 && (userCount >= limit || (ipKey && ipCount >= ipLimit));
const top = scored[0];
const freeFact = !!(top && top.sim >= Math.max(minSim, 0.88) && top.r.free_past_limit);
const allowed = !over || freeFact;
const counted = !exempt && allowed && !(over && freeFact);

const counters = [];
if (userKey) counters.push({ user_key: userKey, day, count: userCount + (counted ? 1 : 0) });
if (ipKey) counters.push({ user_key: ipKey, day, count: ipCount + (counted ? 1 : 0) });

return [{ json: {
  ...base,
  allowed,
  counted,
  limit,
  used_today: userCount + (counted ? 1 : 0),
  remaining: (limit > 0 && !exempt) ? Math.max(0, limit - userCount - (counted ? 1 : 0)) : null,
  limit_reply_bn: settings.limit_reply_bn || '',
  limit_reply_en: settings.limit_reply_en || '',
  day,
  counters,
} }];
`;

// fan the counters out so the upsert node writes one row per key
const COUNTER_ITEMS_CODE = `
const d = $input.first().json;
const items = (d.counters || []).map(c => ({ json: c }));
return items.length ? items : [{ json: { user_key: '__none__', day: d.day || '', count: 0 } }];
`;

const ANSWER_CODE = `
const d = { ...$('Notebook Result').first().json };
delete d.counters;
return [{ json: d }];
`;

const EMBED_SUMMARY_CODE = `
const saved = $('Notebook Result').all().map(i => i.json).filter(j => j.entry_key);
const failed = ($('Notebook Result').first().json.failed) || 0;
return [{ json: { job: 'embed', done: true, embedded: saved.length, failed, keys: saved.map(j => j.entry_key) } }];
`;

// ---- nodes ----------------------------------------------------------------------

const nodes = [];
const c = {};
const link = (from, to, out = 0, inIdx = 0) => {
  c[from] ||= { main: [] };
  while (c[from].main.length <= out) c[from].main.push([]);
  c[from].main[out].push({ node: to, type: 'main', index: inIdx });
};

nodes.push(node({
  name: 'Webhook',
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  position: [0, -120],
  webhookId: WEBHOOK_ID,
  parameters: { httpMethod: 'POST', path: 'notebook-tools', authentication: 'jwtAuth', responseMode: 'lastNode', responseData: 'firstEntryJson', options: {} },
  credentials: { jwtAuth: WEBHOOK_JWT_CRED },
}));
nodes.push(node({
  name: 'When Called By Chat',
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  typeVersion: 1.1,
  position: [0, 120],
  parameters: { inputSource: 'passthrough' },
}));
nodes.push(node({
  name: 'Normalize Request',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [220, 0],
  parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: NORMALIZE_CODE },
}));
nodes.push(node({
  name: 'Notebook Rows',
  type: 'n8n-nodes-base.dataTable',
  typeVersion: 1.1,
  position: [440, 0],
  executeOnce: true,
  alwaysOutputData: true,
  onError: 'continueRegularOutput',
  parameters: { resource: 'row', operation: 'get', dataTableId: table('support_notebook'), returnAll: true },
}));
nodes.push(node({
  name: 'Settings Rows',
  type: 'n8n-nodes-base.dataTable',
  typeVersion: 1.1,
  position: [660, 0],
  executeOnce: true,
  alwaysOutputData: true,
  onError: 'continueRegularOutput',
  parameters: { resource: 'row', operation: 'get', dataTableId: table('bot_settings'), returnAll: true },
}));
nodes.push(node({
  name: 'Usage Today',
  type: 'n8n-nodes-base.dataTable',
  typeVersion: 1.1,
  position: [880, 0],
  executeOnce: true,
  alwaysOutputData: true,
  onError: 'continueRegularOutput',
  parameters: {
    resource: 'row',
    operation: 'get',
    dataTableId: table('daily_usage'),
    matchType: 'anyCondition',
    filters: { conditions: [
      { keyName: 'user_key', condition: 'eq', keyValue: "={{ 'u:' + ($('Normalize Request').first().json.user_key || '-') }}" },
      { keyName: 'user_key', condition: 'eq', keyValue: "={{ 'ip:' + ($('Normalize Request').first().json.ip || '-') }}" },
    ] },
    returnAll: true,
  },
}));
nodes.push(node({
  name: 'Plan Embeddings',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [1100, 0],
  parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: PLAN_CODE },
}));
nodes.push(node({
  name: 'Needs Embedding?',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.3,
  position: [1320, 0],
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 3 },
      combinator: 'and',
      conditions: [{ id: 'skip', leftValue: '={{ $json.skip === true }}', rightValue: '', operator: { type: 'boolean', operation: 'false', singleValue: true } }],
    },
    options: {},
  },
}));
nodes.push(node({
  name: 'Embed Text',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [1540, -120],
  // one quiet retry: the embedding API occasionally drops a call, and a miss
  // here means this message gets no staff examples (still answered, just weaker)
  retryOnFail: true,
  maxTries: 2,
  waitBetweenTries: 300,
  onError: 'continueRegularOutput',
  parameters: {
    method: 'POST',
    url: '=https://generativelanguage.googleapis.com/v1beta/models/{{ $json.model }}:embedContent',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'googlePalmApi',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ content: { parts: [{ text: $json.text }] }, taskType: "SEMANTIC_SIMILARITY", outputDimensionality: 768 }) }}',
    options: { timeout: 8000, batching: { batch: { batchSize: 20, batchInterval: 200 } } },
  },
  credentials: { googlePalmApi: EMBED_CRED },
}));
nodes.push(node({
  name: 'Notebook Result',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [1760, 0],
  parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: RESULT_CODE },
}));
nodes.push(node({
  name: 'Which Job?',
  type: 'n8n-nodes-base.switch',
  typeVersion: 3.2,
  position: [1980, 0],
  parameters: {
    rules: { values: [
      { outputKey: 'embed', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and', conditions: [{ leftValue: '={{ $json.job }}', rightValue: 'embed', operator: { type: 'string', operation: 'equals' } }] }, renameOutput: true },
      { outputKey: 'pre-reply', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, combinator: 'and', conditions: [{ leftValue: '={{ $json.job }}', rightValue: 'pre-reply', operator: { type: 'string', operation: 'equals' } }] }, renameOutput: true },
    ] },
    options: { fallbackOutput: 'extra', renameFallbackOutput: 'match' },
  },
}));
// embed branch
nodes.push(node({
  name: 'Has Vectors?',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.3,
  position: [2200, -200],
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 3 },
      combinator: 'and',
      conditions: [{ id: 'has', leftValue: '={{ !!$json.entry_key }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    },
    options: {},
  },
}));
nodes.push(node({
  name: 'Save Embeddings',
  type: 'n8n-nodes-base.dataTable',
  typeVersion: 1.1,
  position: [2420, -260],
  parameters: {
    resource: 'row',
    operation: 'update',
    dataTableId: table('support_notebook'),
    matchType: 'allConditions',
    filters: { conditions: [{ keyName: 'entry_key', condition: 'eq', keyValue: '={{ $json.entry_key }}' }] },
    columns: { mappingMode: 'defineBelow', value: { embedding: '={{ $json.embedding }}', embedded_hash: '={{ $json.embedded_hash }}' }, matchingColumns: [], schema: [
      { id: 'embedding', displayName: 'embedding', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
      { id: 'embedded_hash', displayName: 'embedded_hash', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
    ] },
    options: {},
  },
}));
nodes.push(node({
  name: 'Embed Summary',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [2640, -260],
  parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: EMBED_SUMMARY_CODE },
}));
// pre-reply branch
nodes.push(node({
  name: 'Counter Items',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [2200, 0],
  parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: COUNTER_ITEMS_CODE },
}));
nodes.push(node({
  name: 'Count Message',
  type: 'n8n-nodes-base.dataTable',
  typeVersion: 1.1,
  position: [2420, 0],
  onError: 'continueRegularOutput',
  parameters: {
    resource: 'row',
    operation: 'upsert',
    dataTableId: table('daily_usage'),
    matchType: 'allConditions',
    filters: { conditions: [
      { keyName: 'user_key', condition: 'eq', keyValue: '={{ $json.user_key }}' },
      { keyName: 'day', condition: 'eq', keyValue: '={{ $json.day }}' },
    ] },
    columns: { mappingMode: 'defineBelow', value: { user_key: '={{ $json.user_key }}', day: '={{ $json.day }}', count: '={{ $json.count }}' }, matchingColumns: [], schema: [
      { id: 'user_key', displayName: 'user_key', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
      { id: 'day', displayName: 'day', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
      { id: 'count', displayName: 'count', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: true },
    ] },
    options: {},
  },
}));
nodes.push(node({
  name: 'Pre-reply Answer',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [2640, 0],
  parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: ANSWER_CODE },
}));
// match branch
nodes.push(node({
  name: 'Match Answer',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [2200, 200],
  parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: ANSWER_CODE },
}));

link('Webhook', 'Normalize Request');
link('When Called By Chat', 'Normalize Request');
link('Normalize Request', 'Notebook Rows');
link('Notebook Rows', 'Settings Rows');
link('Settings Rows', 'Usage Today');
link('Usage Today', 'Plan Embeddings');
link('Plan Embeddings', 'Needs Embedding?');
link('Needs Embedding?', 'Embed Text', 0);
link('Needs Embedding?', 'Notebook Result', 1);
link('Embed Text', 'Notebook Result');
link('Notebook Result', 'Which Job?');
link('Which Job?', 'Has Vectors?', 0);
link('Which Job?', 'Counter Items', 1);
link('Which Job?', 'Match Answer', 2);
link('Has Vectors?', 'Save Embeddings', 0);
link('Has Vectors?', 'Embed Summary', 1);
link('Save Embeddings', 'Embed Summary');
link('Counter Items', 'Count Message');
link('Count Message', 'Pre-reply Answer');

// Embed Summary runs once per input; "Has Vectors?" false + Save path both
// feed it, which is fine because only one of them carries items per run.
const wf = { name: 'notebook-tools', nodes, connections: c, settings: { executionOrder: 'v1' } };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/notebookTools.json`, JSON.stringify(wf, null, 2));
console.log('built notebookTools.json');
