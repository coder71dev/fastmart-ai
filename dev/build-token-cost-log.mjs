// Builds the "token-cost-log" workflow — a running, real log of actual
// Gemini/Command Code token usage and cost for every real customer turn.
//
// WHY THIS EXISTS, NOT AN IN-WORKFLOW Set/Code NODE: build-main.mjs's own
// RESPONSE_CODE already documents (and this was re-confirmed live
// 2026-10-22) that the AI Agent node's own output is just
// {output, intermediateSteps} — it never emits tokenUsage, and n8n's data
// proxy cannot reach the ai_languageModel sub-node where the real per-call
// usage lives: every accessor ($('Gemini Model'), $node[...], .all()/.first())
// throws "No data found from main input". There is no in-workflow fix on
// this n8n version.
//
// So this reads it back OUT-OF-BAND instead, the same way dev/prod-bench.mjs
// already does from a shell script — except this runs as its own recurring
// n8n workflow instead of something a human has to remember to run. It
// queries n8n's OWN execution_entity/execution_data tables directly, which
// live in the SAME database the "fastmart Postgres (fastmart_ai DB)"
// credential already points at (confirmed live 2026-10-19 in
// quality-eval-schema.sql's own header — that credential's real database is
// fastmart_n8n, the name is just a friendly label). No new credential
// needed.
//
// Covers the orchestrator (agent-chat) AND all 4 specialist sub-workflows —
// each specialist call is its OWN n8n execution with its OWN Gemini call,
// easy to miss if you only look at the orchestrator (found live 2026-10-22:
// a single "add to cart" turn's real cost was the orchestrator's 7,297
// tokens PLUS another 2,714 tokens from the product_discovery specialist it
// called, in a completely separate execution record).
//
// Cache credit: Google's implicit prompt cache only shows up on a
// tool-calling turn's FIRST call, inside that call's own
// intermediateSteps[0].action.messageLog[0].kwargs.usage_metadata
// .input_token_details.cache_read — and only when it actually hit (not
// guaranteed, see memory/project_gemini_cache_not_recoverable.md). Logged
// as cached_tokens when present, left null otherwise; never guessed.
//
// Pricing: only gemini-3.5-flash-lite's real published rate is known
// (ai.google.dev/gemini-api/docs/pricing, checked 2026-10-22). A turn that
// ran on Command Code/DeepSeek logs real token counts but cost_usd stays
// null rather than guessing a rate that was never confirmed.
//
// First-time setup (once per instance):
//   node dev/build-token-cost-log.mjs && ALLOW_NEW_WORKFLOW=1 node dev/deploy.mjs dev/out/tokenCostLog.json
//   (drop ALLOW_NEW_WORKFLOW=1 for later redeploys — same pattern as quality-eval)
// The workflow creates its own table on every run (CREATE TABLE IF NOT
// EXISTS, see the "Ensure Table" node below) — dev/token-cost-log-schema.sql
// is kept only as the readable reference for what that statement does, not
// a separate manual step.
//
// Standalone, like quality-eval: not part of sync.mjs's chain, reads
// execution history read-only, never touches agent-chat or the specialists.
import fs from 'node:fs';
import { stableId } from './node-id.mjs';

const OUT = 'dev/out';
let credConfig = {};
try { credConfig = JSON.parse(fs.readFileSync('.n8n-credentials.json', 'utf8')); } catch {}
const PG_CRED_NAME = process.env.PG_CRED_NAME || credConfig.PG_CRED_NAME || 'fastmart Postgres (fastmart_ai DB)';
const PG_CRED_ID = process.env.PG_CRED_ID || credConfig.PG_CRED_ID || 'EsaKbJSqeQFEMuwd';
const PG_CRED = { id: PG_CRED_ID, name: PG_CRED_NAME };

// The 5 real workflow ids this logs — agent-chat + its 4 specialists. These
// are THIS instance's real ids (resolved live 2026-10-22 via search_workflows),
// not portable literals — if this is ever deployed to a different instance,
// fold this lookup into sync.mjs's existing by-name resolution instead.
const WORKFLOW_IDS = [
  'oAlPFsGVYAlhZami', // agent-chat (prod webhook)
  'DQ39wgxL370oX15x', // specialist-product-discovery
  '1epRnYl6wTXaIxMf', // specialist-cart
  'TMlk5KZqAZB5ysy7', // specialist-orders
  '84zzrn7RoIof8lhC', // specialist-support
];

