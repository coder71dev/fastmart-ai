// Builds the token-usage collector → dev/out/tokenCollector.json
//
// Why a collector at all: n8n records the real per-call usage on the model
// node's `ai_languageModel` connection, but that data is UNREACHABLE from
// inside the run. Verified against n8n 2.40.5 with a throwaway probe workflow —
// from the node after the agent, every accessor fails:
//     $('OpenAI Chat Model').first().json   -> No data found from `main` input
//     $('OpenAI Chat Model').all()          -> No data found from `main` input
//     $items('OpenAI Chat Model')           -> No data found from `main` input
//     $node['OpenAI Chat Model'].json       -> No data found from `main` input
//   and the Agent output is only { output, intermediateSteps } — no tokenUsage.
// (`$('OpenAI Chat Model').isExecuted` is true, so the node ran; its data simply
// is not served on the `main` connection.)
//
// So the rows are written out-of-band: this workflow reads n8n's OWN Postgres
// (execution_entity + execution_data), decodes the flatted run data, and inserts
// one row per LLM call into the `token_usage` Data Table.
//
//   node dev/build-collector.mjs && node dev/deploy.mjs dev/out/tokenCollector.json
//
// Env overrides: METRICS_CRED_ID, TOKEN_TABLE, COLLECT_LIMIT, COLLECT_MINUTES.
import fs from 'node:fs';

const OUT = 'dev/out';
fs.mkdirSync(OUT, { recursive: true });

const rand = () => Math.random().toString(36).slice(2, 8);
const node = (o) => ({ id: o.id || rand(), disabled: false, ...o });

// n8n's own DB (execution data) — NOT the fastmart_ai DB the PG Memory node uses.
const METRICS_CRED = {
  id: process.env.METRICS_CRED_ID || 'aDuHo9mivsM8kd9Z',
  name: 'n8n Postgres (metrics, read-only)',
};
const TABLE = process.env.TOKEN_TABLE || 'token_usage';
const LIMIT = Number(process.env.COLLECT_LIMIT || 200);
const MINUTES = Number(process.env.COLLECT_MINUTES || 5);

// One row per LLM call. Column names are also the keys the decoder emits, so the
// insert node can auto-map the input data.
const COLUMNS = [
  ['execution_id', 'number'],
  ['parent_execution_id', 'number'],
  ['conversation_id', 'string'],
  ['workflow_name', 'string'],
  ['run_mode', 'string'],
  ['node_name', 'string'],
  ['call_index', 'number'],
  ['prompt_tokens', 'number'],
  ['completion_tokens', 'number'],
  ['total_tokens', 'number'],
  ['started_at', 'date'],
];

// ---------------------------------------------------------------------------
// 1. Cursor — how far the collector has already ingested.
// ---------------------------------------------------------------------------
const CURSOR_CODE = `
const sd = $getWorkflowStaticData('global');
let lastId = Number(sd.lastId || 0) || 0;
let body = {};
try { body = $input.first().json.body || {}; } catch (e) {}
// POST {"full": true} to re-ingest the whole history (e.g. after clearing the table).
if (body.full === true || body.full === 'true' || body.full === 1) lastId = 0;
return [{ json: { lastId, limit: ${LIMIT} } }];
`;

// ---------------------------------------------------------------------------
// 2. Fetch — n8n's own execution data, oldest-first from the cursor.
// ---------------------------------------------------------------------------
const FETCH_QUERY = `SELECT e.id AS execution_id,
       e.mode AS run_mode,
       COALESCE(w.name, '') AS workflow_name,
       e."startedAt" AS started_at,
       d.data AS data
FROM execution_entity e
JOIN execution_data d ON d."executionId" = e.id
LEFT JOIN workflow_entity w ON w.id = e."workflowId"
WHERE e.id > {{ Number($('Prepare Cursor').first().json.lastId) }}
ORDER BY e.id ASC
LIMIT {{ Number($('Prepare Cursor').first().json.limit) }}`;

