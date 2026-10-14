// create-webhook-jwt-cred.mjs — create/update the "jwtAuth" credential that
// gates the public agent-chat webhook, from N8N_WEBHOOK_JWT_SECRET (.env /
// container env). Follows the same authenticated-REST-API pattern as
// dev/bootstrap-creds.mjs (mint an owner cookie, POST/PATCH /credentials).
//
// Usage: node dev/create-webhook-jwt-cred.mjs
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const REST = 'http://localhost:5678/rest';
const CRED_NAME = process.env.WEBHOOK_JWT_CRED_NAME || 'fastmart Webhook JWT';

function docker(...args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout.trim();
}
function queryPsql(sql) {
  const r = spawnSync(
    'docker',
    ['exec', '-i', 'fastmart-n8n-postgres', 'psql', '-U', 'n8n', '-d', 'fastmart_n8n', '-t', '-A'],
    { encoding: 'utf8', input: sql },
  );
  if (r.status !== 0) throw new Error('psql failed: ' + r.stderr);
  return r.stdout.trim();
}
const b64url = (x) => Buffer.from(x).toString('base64url');
function mintCookie() {
  const ownerId = queryPsql(`SELECT id FROM "user" ORDER BY "createdAt" LIMIT 1;`);
  const email = queryPsql(`SELECT email FROM "user" WHERE id = '${ownerId}';`);
  const password = queryPsql(`SELECT password FROM "user" WHERE id = '${ownerId}';`);
  const secret = docker('exec', 'fastmart-n8n', 'printenv', 'N8N_USER_MANAGEMENT_JWT_SECRET');
  const payload = {
    id: ownerId,
    hash: crypto.createHash('sha256').update(`${email}:${password}`).digest('base64').substring(0, 10),
    usedMfa: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const si = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify(payload));
  return si + '.' + crypto.createHmac('sha256', secret).update(si).digest('base64url');
}
async function api(cookie, method, path, body) {
  const res = await fetch(REST + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `n8n-auth=${cookie}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

async function main() {
  const secret = process.env.N8N_WEBHOOK_JWT_SECRET || docker('exec', 'fastmart-n8n', 'printenv', 'N8N_WEBHOOK_JWT_SECRET');
  if (!secret) throw new Error('N8N_WEBHOOK_JWT_SECRET is not set (.env + docker compose up -d --force-recreate n8n first)');

  const cookie = mintCookie();
  const { json: list } = await api(cookie, 'GET', '/credentials?limit=100');
  if (!list?.data) throw new Error('could not list credentials: ' + JSON.stringify(list));

  const existing = list.data.find((c) => c.name === CRED_NAME);
  const data = { keyType: 'passphrase', secret, algorithm: 'HS256' };
  if (existing) {
    const { status, json } = await api(cookie, 'PATCH', `/credentials/${existing.id}`, { name: CRED_NAME, type: 'jwtAuth', data });
    if (status !== 200) throw new Error(`update credential failed: ${status} ${JSON.stringify(json)}`);
    console.log('updated credential:', CRED_NAME, existing.id);
  } else {
    const { status, json } = await api(cookie, 'POST', '/credentials', { name: CRED_NAME, type: 'jwtAuth', data });
    if (status !== 200) throw new Error(`create credential failed: ${status} ${JSON.stringify(json)}`);
    console.log('created credential:', CRED_NAME, json.data.id);
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