// Readable names for the Sheet (token_cost_log.workflow_name holds the id).
const WORKFLOW_NAMES = {
  oAlPFsGVYAlhZami: 'agent-chat',
  DQ39wgxL370oX15x: 'product-discovery',
  '1epRnYl6wTXaIxMf': 'cart',
  TMlk5KZqAZB5ysy7: 'orders',
  '84zzrn7RoIof8lhC': 'support',
};

// Optional Google Sheets copy of every new log row. Postgres stays the source
// of truth: the Sheet step runs AFTER Insert Log Row and only receives the rows
// that insert actually wrote (ON CONFLICT DO NOTHING returns none for a
// duplicate), so a retried batch can never double-write the Sheet. Leave
// TOKEN_SHEET_URL unset and the workflow builds exactly as before - no Sheet
// steps - so a deploy on an instance without the setting keeps logging to
// Postgres instead of failing on a blank document id.
const SHEET_URL = process.env.TOKEN_SHEET_URL || credConfig.TOKEN_SHEET_URL || '';
const SHEET_TAB = process.env.TOKEN_SHEET_TAB || credConfig.TOKEN_SHEET_TAB || 'token_cost_log';
const SHEETS_CRED = {
  id: process.env.SHEETS_CRED_ID || credConfig.SHEETS_CRED_ID || 'mHnsWMe8svjYfKaa',
  name: process.env.SHEETS_CRED_NAME || credConfig.SHEETS_CRED_NAME || 'Google Sheets account',
};

const node = (o) => ({ id: o.id || stableId(o.name), disabled: false, ...o });
const pos = (x, y) => [x, y];

