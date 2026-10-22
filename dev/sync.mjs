// sync.mjs — build + deploy every workflow to THIS n8n instance, in dependency
// order, resolving every instance-specific id against the instance itself.
//
// Why this exists: the builders used to bake in ids copied from one instance
// (credentials, the 4 specialist tools, the 2 tool sub-workflows). Deploy that
// anywhere else and the orchestrator points at workflows that don't exist here —
// the turn 500s with "Error in workflow" and chat memory dies with
// "Error in sub-node PG Memory". Nothing caught it.
//
// This script removes that whole class of failure:
//   1. credentials are looked up BY NAME in the instance
//   2. each workflow is deployed, then its REAL id is read back
//   3. the next build gets those ids, so tool references always match
//   4. every reference is verified against the instance before it reports success
//
// Usage (works identically on localhost and the VPS):
//   node dev/sync.mjs
//   STORE_BASE_URL=https://perfectobd.com node dev/sync.mjs    # production build
//   node dev/sync.mjs --check        # verify only, deploy nothing
//
// Env overrides (all optional — normally resolved from the instance):
//   MODEL_CRED_ID / MODEL_CRED_NAME   model credential (default name below)
//   PG_CRED_ID / PG_CRED_NAME         chat-memory Postgres credential
//   STORE_BASE_URL                    baked into the tool nodes
//   MODEL / MODEL_PROVIDER            see dev/model-config.mjs
//   N8N_OWNER_ID                      override the auto-detected owner
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_NODE } from './model-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REST = 'http://localhost:5678/rest';
const CHECK_ONLY = process.argv.includes('--check');

// Credential names are instance-specific. sync.mjs reads them from a config
// file (written once by the user), falling back to the names bootstrap-creds.mjs
// uses on a fresh install. Override any of them with env vars.
import { readFileSync } from 'node:fs';
const CRED_FILE = resolve(HERE, '..', '.n8n-credentials.json');
let credConfig = {};
try { credConfig = JSON.parse(readFileSync(CRED_FILE, 'utf8')); } catch {}

// MODEL_NODE (dev/model-config.mjs) is the single source of truth for which
// provider/credential a build should use, and it already honors MODEL_PROVIDER
// (env or .n8n-credentials.json). Re-deriving a credential name here instead of
// reading it from MODEL_NODE was a real bug: this used to hardcode the
// "commandcode" credential's NAME regardless of MODEL_PROVIDER, so a
// `MODEL_PROVIDER=gemini node dev/sync.mjs` run still resolved and injected the
// commandcode credential's id into the Gemini node - n8n then rejects it
// outright ("Credential ... does not exist for type googlePalmApi"), verified
// live 2026-10-14. Deferring to MODEL_NODE fixes it for every provider, not
// just gemini.
const MODEL_CRED_NAME = process.env.MODEL_CRED_NAME || credConfig.MODEL_CRED_NAME || Object.values(MODEL_NODE.credentials)[0].name;
const PG_CRED_NAME = process.env.PG_CRED_NAME || credConfig.PG_CRED_NAME || 'fastmart Postgres (fastmart_ai DB)';
const WEBHOOK_JWT_CRED_NAME = process.env.WEBHOOK_JWT_CRED_NAME || credConfig.WEBHOOK_JWT_CRED_NAME || 'fastmart Webhook JWT';

// Deployment order = dependency order. A workflow that is called as a tool must
// EXIST before the caller is built, because the caller needs its id.
const TOOL_WORKFLOWS = [
  { file: 'searchTool.json', name: 'tool-search-products', env: 'SEARCH_TOOL_ID' },
  { file: 'productDetailTool.json', name: 'tool-product-detail', env: 'DETAIL_TOOL_ID' },
  { file: 'offersTool.json', name: 'tool-current-offers', env: 'OFFERS_TOOL_ID' },
  { file: 'readCartTool.json', name: 'tool-read-cart', env: 'READ_CART_TOOL_ID' },
];
const SPECIALISTS = [
  { file: 'productDiscovery.json', name: 'specialist-product-discovery', env: 'PRODUCT_DISCOVERY_ID' },
  { file: 'supportSpecialist.json', name: 'specialist-support', env: 'SUPPORT_SPECIALIST_ID' },
  { file: 'cartSpecialist.json', name: 'specialist-cart', env: 'CART_SPECIALIST_ID' },
  { file: 'orderSpecialist.json', name: 'specialist-orders', env: 'ORDER_SPECIALIST_ID' },
];
const MAIN = { file: 'agentChat.json', name: 'agent-chat (prod webhook)' };

