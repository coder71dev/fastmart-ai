// exec-timing.mjs — per-node wall-time breakdown for one n8n execution.
// Usage: node dev/exec-timing.mjs <execId>
// Prints each node's runs, total ms, and % of the execution, plus LLM token
// metrics when present. Decodes n8n's index-compressed execution_data blob.
import { spawnSync } from 'node:child_process';

const execId = process.argv[2];
if (!execId) { console.log('usage: node dev/exec-timing.mjs <execId>'); process.exit(1); }
const r = spawnSync('docker', ['exec', '-i', 'fastmart-n8n-postgres', 'psql', '-U', 'n8n', '-d', 'fastmart_n8n', '-t', '-A'], { encoding: 'utf8', input: `SELECT data FROM execution_data WHERE "executionId" = ${execId}` });
if (!r.stdout.trim()) { console.log('no data for exec', execId); process.exit(1); }
const table = JSON.parse(r.stdout.trim());
function resolve(v) {
  if (typeof v === 'string' && /^\d+$/.test(v)) return +v < table.length ? resolve(table[+v]) : v;
  if (Array.isArray(v)) return v.map(resolve);
  if (v && typeof v === 'object') { const o = {}; for (const [k, val] of Object.entries(v)) o[resolve(k)] = resolve(val); return o; }
  return v;
}
const root = resolve(table)[0];
const runData = root?.resultData?.runData ?? {};
const wfStart = Math.min(...Object.values(runData).flat().flatMap((t) => Number(t?.startTime ?? Infinity)));
const rows = [];
let grand = 0;
for (const [node, tasks] of Object.entries(runData)) {
  let sum = 0, runs = 0;
  const tokens = [];
  for (const t of tasks) {
    const ms = Number(t?.executionTime ?? 0);
    if (Number.isFinite(ms)) { sum += ms; runs++; }
    const m = t?.metadata?.metrics;
    if (m) tokens.push(m);
    grand += ms;
  }
  rows.push({ node, runs, ms: sum, pct: 0, tokens });
}
const wall = rows.length ? Math.max(...rows.map((x) => x.ms)) : 0;
for (const row of rows) row.pct = wall ? Math.round((row.ms / wall) * 100) : 0;
rows.sort((a, b) => b.ms - a.ms);
console.log(`exec ${execId}  nodes=${rows.length}  approx wall=${(wall / 1000).toFixed(1)}s  (node sums may overlap where nodes run nested)`);
for (const { node, runs, ms, pct, tokens } of rows) {
  const tok = tokens.length ? '  tokens[' + tokens.map((t) => `in:${t['llm.tokens.in'] ?? '?'} out:${t['llm.tokens.out'] ?? '?'}`).join(' | ') + ']' : '';
  console.log(`  ${String(ms).padStart(6)}ms  ${String(pct).padStart(3)}%  ${String(runs).padStart(2)}x  ${node}${tok}`);
}