const ENSURE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS token_cost_log (
  id                   SERIAL PRIMARY KEY,
  execution_id         INTEGER NOT NULL UNIQUE,
  parent_execution_id  INTEGER,
  workflow_name        TEXT NOT NULL,
  mode                 TEXT,
  status               TEXT,
  started_at           TIMESTAMPTZ,
  stopped_at           TIMESTAMPTZ,
  provider             TEXT,
  model                TEXT,
  input_tokens         INTEGER,
  cached_tokens        INTEGER,
  output_tokens        INTEGER,
  total_tokens         INTEGER,
  cost_usd             NUMERIC(10,6),
  logged_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS token_cost_log_started_at_idx ON token_cost_log (started_at);
CREATE INDEX IF NOT EXISTS token_cost_log_parent_idx ON token_cost_log (parent_execution_id);
`.trim();

const CLEANUP_SQL = `
DELETE FROM token_cost_log
 WHERE started_at IS NOT NULL AND started_at < now() - interval '30 days';
DELETE FROM token_cost_log
 WHERE started_at IS NULL AND logged_at < now() - interval '30 days';
`.trim();

const READ_SQL = `
SELECT e.id, e.mode, e."workflowId", e.status, e."startedAt", e."stoppedAt", ed.data
FROM execution_entity e
JOIN execution_data ed ON ed."executionId" = e.id
WHERE e."workflowId" = ANY(ARRAY[${WORKFLOW_IDS.map((w) => `'${w}'`).join(',')}])
  AND NOT EXISTS (SELECT 1 FROM token_cost_log t WHERE t.execution_id = e.id)
ORDER BY e.id ASC
LIMIT 50
`.trim();

// Decodes n8n's execution_data.data — plain JSON, or n8n's "flatted" array
// form ([rootRef, ...pool], refs are stringified pool indices). Memoized by
// pool index (NOT the naive re-expand-every-reference version dev/prod-bench.mjs
// uses) — a real production row's references are shared across many spots
// (the same long system-prompt string referenced by several LLM calls'
// messageLog), and re-expanding each reference fresh on every occurrence
// blows up combinatorially instead of linearly. Confirmed live 2026-10-22:
// the naive version made one single execution's resolve alone exceed 16MB
// and crash this node's own batch. The memo also doubles as cycle
// protection (a reference that points back into its own expansion resolves
// to undefined instead of recursing forever).
const EXTRACT_CODE = `
const PRICING = { 'gemini-3.5-flash-lite': { in: 0.30, cached: 0.03, out: 2.50 } };
function resolve(table) {
  const memo = new Map();
  function res(v) {
    if (typeof v === 'string' && /^\\d+$/.test(v)) {
      const n = +v;
      if (n >= table.length) return v;
      if (memo.has(n)) return memo.get(n);
      memo.set(n, undefined);
      const out = res(table[n]);
      memo.set(n, out);
      return out;
    }
    if (Array.isArray(v)) return v.map(res);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) o[res(k)] = res(val);
      return o;
    }
    return v;
  }
  return res(table[0]);
}
const out = [];
for (const item of $input.all()) {
  const row = item.json;
  let root;
  try {
    const parsed = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    root = Array.isArray(parsed) ? resolve(parsed) : parsed;
  } catch (err) {
    continue; // unparseable or pathological this run - not inserted, so the next run retries it
  }
  try {
    const runData = (root && root.resultData && root.resultData.runData) || {};
    const agentRuns = runData['AI Agent'] || [];
    let inTok = 0, outTok = 0, cachedTok = null;
    for (const run of agentRuns) {
      const t = run && run.metadata && run.metadata.tracing;
      if (t) { inTok += Number(t['llm.tokens.in']) || 0; outTok += Number(t['llm.tokens.out']) || 0; }
    }
    let provider = 'unknown', model = null;
    if (runData['Gemini Model']) { provider = 'gemini'; model = ($env.GEMINI_MODEL_LABEL || 'gemini-3.5-flash-lite'); }
    else if (runData['Google Gemini Chat Model']) { provider = 'gemini'; model = 'gemini (legacy node)'; }
    else if (runData['OpenAI Chat Model']) { provider = 'commandcode'; model = 'deepseek-v4.1-flash'; }
    try {
      const steps = agentRuns[0] && agentRuns[0].data && agentRuns[0].data.main && agentRuns[0].data.main[0] && agentRuns[0].data.main[0][0] && agentRuns[0].data.main[0][0].json && agentRuns[0].data.main[0][0].json.intermediateSteps;
      const um = steps && steps[0] && steps[0].action && steps[0].action.messageLog && steps[0].action.messageLog[0] && steps[0].action.messageLog[0].kwargs && steps[0].action.messageLog[0].kwargs.usage_metadata;
      if (um && um.input_token_details && um.input_token_details.cache_read != null) cachedTok = Number(um.input_token_details.cache_read);
    } catch (err) {}
    const totalTok = inTok + outTok;
    let cost = null;
    const p = PRICING[model];
    if (p) {
      const cached = cachedTok || 0;
      const fresh = Math.max(inTok - cached, 0);
      cost = (fresh / 1e6) * p.in + (cached / 1e6) * p.cached + (outTok / 1e6) * p.out;
    }
    out.push({ json: {
      execution_id: row.id,
      parent_execution_id: (root && root.parentExecution && root.parentExecution.executionId) ? Number(root.parentExecution.executionId) : null,
      workflow_name: row.workflowId,
      mode: row.mode,
      status: row.status,
      started_at: row.startedAt,
      stopped_at: row.stoppedAt,
      provider,
      model,
      input_tokens: inTok,
      cached_tokens: cachedTok,
      output_tokens: outTok,
      total_tokens: totalTok,
      cost_usd: cost,
    } });
  } catch (err) {
    continue; // this row's shape surprised the extractor - skip it, not inserted, retried next run
  }
}
return out;
`.trim();

const nodes = [];
const connections = {};

nodes.push(
  node({
    parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 30 }] } },
    name: 'Schedule Trigger',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.4,
    position: pos(0, 0),
  }),
);
nodes.push(
  node({
    // Idempotent (IF NOT EXISTS) - runs every fire so the workflow is fully
    // self-contained, no separate manual schema step on any instance.
    parameters: { operation: 'executeQuery', query: ENSURE_TABLE_SQL, options: {} },
    name: 'Ensure Table',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.7,
    position: pos(220, 0),
    credentials: { postgres: PG_CRED },
  }),
);
nodes.push(
  node({
    parameters: { operation: 'executeQuery', query: CLEANUP_SQL, options: {} },
    name: 'Cleanup Old Rows',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.7,
    position: pos(330, 0),
    credentials: { postgres: PG_CRED },
  }),
);
nodes.push(
  node({
    parameters: { operation: 'executeQuery', query: READ_SQL, options: {} },
    name: 'Read New Executions',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.7,
    position: pos(440, 0),
    credentials: { postgres: PG_CRED },
  }),
);
nodes.push(
  node({
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: EXTRACT_CODE },
    name: 'Extract Tokens + Cost',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: pos(660, 0),
  }),
);
nodes.push(
  node({
    parameters: {
      operation: 'insert',
      schema: { __rl: true, mode: 'name', value: 'public' },
      table: { __rl: true, mode: 'name', value: 'token_cost_log' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          execution_id: '={{ $json.execution_id }}',
          parent_execution_id: '={{ $json.parent_execution_id }}',
          workflow_name: '={{ $json.workflow_name }}',
          mode: '={{ $json.mode }}',
          status: '={{ $json.status }}',
          started_at: '={{ $json.started_at }}',
          stopped_at: '={{ $json.stopped_at }}',
          provider: '={{ $json.provider }}',
          model: '={{ $json.model }}',
          input_tokens: '={{ $json.input_tokens }}',
          cached_tokens: '={{ $json.cached_tokens }}',
          output_tokens: '={{ $json.output_tokens }}',
          total_tokens: '={{ $json.total_tokens }}',
          cost_usd: '={{ $json.cost_usd }}',
        },
      },
      options: { skipOnConflict: true },
    },
    name: 'Insert Log Row',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.7,
    position: pos(880, 0),
    credentials: { postgres: PG_CRED },
  }),
);

connections['Schedule Trigger'] = { main: [[{ node: 'Ensure Table', type: 'main', index: 0 }]] };
connections['Ensure Table'] = { main: [[{ node: 'Cleanup Old Rows', type: 'main', index: 0 }]] };
connections['Cleanup Old Rows'] = { main: [[{ node: 'Read New Executions', type: 'main', index: 0 }]] };
connections['Read New Executions'] = { main: [[{ node: 'Extract Tokens + Cost', type: 'main', index: 0 }]] };
connections['Extract Tokens + Cost'] = { main: [[{ node: 'Insert Log Row', type: 'main', index: 0 }]] };

// One row per newly logged execution, in the column order the Sheet shows.
// Times in Dhaka so they read naturally; cost rounded for a spreadsheet.
const SHEET_ROW_CODE = `
const NAMES = ${JSON.stringify(WORKFLOW_NAMES)};
const fmt = (v) => {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d).replace(',', '');
};
return $input.all().map((i) => {
  const j = i.json || {};
  return { json: {
    'Started (Dhaka)': fmt(j.started_at),
    'Workflow': NAMES[j.workflow_name] || String(j.workflow_name || ''),
    'Status': j.status || '',
    'Mode': j.mode || '',
    'Provider': j.provider || '',
    'Model': j.model || '',
    'Input tokens': Number(j.input_tokens) || 0,
    'Cached tokens': j.cached_tokens == null ? '' : Number(j.cached_tokens),
    'Output tokens': Number(j.output_tokens) || 0,
    'Total tokens': Number(j.total_tokens) || 0,
    'Cost (USD)': j.cost_usd == null ? '' : Math.round(Number(j.cost_usd) * 1e6) / 1e6,
    'Execution ID': Number(j.execution_id) || '',
    'Parent execution ID': j.parent_execution_id == null ? '' : Number(j.parent_execution_id),
  } };
});
`.trim();
const SHEET_COLUMNS = ['Started (Dhaka)', 'Workflow', 'Status', 'Mode', 'Provider', 'Model', 'Input tokens', 'Cached tokens', 'Output tokens', 'Total tokens', 'Cost (USD)', 'Execution ID', 'Parent execution ID'];

if (SHEET_URL) {
  nodes.push(
    node({
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: SHEET_ROW_CODE },
      name: 'Shape Sheet Row',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: pos(1100, 0),
    }),
  );
  nodes.push(
    node({
      parameters: {
        resource: 'sheet',
        operation: 'append',
        authentication: 'oAuth2',
        documentId: { __rl: true, mode: 'url', value: SHEET_URL },
        sheetName: { __rl: true, mode: 'name', value: SHEET_TAB },
        columns: {
          mappingMode: 'autoMapInputData',
          value: {},
          schema: SHEET_COLUMNS.map((c) => ({ id: c, displayName: c, required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: false })),
        },
        options: { cellFormat: 'USER_ENTERED', handlingExtraData: 'ignoreIt' },
      },
      name: 'Append To Sheet',
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.7,
      position: pos(1320, 0),
      credentials: { googleSheetsOAuth2Api: SHEETS_CRED },
    }),
  );
  connections['Insert Log Row'] = { main: [[{ node: 'Shape Sheet Row', type: 'main', index: 0 }]] };
  connections['Shape Sheet Row'] = { main: [[{ node: 'Append To Sheet', type: 'main', index: 0 }]] };
}

const wf = {
  name: 'token-cost-log',
  nodes,
  connections,
  settings: { executionOrder: 'v1' },
};
fs.writeFileSync(`${OUT}/tokenCostLog.json`, JSON.stringify(wf, null, 2));
console.log('built tokenCostLog.json');
console.log('pg cred:', PG_CRED.name, `(${PG_CRED.id})`);
console.log('tracking workflows:', WORKFLOW_IDS.join(', '));
console.log(SHEET_URL
  ? `google sheet: ${SHEET_URL} tab "${SHEET_TAB}" via ${SHEETS_CRED.name} (${SHEETS_CRED.id})`
  : 'google sheet: OFF - set TOKEN_SHEET_URL (env or .n8n-credentials.json) to also append each row to a Sheet');