// ---------------------------------------------------------------------------
// 3. Decode — flatted run data -> one row per LLM call.
//    The run data is stored flatted: element 0 is the root and every object /
//    array value that repeats is replaced by a numeric string index. A full
//    recursive expansion of 200 executions deep-copies every message and
//    generation and blows the task runner's heartbeat ("Task execution aborted
//    because runner became unresponsive"), so this walks ONLY the paths it needs
//    — one dereference per hop — and never touches the message bodies.
// ---------------------------------------------------------------------------
const DECODE_CODE = `
const rows = [];
let maxId = 0;
let parsed = 0;
let skipped = 0;

for (const item of $input.all()) {
  const j = item.json || {};
  const id = Number(j.execution_id) || 0;
  if (id > maxId) maxId = id;

  let t = null;
  try { t = JSON.parse(j.data); } catch (e) { skipped++; continue; }
  if (!Array.isArray(t)) { skipped++; continue; }

  // one hop: a numeric string is an index into the flattened table
  const D = (v) => {
    if (typeof v === 'string' && /^\\d+$/.test(v)) {
      const i = +v;
      if (i < t.length) return t[i];
    }
    return v;
  };

  const root = D(t[0]);
  const resultData = root ? D(root.resultData) : null;
  const runData = (resultData ? D(resultData.runData) : null) || {};
  parsed++;

  // Which node's output to read the conversation id from (main webhook workflow
  // only; specialist sub-executions carry parent_execution_id instead).
  const branchJson = (name) => {
    const tasks = D(runData[name]);
    if (!Array.isArray(tasks) || !tasks.length) return null;
    const task = D(tasks[tasks.length - 1]);
    const data = task ? D(task.data) : null;
    const main = data ? D(data.main) : null;
    if (!Array.isArray(main) || !main.length) return null;
    const branch = D(main[0]);
    if (!Array.isArray(branch) || !branch.length) return null;
    const entry = D(branch[0]);
    return entry ? D(entry.json) : null;
  };

  let conversationId = '';
  for (const name of ['Prepare Input', 'Webhook']) {
    const json = branchJson(name);
    if (!json) continue;
    // The object's field VALUES are themselves table references, so the id has
    // to be dereferenced too — reading it raw yields a flatted index ("172").
    let cand = json.conversationId || json.userId || '';
    if (cand) cand = D(cand);
    if (!cand && json.body) {
      const body = D(json.body);
      if (body && body.conversation_id) cand = D(body.conversation_id);
    }
    if (typeof cand === 'string' && cand) { conversationId = cand; break; }
  }

  // Same one-hop problem as the conversation id: the value inside
  // parentExecution is itself a table reference ("14"), not the id.
  const parentRef = root ? D(root.parentExecution) : null;
  let parentId = 0;
  if (parentRef) {
    const rawParent = parentRef.executionId !== undefined ? parentRef.executionId : parentRef;
    parentId = Number(D(rawParent)) || 0;
  }
  let callIndex = 0;

  for (const [nodeName, tasksRef] of Object.entries(runData)) {
    const tasks = D(tasksRef);
    if (!Array.isArray(tasks)) continue;
    for (const taskRef of tasks) {
      const task = D(taskRef);
      const data = task ? D(task.data) : null;
      const runs = data ? D(data.ai_languageModel) : null;
      if (!Array.isArray(runs)) continue;
      for (const runRef of runs) {
        const run = D(runRef);
        for (const entryRef of (Array.isArray(run) ? run : [run])) {
          const entry = D(entryRef);
          const entryJson = entry ? D(entry.json) : null;
          const tu = entryJson ? D(entryJson.tokenUsage) : null;
          if (!tu) continue;
          const prompt = Number(tu.promptTokens) || 0;
          const completion = Number(tu.completionTokens) || 0;
          callIndex++;
          rows.push({
            execution_id: id,
            parent_execution_id: parentId,
            conversation_id: conversationId,
            workflow_name: String(j.workflow_name || ''),
            run_mode: String(j.run_mode || ''),
            node_name: String(nodeName),
            call_index: callIndex,
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: Number(tu.totalTokens) || (prompt + completion),
            started_at: j.started_at || null,
          });
        }
      }
    }
  }
}

// Advance the cursor even when this batch produced no LLM rows, otherwise a run
// of non-AI executions would stall the collector on the same ids forever.
const sd = $getWorkflowStaticData('global');
if (maxId > (Number(sd.lastId) || 0)) sd.lastId = maxId;

// Always emit at least one item. n8n skips a node that receives no items, so an
// idle batch (nothing new to ingest) used to end the run with zero items — and
// the webhook's lastNode response then failed with "No item to return was
// found", which left the execution unfinalised in a stuck running state.
if (!rows.length) {
  return [{ json: { __no_calls: true, scanned: $input.all().length, upTo: maxId } }];
}
return rows.map((json) => ({ json, pairedItem: { item: 0 } }));
`;

// Terminal node. Always reached — from the If's true branch when the batch was
// idle, or from Insert Rows when there was something to write — so the webhook
// always has an item to respond with.
const REPORT_CODE = `
const items = $input.all().map((i) => i.json);
const idle = items.find((j) => j && j.__no_calls === true);
if (idle) {
  return [{ json: { ingested: 0, scanned: idle.scanned ?? 0, cursor: idle.upTo ?? 0, note: 'nothing new to ingest' } }];
}
const tokens = items.reduce((a, j) => a + (Number(j && j.total_tokens) || 0), 0);
return [{ json: { ingested: items.length, tokens } }];
`;

