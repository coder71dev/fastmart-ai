// bootstrap-creds.mjs — set up credentials and deploy all workflows on a fresh instance.
//
// What it does:
//   1. Creates your owner account (if it doesn't exist yet)
//   2. Creates two credentials: OpenAI API + Postgres (for chat memory)
//   3. Patches the workflow JSONs in dev/out/ with the new credential ids
//   4. Deploys and activates all 7 workflows
//
// Usage:
//   node dev/build-workflows.mjs && node dev/build-main.mjs
//   node dev/bootstrap-creds.mjs
//
// The OpenAI credential reads its API key from N8N_INSTANCE_AI_MODEL_API_KEY
// in your .env (via the n8n container). If that's empty, set it:
//   N8N_INSTANCE_AI_MODEL_API_KEY=<your-key> node dev/bootstrap-creds.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const REST = 'http://localhost:5678/rest';
const DEFAULT_EMAIL = 'admin@fastmart.local';
const DEFAULT_PASSWORD = 'Admin123!';

function docker(...args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout.trim();
}

function queryPsql(sql) {
  const psql = spawnSync(
    'docker',
    ['exec', '-i', 'fastmart-n8n-postgres', 'psql', '-U', 'n8n', '-d', 'fastmart_n8n', '-t', '-A'],
    { encoding: 'utf8', input: sql },
  );
  if (psql.status !== 0) throw new Error('psql failed: ' + psql.stderr);
  return psql.stdout.trim();
}

function findOwnerRow() {
  const id = queryPsql(`SELECT id FROM "user" ORDER BY "createdAt" LIMIT 1;`);
  if (!id) return null;
  const email = queryPsql(`SELECT email FROM "user" WHERE id = '${id}';`);
  return { id, hasEmail: !!email };
}

