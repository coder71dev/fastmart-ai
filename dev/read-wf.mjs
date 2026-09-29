// read-wf.mjs — print a workflow's structure straight from the n8n API.
//
// Use it when a PATCH is rejected or a deployed workflow looks wrong — the
// built JSON in dev/out/ is the SOURCE, so it cannot show you what n8n actually
// stored (e.g. connections that only exist on the instance).
//
//   node dev/read-wf.mjs <workflowId|workflow name>
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const REST = 'http://localhost:5678/rest';
const target = process.argv[2];
if (!target) {
  console.log('usage: node dev/read-wf.mjs <workflowId|workflow name>');
  process.exit(1);
}

const docker = (...a) => {
  const r = spawnSync('docker', a, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || '').trim());
  return r.stdout.trim();
};
const psqlRows = (sql) => {
  const r = spawnSync(
    'docker',
    ['exec', '-i', 'fastmart-n8n-postgres', 'psql', '-U', 'n8n', '-d', 'fastmart_n8n', '-t', '-A', '-F', '\u0001'],
    { encoding: 'utf8', input: sql },
  );
  if (r.status !== 0) throw new Error((r.stderr || 'psql failed').trim());
  return r.stdout.trim().split('\u0001');
};

const owner = psqlRows(`SELECT id, email, password FROM "user" WHERE "roleSlug" = 'global:owner' LIMIT 1;`);
const secret = docker('exec', 'fastmart-n8n', 'printenv', 'N8N_USER_MANAGEMENT_JWT_SECRET');
const b64 = (x) => Buffer.from(x).toString('base64url');
const hash = crypto.createHash('sha256').update(`${owner[1]}:${owner[2]}`).digest('base64').substring(0, 10);
const payload = { id: owner[0], hash, usedMfa: false, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
const si = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64(JSON.stringify(payload));
const token = si + '.' + crypto.createHmac('sha256', secret).update(si).digest('base64url');

const api = async (path) => {
  const res = await fetch(REST + path, { headers: { Cookie: `n8n-auth=${token}` } });
  const j = await res.json();
  return j.data;
};

const list = await api('/workflows?limit=200');
const match = (list || []).find((w) => w.id === target || w.name === target);
if (!match) {
  console.log(`no workflow "${target}". on this instance:`);
  for (const w of (list || [])) console.log(`  ${w.name}  (${w.id})${w.active ? '' : '  [inactive]'}`);
  process.exit(1);
}

const wf = await api(`/workflows/${match.id}`);
console.log(`name: ${wf.name}  | id: ${wf.id}  | active: ${wf.active}`);
console.log('nodes:');
for (const n of wf.nodes) console.log(`  ${n.name}  | id=${n.id} | type=${n.type}`);
console.log('connections:');
for (const [from, v] of Object.entries(wf.connections || {})) {
  for (const [type, outs] of Object.entries(v)) {
    for (const arr of outs) for (const c of arr) console.log(`  ${from} --${type}[${c.index}]--> ${c.node}`);
  }
}
if (wf.settings) console.log('settings:', JSON.stringify(wf.settings));