const nodes = [];
const connections = {};

// --- triggers ---
nodes.push(
  node({
    parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: MINUTES }] } },
    name: 'Collect Schedule',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [0, -120],
  }),
);
nodes.push(
  node({
    parameters: { httpMethod: 'POST', path: 'metrics/collect-tokens', responseMode: 'lastNode', options: {} },
    name: 'Collect Webhook',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [0, 80],
    webhookId: 'token-collect-0000-0000-0000-000000000001',
  }),
);

// --- pipeline ---
nodes.push(
  node({
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: CURSOR_CODE },
    name: 'Prepare Cursor',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [220, 0],
  }),
);
nodes.push(
  node({
    parameters: {
      resource: 'table',
      operation: 'create',
      tableName: TABLE,
      columns: { column: COLUMNS.map(([name, type]) => ({ name, type })) },
      options: { createIfNotExists: true },
    },
    name: 'Ensure Table',
    type: 'n8n-nodes-base.dataTable',
    typeVersion: 1.1,
    position: [440, 0],
    executeOnce: true,
  }),
);
nodes.push(
  node({
    parameters: {
      operation: 'executeQuery',
      query: FETCH_QUERY,
      options: {},
    },
    name: 'Fetch Runs',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.7,
    position: [660, 0],
    credentials: { postgres: METRICS_CRED },
  }),
);
nodes.push(
  node({
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: DECODE_CODE },
    name: 'Decode Calls',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [880, 0],
  }),
);
nodes.push(
  node({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'idle-batch',
            leftValue: '={{ $json.__no_calls ? 1 : 0 }}',
            rightValue: 1,
            operator: { type: 'number', operation: 'equals' },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    name: 'Idle Batch?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [1100, 0],
  }),
);
nodes.push(
  node({
    parameters: {
      resource: 'row',
      operation: 'insert',
      dataTableId: { mode: 'id', value: "={{ $('Ensure Table').first().json.id }}" },
      columns: { mappingMode: 'autoMapInputData', value: null },
      options: {},
    },
    name: 'Insert Rows',
    type: 'n8n-nodes-base.dataTable',
    typeVersion: 1.1,
    position: [1320, 140],
  }),
);
nodes.push(
  node({
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: REPORT_CODE },
    name: 'Report',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1540, 0],
  }),
);

connections['Collect Schedule'] = { main: [[{ node: 'Prepare Cursor', type: 'main', index: 0 }]] };
connections['Collect Webhook'] = { main: [[{ node: 'Prepare Cursor', type: 'main', index: 0 }]] };
connections['Prepare Cursor'] = { main: [[{ node: 'Ensure Table', type: 'main', index: 0 }]] };
connections['Ensure Table'] = { main: [[{ node: 'Fetch Runs', type: 'main', index: 0 }]] };
connections['Fetch Runs'] = { main: [[{ node: 'Decode Calls', type: 'main', index: 0 }]] };
connections['Decode Calls'] = { main: [[{ node: 'Idle Batch?', type: 'main', index: 0 }]] };
// true = idle batch (no rows to write) -> straight to the report
// false = real rows -> insert, then report
connections['Idle Batch?'] = {
  main: [
    [{ node: 'Report', type: 'main', index: 0 }],
    [{ node: 'Insert Rows', type: 'main', index: 0 }],
  ],
};
connections['Insert Rows'] = { main: [[{ node: 'Report', type: 'main', index: 0 }]] };

const wf = {
  name: 'token-usage collector',
  nodes,
  connections,
  settings: {
    executionOrder: 'v1',
    // Successful runs ARE saved. An earlier version set
    // saveDataSuccessExecution:'none' to avoid re-storing the run data it reads
    // — but that also made every working run invisible in the executions list
    // (a real gap looked identical to a stalled collector), and n8n never
    // finalises such an execution, so its row sat in `running` forever with
    // finished=false.
    //
    // Set EXPLICITLY, not by omission: n8n merges workflow settings on update,
    // so dropping a key from this object leaves the old stored value in place.
    // Verified — the built JSON had no saveDataSuccessExecution while the DB
    // still reported 'none'.
    saveDataSuccessExecution: 'all',
    saveDataErrorExecution: 'all',
  },
};
fs.writeFileSync(`${OUT}/tokenCollector.json`, JSON.stringify(wf, null, 2));
console.log(`built tokenCollector.json — table=${TABLE} every ${MINUTES}min, batch ${LIMIT}, cred=${METRICS_CRED.id}`);