function docker(...args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim());
  return r.stdout.trim();
}
function psql(query) {
  const r = spawnSync(
    'docker',
    ['exec', '-i', 'fastmart-n8n-postgres', 'psql', '-U', 'n8n', '-d', 'fastmart_n8n', '-t', '-A', '-F', '\u0001'],
    { encoding: 'utf8', input: query },
  );
  if (r.status !== 0) throw new Error((r.stderr || 'psql failed').trim());
  return r.stdout.trim();
}

// ---- instance introspection --------------------------------------------------

function ownerId() {
  return process.env.N8N_OWNER_ID || psql(`SELECT id FROM "user" WHERE "roleSlug" = 'global:owner' LIMIT 1;`) || psql('SELECT id FROM "user" LIMIT 1;');
}

function workflowIdsByName() {
  const out = psql('SELECT id, name FROM workflow_entity;');
  const map = new Map();
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const i = line.indexOf('\u0001');
    if (i > 0) map.set(line.slice(i + 1), line.slice(0, i));
  }
  return map;
}

function credentialsByName() {
  const out = psql('SELECT id, name FROM credentials_entity;');
  const map = new Map();
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const i = line.indexOf('\u0001');
    if (i > 0) map.set(line.slice(i + 1), line.slice(0, i));
  }
  return map;
}

// One credential by name, failing loudly with the alternatives if it's absent.
function resolveCred(envId, name, map) {
  if (envId) return { id: envId, name };
  const id = map.get(name);
  if (!id) {
    const fix = name.includes('Postgres') ? 'PG_CRED_NAME' : name.includes('Webhook') ? 'WEBHOOK_JWT_CRED_NAME (run node dev/create-webhook-jwt-cred.mjs first)' : 'MODEL_CRED_NAME';
    throw new Error(
      `no credential named "${name}" on this instance.\n` +
      `  available: ${[...map.keys()].join(', ') || '(none)'}\n` +
      `  fix: create it in n8n, or set ${fix} in .n8n-credentials.json (or pass it as env).`,
    );
  }
  return { id, name };
}

// ---- deploy (delegates to deploy.mjs so the auth logic lives in one place) ---
//
// ALLOW_NEW_WORKFLOW=1 for sync's own step: these are exactly the workflows
// sync.mjs is responsible for, so creating a missing one is intended (first
// sync on a fresh instance). deploy.mjs's rename guard still protects manual runs.
function deploy(file) {
  sh('deploy.mjs', [resolve(HERE, 'out', file)], { ALLOW_NEW_WORKFLOW: '1' });
}
function sh(script, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [resolve(HERE, script), ...args], {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    cwd: resolve(HERE, '..'),
  });
  if (r.status !== 0) throw new Error(`${script} failed (exit ${r.status})`);
}

function buildEnv(ids) {
  const env = {};
  for (const [k, v] of Object.entries(ids)) if (v) env[k] = v;
  return env;
}

function run(script, ids) {
  const r = spawnSync(process.execPath, [resolve(HERE, script)], {
    stdio: 'inherit',
    env: { ...process.env, ...buildEnv(ids) },
    cwd: resolve(HERE, '..'),
  });
  if (r.status !== 0) throw new Error(`${script} failed (exit ${r.status})`);
}

// ---- verification ------------------------------------------------------------