async function ensureOwner() {
  const row = findOwnerRow();
  const email = process.env.N8N_OWNER_EMAIL || DEFAULT_EMAIL;
  const password = process.env.N8N_OWNER_PASSWORD || DEFAULT_PASSWORD;

  if (row && row.hasEmail) {
    console.log('owner exists:', row.id);
    return row.id;
  }

  // Either no owner, or a skeleton user (n8n creates one on first boot before setup)
  console.log('creating owner account:', email);
  const res = await fetch(`${REST}/owner/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, firstName: 'Admin', lastName: 'User', password }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 300) }; }
  if (res.status !== 200) throw new Error(`owner setup failed (${res.status}): ${JSON.stringify(json)}`);
  const after = findOwnerRow();
  if (!after?.id) throw new Error('owner setup succeeded but could not find the new account');
  console.log('owner created:', after.id);
  return after.id;
}

function jwtSecret() {
  return docker('exec', 'fastmart-n8n', 'printenv', 'N8N_USER_MANAGEMENT_JWT_SECRET');
}

function ownerUser(ownerId) {
  const email = queryPsql(`SELECT email FROM "user" WHERE id = '${ownerId}';`);
  if (!email) throw new Error('owner not found: ' + ownerId);
  const password = queryPsql(`SELECT password FROM "user" WHERE id = '${ownerId}';`);
  return { email, password };
}

const b64url = (x) => Buffer.from(x).toString('base64url');

function mintCookie(ownerId) {
  const secret = jwtSecret();
  const u = ownerUser(ownerId);
  const payload = {
    id: ownerId,
    hash: crypto.createHash('sha256').update(`${u.email}:${u.password}`).digest('base64').substring(0, 10),
    usedMfa: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 7 * 86400,
  };
  const si = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify(payload));
  return si + '.' + crypto.createHmac('sha256', secret).update(si).digest('base64url');
}

async function api(cookie, method, apiPath, body) {
  const res = await fetch(REST + apiPath, {
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
  const ownerId = await ensureOwner();
  const ck = mintCookie(ownerId);

  // --- 1. Create or find the OpenAI credential ---
  const { json: credList } = await api(ck, 'GET', '/credentials?limit=100');
  if (!credList?.data) throw new Error('could not list credentials: ' + JSON.stringify(credList));

  let openaiCred = credList.data.find(c => c.name === 'OpenAI compatible Commandcode');
  if (!openaiCred) {
    // Try reading API key from the n8n container's env, then from process.env
    let apiKey = process.env.N8N_INSTANCE_AI_MODEL_API_KEY;
    if (!apiKey) {
      try { apiKey = docker('exec', 'fastmart-n8n', 'printenv', 'N8N_INSTANCE_AI_MODEL_API_KEY'); } catch {}
    }
    if (!apiKey) throw new Error(
      'N8N_INSTANCE_AI_MODEL_API_KEY is not set. ' +
      'Add it to .env and restart n8n, or pass it: N8N_INSTANCE_AI_MODEL_API_KEY=xxx node dev/bootstrap-creds.mjs'
    );
    const { status, json } = await api(ck, 'POST', '/credentials', {
      name: 'OpenAI compatible Commandcode',
      type: 'openAiApi',
      data: { baseUrl: 'https://api.commandcode.ai/provider/v1', apiKey },
    });
    if (status !== 200) throw new Error(`create OpenAI credential failed: ${status} ${JSON.stringify(json)}`);
    openaiCred = json.data;
    console.log('created OpenAI credential:', openaiCred.id);
  } else {
    console.log('OpenAI credential exists:', openaiCred.id);
  }

  // --- 2. Create or find the Postgres credential (for chat memory) ---
  let pgCred = credList.data.find(c => c.type === 'postgres');
  if (!pgCred) {
    const pgPass = docker('exec', 'fastmart-n8n-postgres', 'printenv', 'POSTGRES_PASSWORD');
    const { status, json } = await api(ck, 'POST', '/credentials', {
      name: 'fastmart Postgres (n8n DB)',
      type: 'postgres',
      data: { host: 'fastmart-n8n-postgres', port: 5432, database: 'fastmart_n8n', user: 'n8n', password: pgPass },
    });
    if (status !== 200) throw new Error(`create Postgres credential failed: ${status} ${JSON.stringify(json)}`);
    pgCred = json.data;
    console.log('created Postgres credential:', pgCred.id);
  } else {
    console.log('Postgres credential exists:', pgCred.id);
  }

  // --- 3. Patch credential ids in workflow JSONs ---
  // The build scripts emit these placeholder ids from the original instance.
  const outDir = path.resolve('dev/out');
  if (!fs.existsSync(outDir)) throw new Error('dev/out/ not found — run node dev/build-workflows.mjs first');
  const OLD_OPENAI_ID = 'mlmhRJXXejblFl1S';
  const OLD_PG_ID = 'EsaKbJSqeQFEMuwd';
  let patched = 0;
  for (const f of fs.readdirSync(outDir).filter(f => f.endsWith('.json'))) {
    const fp = path.join(outDir, f);
    let content = fs.readFileSync(fp, 'utf8');
    let changed = false;
    if (content.includes(OLD_OPENAI_ID)) { content = content.replaceAll(OLD_OPENAI_ID, String(openaiCred.id)); changed = true; }
    if (content.includes(OLD_PG_ID)) { content = content.replaceAll(OLD_PG_ID, String(pgCred.id)); changed = true; }
    if (changed) { fs.writeFileSync(fp, content); patched++; console.log('patched', f); }
  }

  // --- 4. Deploy all workflows ---
  const deployOrder = [
    'searchTool.json', 'productDetailTool.json',
    'productDiscovery.json', 'supportSpecialist.json',
    'cartSpecialist.json', 'orderSpecialist.json', 'agentChat.json',
  ];
  for (const f of deployOrder) {
    const fp = path.join(outDir, f);
    if (!fs.existsSync(fp)) { console.log('skip (not built):', f); continue; }
    const wf = JSON.parse(fs.readFileSync(fp, 'utf8'));
    delete wf.id;
    const { json: wl } = await api(ck, 'GET', '/workflows?limit=200');
    const found = (wl?.data || []).find(w => w.name === wf.name);
    let id, versionId;
    if (found) {
      const { status, json } = await api(ck, 'PATCH', `/workflows/${found.id}`, wf);
      if (status !== 200) throw new Error(`PATCH ${wf.name}: ${status}`);
      id = found.id; versionId = json.data.versionId;
    } else {
      const { status, json } = await api(ck, 'POST', '/workflows', wf);
      if (status !== 200) throw new Error(`POST ${wf.name}: ${status}`);
      id = json.data.id; versionId = json.data.versionId;
    }
    await api(ck, 'POST', `/workflows/${id}/deactivate`, {});
    await api(ck, 'POST', `/workflows/${id}/activate`, { versionId });
    console.log(`${wf.name} => ${id}`);
  }
  console.log('done — all workflows deployed and active');
  console.log('');
  console.log('n8n login:');
  console.log('  email:   ' + (process.env.N8N_OWNER_EMAIL || DEFAULT_EMAIL));
  console.log('  password: ' + (process.env.N8N_OWNER_PASSWORD || DEFAULT_PASSWORD));
  console.log('  override: N8N_OWNER_EMAIL=you@example.com N8N_OWNER_PASSWORD=yourpass');
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
