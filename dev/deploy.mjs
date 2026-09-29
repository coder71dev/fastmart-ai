// deploy.mjs — upsert workflow(s) into live n8n as owner, then publish+activate.
// Usage:
//   node dev/deploy.mjs <workflowJson>...        upsert + activate each file
//   node dev/deploy.mjs --no-activate <file>     upsert (leave draft/inactive)
// Prints: name => id => activeVersionId
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const REST = 'http://localhost:5678/rest';

function docker(...args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout.trim();
}
// The owner id differs per instance (local != VPS) and used to be hardcoded here —
// which is what caused the 401 on deploy. Prefer an explicit N8N_OWNER_ID, else read
// the global owner straight from n8n's DB.
function psql(query) {
  const r = spawnSync('docker', ['exec', '-i', 'fastmart-n8n-postgres', 'psql', '-U', 'n8n', '-d', 'fastmart_n8n', '-t', '-A', '-c', query], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'psql failed');
  return (r.stdout || '').trim();
}
const OWNER_ID = process.env.N8N_OWNER_ID
  || psql(`SELECT id FROM "user" WHERE "roleSlug" = 'global:owner' LIMIT 1;`)
  || psql('SELECT id FROM "user" LIMIT 1;');
if (!OWNER_ID) throw new Error('could not determine the n8n owner user id (set N8N_OWNER_ID)');

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

// SQL string literal: everything doubled, no dollar-quoting surprises.
function quoteJson(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// n8n stores a workflow's canvas GROUPS (workflow_entity.nodeGroups) as a list of
// node ids, and REJECTS the whole PATCH when a group points at an id the incoming
// workflow no longer has:
//
//   400 Group "Answer customer chat" references node ID "gpu0v6" that does not exist.
//
// The groups live outside the workflow JSON, so the built file cannot fix them —
// the canvas is hand-drawn and this script is the only writer. n8n MERGES the
// stored workflow with the PATCH (see PLAN.md), so the stale group survives a
// redeploy and the next PATCH keeps failing.
//
// Reconcile by NAME, in two hops. The stored group holds ids of the STORED
// workflow, and the incoming JSON may use different ids (the builders once
// generated them randomly), so:
//     stored id -> stored node name -> incoming node id
// A member whose node no longer exists is dropped; a group left with no members
// is removed, because n8n rejects both a dangling id and an empty group.
function reconcileGroups(wf, existingId) {
  const psqlRead = spawnSync(
    'docker',
    ['exec', '-i', 'fastmart-n8n-postgres', 'psql', '-U', 'n8n', '-d', 'fastmart_n8n', '-t', '-A', '-F', '\u0001', '-c',
      `SELECT "nodeGroups", nodes FROM workflow_entity WHERE id = '${existingId}';`],
    { encoding: 'utf8' },
  );
  if (psqlRead.status !== 0) return null;
  const row = (psqlRead.stdout || '').trim();
  if (!row) return null;
  const sep = row.indexOf('\u0001');
  if (sep < 0) return null;
  const raw = row.slice(0, sep);
  let groups, storedNodes;
  try {
    groups = JSON.parse(raw);
    storedNodes = JSON.parse(row.slice(sep + 1));
  } catch { return null; }
  if (!Array.isArray(groups) || !groups.length) return null;

  const storedNameById = new Map();
  for (const n of storedNodes || []) storedNameById.set(String(n.id), n.name);
  const incomingIdByName = new Map();
  for (const n of wf.nodes || []) incomingIdByName.set(n.name, String(n.id));

  const changes = [];
  const keptGroups = [];
  for (const g of groups) {
    if (!Array.isArray(g.nodeIds)) continue;
    const remapped = [];
    const dropped = [];
    for (const oldId of g.nodeIds) {
      const name = storedNameById.get(String(oldId));
      const newId = name != null ? incomingIdByName.get(name) : null;
      if (newId) remapped.push(newId);
      else dropped.push(name || oldId);
    }
    if (!remapped.length) {
      changes.push(`  group "${g.name}": removed (no member exists in the build: ${dropped.join(', ')})`);
      continue;
    }
    if (dropped.length) changes.push(`  group "${g.name}": ${remapped.length} node id(s) re-mapped by name; dropped ${dropped.join(', ')}`);
    keptGroups.push({ ...g, nodeIds: remapped });
  }
  return { groups: keptGroups, changes };
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
    // A rename would otherwise CREATE a duplicate under the new name while every
    // workflow pointing at this one keeps the OLD id — the failure is invisible
    // until the agent's tool call 500s. Match is by name, so a name change has
    // to be a deliberate decision.
    if (!found && process.env.ALLOW_NEW_WORKFLOW !== '1') {
      const near = existing.filter((e) => !wf.name.includes(e.name) && !e.name.includes(wf.name)).map((e) => `${e.name} (${e.id})`);
      throw new Error(
        `no existing workflow named "${wf.name}" — refusing to create a new one silently, because the orchestrator's tool nodes reference workflows by id.\n` +
        (near.length ? `  similarly-named on this instance: ${near.join(', ')}\n` : '') +
        '  If this really is a NEW workflow, re-run with ALLOW_NEW_WORKFLOW=1.\n' +
        '  If it was RENAMED, rename it back in the n8n UI first (same id is kept).',
      );
    }
    let id, resp;
    if (found) {
      id = found.id;
      let attempt = await api('PATCH', `/workflows/${id}`, wf);
      // A stale canvas group makes n8n reject the PATCH with 400. Repair the
      // stored group in place, then retry once — otherwise the workflow can
      // never be updated again (the group survives every merge).
      if (attempt.status === 400 && /references node ID/.test(JSON.stringify(attempt.json))) {
        const rec = reconcileGroups(wf, id);
        if (rec) {
          const upd = spawnSync(
            'docker',
            ['exec', '-i', 'fastmart-n8n-postgres', 'psql', '-U', 'n8n', '-d', 'fastmart_n8n', '-t', '-A', '-c',
              `UPDATE workflow_entity SET "nodeGroups" = ${quoteJson(JSON.stringify(rec.groups))} WHERE id = '${id}';`],
            { encoding: 'utf8' },
          );
          if (upd.status === 0) {
            if (rec.changes.length) console.log('repaired canvas group:\n' + rec.changes.join('\n'));
            attempt = await api('PATCH', `/workflows/${id}`, wf);
          }
        }
      }
      resp = attempt.json;
      if (attempt.status !== 200) throw new Error(`PATCH ${wf.name} failed: ${attempt.status} ${JSON.stringify(resp)}`);
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