// Verify every reference the BUILT workflows make resolves on this instance.
// The two tool sub-workflows are called by the SPECIALISTS, not by the main
// workflow, so each file is checked against the references it actually contains.
function verify(ids) {
  const byName = workflowIdsByName();
  const creds = credentialsByName();
  const problems = [];

  const readWf = (file) => JSON.parse(fs.readFileSync(resolve(HERE, 'out', file), 'utf8'));
  const toolRefs = (wf) => {
    const out = [];
    for (const n of wf.nodes) {
      const wid = n.parameters && n.parameters.workflowId && n.parameters.workflowId.value;
      if (wid && n.type === '@n8n/n8n-nodes-langchain.toolWorkflow') out.push([n.name, wid]);
    }
    return out;
  };

  // workflow id -> the name it must have on this instance
  const owners = new Map([
    [ids.SEARCH_TOOL_ID, 'tool-search-products'],
    [ids.DETAIL_TOOL_ID, 'tool-product-detail'],
    [ids.OFFERS_TOOL_ID, 'tool-current-offers'],
    [ids.READ_CART_TOOL_ID, 'tool-read-cart'],
    [ids.PRODUCT_DISCOVERY_ID, 'specialist-product-discovery'],
    [ids.SUPPORT_SPECIALIST_ID, 'specialist-support'],
    [ids.CART_SPECIALIST_ID, 'specialist-cart'],
    [ids.ORDER_SPECIALIST_ID, 'specialist-orders'],
  ]);

  const files = [...TOOL_WORKFLOWS, ...SPECIALISTS, MAIN].map((w) => w.file);
  let refCount = 0;
  for (const file of files) {
    for (const [nodeName, wid] of toolRefs(readWf(file))) {
      refCount++;
      const want = owners.get(wid);
      if (!want) { problems.push(`${file}: node "${nodeName}" points at unrecognised workflow id ${wid}`); continue; }
      const actual = byName.get(want);
      if (actual !== wid) problems.push(`${file}: "${nodeName}" -> ${wid} but this instance has ${want} as ${actual || '(missing)'}`);
    }
  }
  // Every managed workflow must be referenced by someone (or be the entry point).
  const referenced = new Set(files.flatMap((f) => toolRefs(readWf(f)).map(([, id]) => id)));
  for (const [id, name] of owners) {
    if (!referenced.has(id)) problems.push(`${name} (${id}) is deployed but nothing references it`);
  }

  // Credentials referenced by any built workflow must exist on this instance.
  const seenCreds = new Set();
  for (const file of files) {
    for (const n of readWf(file).nodes) {
      for (const [type, ref] of Object.entries(n.credentials || {})) {
        if (!ref || !ref.id) { problems.push(`${file}: node "${n.name}" credential ${type} has no id`); continue; }
        seenCreds.add(ref.name);
        if (!creds.has(ref.name)) problems.push(`${file}: node "${n.name}" credential "${ref.name}" (${ref.id}) not found on this instance`);
      }
    }
  }

  // The model node must carry a real model id.
  const main = readWf(MAIN.file);
  const model = main.nodes.find((n) => n.type && /^@n8n\/n8n-nodes-langchain\.lmChat/.test(n.type));
  if (!model) problems.push('no model node in the built main workflow');
  else if (!Object.values(model.parameters || {}).some((v) => typeof v === 'string' && v.length)) problems.push('model node has no model id');

  // httpRequestTool nodes (cart-add, cart-summary, remove-line, store-settings,
  // shipping-offer, track-order) bake their store origin into the URL AT BUILD
  // TIME from process.env.STORE_BASE_URL (P.STORE in dev/prompts.js) - they
  // cannot read $env like the Code-node tools (search/detail/offers/read-cart/
  // Prepare Input/Response) do at runtime. A plain `node dev/sync.mjs` run
  // with STORE_BASE_URL unset in the shell silently bakes the
  // 'http://fastmart-pro.test' fallback into those httpRequestTool tools while
  // every Code-node tool keeps reading the CONTAINER's real STORE_BASE_URL -
  // a split-brain where cart-add writes to one store and the
  // cart-table/product-grid read from another. This happened live 2026-10-14
  // (verified: cart-add silently pointed at fastmart-pro.test while everything
  // else used stg-admin.perfectobd.com) and is exactly the failure class this
  // function exists to catch (see the file header). Compare the baked origin
  // against the instance's actual STORE_BASE_URL so it fails loudly instead.
  try {
    const containerStore = docker('exec', 'fastmart-n8n', 'printenv', 'STORE_BASE_URL').trim();
    if (containerStore) {
      const containerOrigin = new URL(containerStore).origin;
      for (const file of files) {
        for (const n of readWf(file).nodes) {
          if (n.type !== 'n8n-nodes-base.httpRequestTool') continue;
          const url = String(n.parameters && n.parameters.url || '');
          const m = url.match(/^=?(https?:\/\/[^/{]+)/);
          if (!m) continue;
          if (m[1] !== containerOrigin) {
            problems.push(`${file}: "${n.name}" is baked to ${m[1]} but this instance's STORE_BASE_URL is ${containerOrigin} - rebuild with STORE_BASE_URL=${containerStore} node dev/sync.mjs`);
          }
        }
      }
    }
  } catch {
    // Can't read the container's env (not running, different container name, etc.) -
    // not fatal to verify, just skip this specific check rather than failing sync
    // over something unrelated to the workflows themselves.
  }

  if (problems.length) {
    console.error('\nVERIFY FAILED:');
    for (const p of problems) console.error('  - ' + p);
    throw new Error('the deployed workflows would not run correctly — nothing was reported as successful');
  }
  console.log(`verify OK: ${refCount} tool references + ${seenCreds.size} credentials resolve on this instance`);
}

// ---- main --------------------------------------------------------------------

async function main() {
  const owner = ownerId();
  if (!owner) throw new Error('could not find the n8n owner user (set N8N_OWNER_ID)');
  process.env.N8N_OWNER_ID = owner;
  console.log(`n8n owner: ${owner}`);

  const existing = workflowIdsByName();
  const missing = [...TOOL_WORKFLOWS, ...SPECIALISTS, MAIN].filter((w) => !existing.has(w.name));
  if (missing.length) {
    console.log('not on this instance yet (first run?):', missing.map((m) => m.name).join(', '));
    console.log('run:  node dev/bootstrap-creds.mjs   then   node dev/sync.mjs\n');
  }

  const creds = credentialsByName();
  // Credential names come from .n8n-credentials.json (or env override).
  // No guessing — the user sets the names once and the whole pipeline uses them.
  const modelCred = resolveCred(process.env.MODEL_CRED_ID, MODEL_CRED_NAME, creds);
  const pgCred = resolveCred(process.env.PG_CRED_ID, PG_CRED_NAME, creds);
  const webhookJwtCred = resolveCred(process.env.WEBHOOK_JWT_CRED_ID, WEBHOOK_JWT_CRED_NAME, creds);
  const ids = {
    MODEL_CRED_ID: modelCred.id,
    MODEL_CRED_NAME: modelCred.name,
    PG_CRED_ID: pgCred.id,
    PG_CRED_NAME: pgCred.name,
    WEBHOOK_JWT_CRED_ID: webhookJwtCred.id,
    WEBHOOK_JWT_CRED_NAME: webhookJwtCred.name,
  };
  console.log(`credentials: model=${ids.MODEL_CRED_NAME} (${ids.MODEL_CRED_ID})  pg=${ids.PG_CRED_NAME} (${ids.PG_CRED_ID})  webhook-jwt=${ids.WEBHOOK_JWT_CRED_NAME} (${ids.WEBHOOK_JWT_CRED_ID})`);

  if (CHECK_ONLY) {
    // Build everything using the ids already on this instance, then verify
    // without deploying. This catches stale references, bad credentials and
    // broken prompts before you commit to the deploy.
    console.log('--check: building (not deploying)...');
    console.log('\n[1/3] tool sub-workflows');
    run('build-workflows.mjs', {});

    ids.SEARCH_TOOL_ID = existing.get('tool-search-products');
    ids.DETAIL_TOOL_ID = existing.get('tool-product-detail');
    ids.OFFERS_TOOL_ID = existing.get('tool-current-offers');
    ids.READ_CART_TOOL_ID = existing.get('tool-read-cart');
    if (!ids.SEARCH_TOOL_ID || !ids.DETAIL_TOOL_ID || !ids.OFFERS_TOOL_ID || !ids.READ_CART_TOOL_ID) {
      throw new Error('--check: tool sub-workflows not on this instance — run sync.mjs without --check first');
    }
    console.log(`      searchTool=${ids.SEARCH_TOOL_ID}  detailTool=${ids.DETAIL_TOOL_ID}  offersTool=${ids.OFFERS_TOOL_ID}  readCartTool=${ids.READ_CART_TOOL_ID}`);
    console.log('\n[2/3] specialists');
    run('build-workflows.mjs', ids);

    ids.PRODUCT_DISCOVERY_ID = existing.get('specialist-product-discovery');
    ids.SUPPORT_SPECIALIST_ID = existing.get('specialist-support');
    ids.CART_SPECIALIST_ID = existing.get('specialist-cart');
    ids.ORDER_SPECIALIST_ID = existing.get('specialist-orders');
    console.log(`      product=${ids.PRODUCT_DISCOVERY_ID} support=${ids.SUPPORT_SPECIALIST_ID} cart=${ids.CART_SPECIALIST_ID} orders=${ids.ORDER_SPECIALIST_ID}`);
    console.log('\n[3/3] main agent');
    run('build-main.mjs', ids);

    console.log('');
  } else {
    // 1. deploy the two tool sub-workflows first (no dependencies)
    console.log('\n[1/3] tool sub-workflows');
    for (const t of TOOL_WORKFLOWS) {
      run('build-workflows.mjs', {});
      deploy(t.file);
    }
    // 2. rebuild specialists with the tool ids just deployed
    const afterTools = workflowIdsByName();
    ids.SEARCH_TOOL_ID = afterTools.get('tool-search-products');
    ids.DETAIL_TOOL_ID = afterTools.get('tool-product-detail');
    ids.OFFERS_TOOL_ID = afterTools.get('tool-current-offers');
    ids.READ_CART_TOOL_ID = afterTools.get('tool-read-cart');
    console.log(`      searchTool=${ids.SEARCH_TOOL_ID}  detailTool=${ids.DETAIL_TOOL_ID}  offersTool=${ids.OFFERS_TOOL_ID}  readCartTool=${ids.READ_CART_TOOL_ID}`);
    console.log('\n[2/3] specialists');
    run('build-workflows.mjs', ids);
    for (const s of SPECIALISTS) deploy(s.file);

    // 3. rebuild main with the specialist ids just deployed
    const afterSpecs = workflowIdsByName();
    ids.PRODUCT_DISCOVERY_ID = afterSpecs.get('specialist-product-discovery');
    ids.SUPPORT_SPECIALIST_ID = afterSpecs.get('specialist-support');
    ids.CART_SPECIALIST_ID = afterSpecs.get('specialist-cart');
    ids.ORDER_SPECIALIST_ID = afterSpecs.get('specialist-orders');
    console.log(`      product=${ids.PRODUCT_DISCOVERY_ID} support=${ids.SUPPORT_SPECIALIST_ID} cart=${ids.CART_SPECIALIST_ID} orders=${ids.ORDER_SPECIALIST_ID}`);
    console.log('\n[3/3] main agent');
    run('build-main.mjs', ids);
    deploy(MAIN.file);
  }

  console.log('');
  verify(ids);
  console.log('\ndone.');
}

main().catch((e) => { console.error('\nERR', e.message); process.exit(1); });
