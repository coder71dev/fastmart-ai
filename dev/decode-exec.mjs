// Decode n8n index-compressed execution data (flatted-style) and dump
// the AI Agent output (output + intermediateSteps shapes) for a given exec.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const execId = process.argv[2] || '168';
const q = `SELECT data FROM execution_data WHERE "executionId" = ${execId}`;
const r = spawnSync('docker', ['exec', '-i', 'fastmart-n8n-postgres', 'psql', '-U', 'n8n', '-d', 'fastmart_n8n', '-t', '-A'], { encoding: 'utf8', input: q });
const raw = r.stdout.trim();
const table = JSON.parse(raw); // array; numeric-string values are refs into it
function resolve(v, seen = new Set()) {
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const i = Number(v);
    if (i < table.length) return resolve(table[i], seen);
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => resolve(x, seen));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[resolve(k, seen)] = resolve(val, seen);
    return o;
  }
  return v;
}
const data = resolve(table);
const root = Array.isArray(data) ? data[0] : data;
console.log('table len:', table.length);
console.log('parentExecution:', JSON.stringify(root?.parentExecution));
console.log('root keys:', root && typeof root === 'object' ? Object.keys(root).join(',') : typeof root);
const runData = root?.resultData?.runData;
if (!runData) { console.log('no runData'); process.exit(1); }
console.log('nodes:', Object.keys(runData).join(', '));
const want = process.argv[3];
if (want) {
  const node = runData[want];
  const last = node[node.length - 1];
  const out = last?.data?.main?.[0]?.[0]?.json;
  fs.writeFileSync(`C:/Users/monar/AppData/Local/Temp/opencode/${want}${execId}.json`, JSON.stringify(out ?? last, null, 1).slice(0, 40000));
  console.log(`dumped ${want} input -> ${want}${execId}.json, keys:`, out ? Object.keys(out).join(',') : 'none');
  process.exit(0);
}
const agent = runData['AI Agent'];
const last = agent[agent.length - 1];
const out = last?.data?.main?.[0]?.[0]?.json;
console.log('--- agent output keys:', out ? Object.keys(out).join(',') : 'NONE');
if (out && out.intermediateSteps) {
  console.log('--- steps:', out.intermediateSteps.length);
  out.intermediateSteps.forEach((st, i) => {
    const tool = st?.action?.tool ?? st?.tool ?? '?';
    const obs = st?.observation;
    const obsType = Array.isArray(obs) ? 'array' : typeof obs;
    let preview = '';
    try { preview = JSON.stringify(obs).slice(0, 300); } catch { preview = String(obs).slice(0, 300); }
    console.log(`step ${i}: tool=${tool} obsType=${obsType}`);
    console.log('  ' + preview);
  });
} else {
  console.log('NO intermediateSteps in agent output');
  console.log(JSON.stringify(out).slice(0, 500));
}
fs.writeFileSync(`C:/Users/monar/AppData/Local/Temp/opencode/agentout${execId}.json`, JSON.stringify(out, null, 1).slice(0, 20000));
console.log('dumped head to agentout' + execId + '.json');
