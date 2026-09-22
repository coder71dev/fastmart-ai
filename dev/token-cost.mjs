// token-cost.mjs — renders the `token_usage` n8n Data Table as a single-file
// datatable with a totals footer.
//
//   node dev/token-cost.mjs                 -> writes token-cost.html
//   node dev/token-cost.mjs --out x.html
//
// The rows are produced by the `token-usage collector` workflow (built by
// dev/build-collector.mjs), which decodes n8n's own execution data and inserts
// one row per LLM call. This script only reads them back and renders.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]?.startsWith('--') ? true : (arr[i + 1] ?? true)] : null)).filter(Boolean),
);
const OUT = String(ARGS.out || 'token-cost.html');
const TABLE_NAME = String(ARGS.table || 'token_usage');
const DB = String(ARGS.db || 'fastmart_n8n');
const PG_CONTAINER = String(ARGS.container || 'fastmart-n8n-postgres');

function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'n8n', '-d', DB, '-t', '-A', '-F', '\u0001'], {
    encoding: 'utf8',
    input: sql,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || '') + (r.stdout || '')}`.slice(0, 400));
  return r.stdout.split('\n').filter((l) => l).map((l) => l.split('\u0001'));
}

// Resolve the physical table by NAME so a recreated Data Table (new id) still works.
const found = psql(`SELECT id FROM data_table WHERE name = '${TABLE_NAME}'`);
if (!found.length) {
  throw new Error(`no n8n Data Table named "${TABLE_NAME}" — run the collector first (node dev/build-collector.mjs && node dev/deploy.mjs dev/out/tokenCollector.json)`);
}
const tableId = found[0][0];
const physical = `data_table_user_${tableId}`;

const rows = psql(`
  SELECT execution_id, parent_execution_id, coalesce(conversation_id,''), workflow_name,
         run_mode, node_name, call_index, prompt_tokens, completion_tokens, total_tokens,
         coalesce(to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '')
  FROM "${physical}"
  ORDER BY started_at DESC NULLS LAST, execution_id DESC, call_index ASC
`).map((r) => ({
  exec: Number(r[0]),
  parent: Number(r[1]) || 0,
  conv: r[2],
  workflow: r[3],
  mode: r[4],
  node: r[5],
  call: Number(r[6]),
  pin: Number(r[7]),
  pout: Number(r[8]),
  tot: Number(r[9]),
  at: r[10],
}));

// A specialist sub-execution has no conversation of its own — inherit the one
// from the parent execution so every row is attributable to a shopper.
const convByExec = new Map();
for (const r of rows) if (r.conv) convByExec.set(r.exec, r.conv);
for (const r of rows) if (!r.conv && r.parent) r.conv = convByExec.get(r.parent) || '';

const totals = rows.reduce(
  (a, r) => ({ pin: a.pin + r.pin, pout: a.pout + r.pout, tot: a.tot + r.tot }),
  { pin: 0, pout: 0, tot: 0 },
);
const conversations = new Set(rows.map((r) => r.conv).filter(Boolean)).size;

const fmt = (n) => Number(n).toLocaleString('en-US');
const html = `<!doctype html>
<html lang="en" class="h-full">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Token cost — ${TABLE_NAME}</title>
<script src="https://cdn.tailwindcss.com"></script>
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
<style> [x-cloak]{display:none!important} </style>
</head>
<body class="h-full bg-slate-100 text-slate-800 antialiased">
<div class="mx-auto max-w-[1200px] px-4 py-8" x-data="tokenTable()" x-cloak>

  <header class="mb-6">
    <h1 class="text-2xl font-semibold tracking-tight">Token cost — every LLM call</h1>
    <p class="mt-1 text-sm text-slate-500">
      Source: n8n Data Table <code class="rounded bg-slate-200 px-1 py-0.5 text-xs">${TABLE_NAME}</code>
      (${physical}), filled by the <code class="rounded bg-slate-200 px-1 py-0.5 text-xs">token-usage collector</code> workflow.
      ${fmt(rows.length)} calls · ${fmt(conversations)} conversations. Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC.
    </p>
  </header>

  <div class="mb-3 flex flex-wrap items-center gap-3">
    <input x-model="q" type="search" placeholder="Filter by conversation, workflow, node…"
           class="w-80 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm outline-none focus:border-slate-500">
    <label class="flex items-center gap-1.5 text-sm text-slate-600">
      <input type="checkbox" x-model="onlyConversations" class="rounded border-slate-300"> Conversations only (hide sub-workflow calls)
    </label>
    <span class="text-sm text-slate-500" x-text="filtered.length + ' of ' + rows.length + ' rows'"></span>
  </div>

  <div class="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
    <div class="max-h-[68vh] overflow-auto">
      <table class="w-full border-collapse text-sm">
        <thead class="sticky top-0 z-10 bg-slate-50">
          <tr>
            <template x-for="col in cols" :key="col.key">
              <th @click="sortBy(col.key)"
                  class="cursor-pointer select-none whitespace-nowrap border-b border-slate-200 px-3 py-2 font-semibold text-slate-600 hover:text-slate-900"
                  :class="col.num ? 'text-right' : 'text-left'">
                <span x-text="col.label"></span>
                <span class="text-slate-400" x-text="sortKey === col.key ? (sortDir > 0 ? ' ▲' : ' ▼') : ''"></span>
              </th>
            </template>
          </tr>
        </thead>
        <tbody>
          <template x-for="r in filtered" :key="r.exec + '-' + r.call">
            <tr class="odd:bg-white even:bg-slate-50/60 hover:bg-amber-50">
              <td class="whitespace-nowrap px-3 py-1.5 text-slate-500" x-text="r.at"></td>
              <td class="whitespace-nowrap px-3 py-1.5">
                <span class="rounded px-1.5 py-0.5 text-xs font-medium"
                      :class="r.mode === 'webhook' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'"
                      x-text="r.conv || '—'"></span>
              </td>
              <td class="whitespace-nowrap px-3 py-1.5" x-text="r.workflow"></td>
              <td class="whitespace-nowrap px-3 py-1.5 text-slate-500" x-text="r.mode"></td>
              <td class="whitespace-nowrap px-3 py-1.5" x-text="r.node"></td>
              <td class="px-3 py-1.5 text-right tabular-nums text-slate-500" x-text="r.call"></td>
              <td class="px-3 py-1.5 text-right tabular-nums" x-text="fmt(r.pin)"></td>
              <td class="px-3 py-1.5 text-right tabular-nums" x-text="fmt(r.pout)"></td>
              <td class="px-3 py-1.5 text-right font-medium tabular-nums" x-text="fmt(r.tot)"></td>
            </tr>
          </template>
          <tr x-show="!filtered.length">
            <td colspan="9" class="px-3 py-8 text-center text-slate-500">No rows match this filter.</td>
          </tr>
        </tbody>
        <tfoot class="sticky bottom-0 bg-slate-800 text-white">
          <tr class="font-semibold">
            <td class="px-3 py-2.5" colspan="6"
                x-text="'TOTAL — ' + filtered.length + ' call' + (filtered.length === 1 ? '' : 's') + ' · ' + new Set(filtered.map(r => r.conv).filter(Boolean)).size + ' conversations'"></td>
            <td class="px-3 py-2.5 text-right tabular-nums" x-text="fmt(sum.pin)"></td>
            <td class="px-3 py-2.5 text-right tabular-nums" x-text="fmt(sum.pout)"></td>
            <td class="px-3 py-2.5 text-right tabular-nums" x-text="fmt(sum.tot)"></td>
          </tr>
        </tfoot>
      </table>
    </div>
  </div>
  <p class="mt-2 text-xs text-slate-500">Totals follow the filter — clear the search to see the whole table.</p>
