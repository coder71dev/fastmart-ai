// deploy.mjs — upsert workflow(s) into live n8n as owner, then publish+activate.
// Usage:
//   node dev/deploy.mjs <workflowJson>...        upsert + activate each file
//   node dev/deploy.mjs --no-activate <file>     upsert (leave draft/inactive)
// Prints: name => id => activeVersionId
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const REST = 'http://localhost:5678/rest';
const OWNER_ID = '05933423-6fe4-4741-8988-8e28fd173da7';

function docker(...args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout.trim();
}
function jwtSecret() {
  const s = docker('exec', 'fastmart-n8n', 'printenv', 'N8N_USER_MANAGEMENT_JWT_SECRET');
  if (!s) throw new Error('empty jwt secret');
  return s;
}
function ownerUser() {
  const psql = spawnSync(
    'docker',
    ['exec', '-i', 'fastmart-n8n-postgres', 'psql', '-U', 'n8n', '-d', 'fastmart_n8n', '-t', '-A', '-F', '\u0001'],
    { encoding: 'utf8', input: `SELECT email, password, "mfaEnabled" FROM "user" WHERE id = '${OWNER_ID}';` },
  );
  if (psql.status !== 0) throw new Error(psql.stderr);
  const [email, password, mfaEnabled] = psql.stdout.trim().split('\u0001');
  return { email, password, mfaEnabled: mfaEnabled === 't' };
}
const b64url = (x) => Buffer.from(x).toString('base64url');
function cookie() {
  const secret = jwtSecret();
  const u = ownerUser();
  const payload = {
    id: OWNER_ID,
    hash: crypto.createHash('sha256').update(`${u.email}:${u.password}`).digest('base64').substring(0, 10),
    usedMfa: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 7 * 86400,
  };
  const si = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify(payload));
  return si + '.' + crypto.createHmac('sha256', secret).update(si).digest('base64url');
}
async function api(method, path, body) {
  const res = await fetch(REST + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `n8n-auth=${cookie()}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}
async function listWorkflows() {
  const { json } = await api('GET', '/workflows?limit=200');
  return (json?.data || []).map((w) => ({ id: w.id, name: w.name, active: w.active }));
}
async function main() {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const noActivate = process.argv.includes('--no-activate');
  if (files.length === 0) {
    console.log('usage: node dev/deploy.mjs [--no-activate] <workflow.json>...');
    return;
  }
  const existing = await listWorkflows();
  for (const f of files) {
    const wf = JSON.parse(fs.readFileSync(f, 'utf8'));
    delete wf.id;
    const found = existing.find((e) => e.name === wf.name);
    let id, resp;
    if (found) {
      id = found.id;
      const { status, json } = await api('PATCH', `/workflows/${id}`, wf);
      resp = json;
      if (status !== 200) throw new Error(`PATCH ${wf.name} failed: ${status} ${JSON.stringify(resp)}`);
    } else {
      const { status, json } = await api('POST', '/workflows', wf);
      resp = json;
      if (status !== 200) throw new Error(`POST ${wf.name} failed: ${status} ${JSON.stringify(resp)}`);
      id = resp.data.id;
    }
    const versionId = resp.data.versionId;
    if (noActivate) {
      console.log(`${wf.name} => ${id} (draft, not activated)`);
      continue;
    }
    // deactivate first (idempotent), then activate the draft version
    await api('POST', `/workflows/${id}/deactivate`, {});
    const act = await api('POST', `/workflows/${id}/activate`, { versionId });
    const av = act.json?.data?.activeVersionId;
    console.log(`${wf.name} => ${id} activeVersion=${av}`);
  }
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