</div>

<script id="token-rows" type="application/json">${JSON.stringify(rows).replace(/</g, '\\u003c')}</script>
<script>
function tokenTable() {
  return {
    rows: JSON.parse(document.getElementById('token-rows').textContent),
    q: '',
    onlyConversations: false,
    sortKey: 'at',
    sortDir: -1,
    cols: [
      { key: 'at', label: 'When (UTC)' },
      { key: 'conv', label: 'Conversation' },
      { key: 'workflow', label: 'Workflow' },
      { key: 'mode', label: 'Run mode' },
      { key: 'node', label: 'Model node' },
      { key: 'call', label: 'Call #', num: true },
      { key: 'pin', label: 'Prompt tokens', num: true },
      { key: 'pout', label: 'Completion tokens', num: true },
      { key: 'tot', label: 'Total tokens', num: true },
    ],
    get filtered() {
      const needle = this.q.trim().toLowerCase();
      const out = this.rows.filter((r) => {
        if (this.onlyConversations && r.mode !== 'webhook') return false;
        if (!needle) return true;
        return (r.conv + ' ' + r.workflow + ' ' + r.node + ' ' + r.mode).toLowerCase().includes(needle);
      });
      const k = this.sortKey, dir = this.sortDir;
      return out.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir);
    },
    get sum() {
      return this.filtered.reduce((a, r) => ({ pin: a.pin + r.pin, pout: a.pout + r.pout, tot: a.tot + r.tot }), { pin: 0, pout: 0, tot: 0 });
    },
    fmt(n) { return Number(n).toLocaleString('en-US'); },
    sortBy(key) {
      if (this.sortKey === key) this.sortDir = -this.sortDir;
      else { this.sortKey = key; this.sortDir = ['at', 'conv', 'workflow', 'mode', 'node'].includes(key) ? 1 : -1; }
    },
  };
}
</script>
</body>
</html>
`;

fs.writeFileSync(OUT, html);
console.log(`wrote ${OUT} — ${rows.length} calls, ${conversations} conversations, ${fmt(totals.tot)} total tokens (prompt ${fmt(totals.pin)} / completion ${fmt(totals.pout)})`);
console.log(`table: ${TABLE_NAME} => ${physical}`);

// Console breakdown — useful when measuring a single turn: clear the table, make
// one call, ingest, and this prints exactly what that turn cost.
const byConv = new Map();
for (const r of rows) {
  const key = r.conv || '(no conversation — specialist sub-execution)';
  const e = byConv.get(key) ?? { calls: 0, pin: 0, pout: 0, tot: 0, newest: 0 };
  e.calls += 1; e.pin += r.pin; e.pout += r.pout; e.tot += r.tot; e.newest = Math.max(e.newest, r.exec);
  byConv.set(key, e);
}
if (rows.length) {
  console.log('\nper conversation:');
  for (const [key, e] of [...byConv].sort((a, b) => b[1].tot - a[1].tot)) {
    console.log(`  ${key.padEnd(38)} ${String(e.calls).padStart(3)} calls  ${fmt(e.pin).padStart(9)} in  ${fmt(e.pout).padStart(7)} out  ${fmt(e.tot).padStart(9)} total`);
  }
  if (byConv.size === 1 && rows.some((r) => r.conv)) {
    console.log(`\n-> single turn in the table: it cost ${fmt(totals.tot)} tokens across ${rows.length} LLM call(s)`);
  }
}
