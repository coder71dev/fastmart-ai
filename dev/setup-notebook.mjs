// setup-notebook.mjs — create the n8n Data Tables that hold everything staff
// change from perfecto-ai-ops, and give them a first fill.
//
//   support_notebook  customer question → staff answer + lesson (see notebook-seed.js)
//   bot_settings      key/value: daily limit, limit reply, model choice, matching knobs
//   daily_usage       messages per customer per Dhaka day (written by the bot)
//   change_history    every change perfecto-ai-ops makes, so it can be undone
//
// Safe to run again and again: missing tables/columns are created, missing
// notebook entries and settings are added, but a row that already exists is
// NEVER overwritten — after the first fill those rows belong to staff.
//
// Usage:
//   node dev/setup-notebook.mjs            # create + fill missing
//   node dev/setup-notebook.mjs --check    # report only
//
// Embeddings are filled afterwards by the notebook-tools workflow
// (POST /webhook/notebook-tools {"action":"embed-missing"}), which sync.mjs
// calls after deploying it.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTEBOOK_SEED } from './notebook-seed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REST = process.env.N8N_REST || 'http://localhost:5678/rest';
const CHECK_ONLY = process.argv.includes('--check');

export const TABLES = {
  support_notebook: [
    ['entry_key', 'string'],
    ['topic', 'string'],
    ['customer_question', 'string'],
    ['other_ways_to_ask', 'string'],
    ['staff_answer', 'string'],
    ['lesson', 'string'],
    ['copy_exactly', 'boolean'],
    ['golden_rule', 'boolean'],
    ['free_past_limit', 'boolean'],
    ['enabled', 'boolean'],
    ['embedding', 'string'],
    ['embedded_hash', 'string'],
    ['updated_by', 'string'],
  ],
  bot_settings: [
    ['setting_key', 'string'],
    ['value', 'string'],
    ['note', 'string'],
    ['updated_by', 'string'],
  ],
  daily_usage: [
    ['user_key', 'string'],
    ['day', 'string'],
    ['count', 'number'],
  ],
  change_history: [
    ['table_name', 'string'],
    ['row_key', 'string'],
    ['old_value', 'string'],
    ['new_value', 'string'],
    ['changed_by', 'string'],
    ['test_result', 'string'],
  ],
};

export const DEFAULT_SETTINGS = [
  ['daily_limit', '20', 'Messages one customer can send per day (Dhaka time). 0 = no limit.'],
  ['limit_reply_bn', 'দুঃখিত স্যার/ম্যাম 🌸\nআজকের জন্য আপনার মেসেজ পাঠানোর সীমা শেষ হয়ে গেছে, তাই এই মুহূর্তে নতুন মেসেজের উত্তর দেওয়া সম্ভব হচ্ছে না। অসুবিধার জন্য আমরা আন্তরিকভাবে দুঃখিত।\n\nআগামীকাল আবার মেসেজ করলে আপনার নতুন দিনের মেসেজ শুরু হবে — তখন আমরা আবার সাহায্য করতে পারব।\n\nএখনই আমাদের সাথে কথা বলতে চাইলে কল বা WhatsApp করুন: +8801775-423477 (সকাল ১০টা – রাত ৮টা)।\n\nআপনার যত্নে আমরা সবসময় পাশে আছি ❤️', 'Reply sent when the daily limit is reached (Bangla).'],
  ['limit_reply_en', "Sorry, Sir/Ma'am 🌸\nYou've used today's message limit, so we can't answer new messages right now. We're truly sorry for the inconvenience.\n\nPlease message us again tomorrow — your new day's messages will start then, and we'll be glad to help.\n\nTo talk to us now, call or WhatsApp: +8801775-423477 (10am–8pm).\n\nWe're always here for you ❤️", 'Reply sent when the daily limit is reached (English).'],
  ['ip_limit_multiplier', '3', 'Backup limit per internet address = daily_limit x this.'],
  ['examples_per_reply', '5', 'How many similar notebook examples the AI sees per message.'],
  ['min_similarity', '0.80', 'Examples less similar than this (0-1) are ignored. Unrelated messages score up to ~0.86, real matches usually 0.85+.'],
  ['relative_margin', '0.06', 'Only examples within this distance of the best match are shown to the AI.'],
  ['strong_match', '0.87', 'A best match this similar (and clearly ahead of the next one) is treated as the same question: the AI answers straight from it.'],
  ['embedding_model', 'gemini-embedding-001', 'Model that measures meaning-similarity.'],
];

function psql(query) {
  const r = spawnSync(
    'docker',
    ['exec', '-i', 'fastmart-n8n-postgres', 'psql', '-U', 'n8n', '-d', 'fastmart_n8n', '-t', '-A', '-F', '\u0001'],
    { encoding: 'utf8', input: query },
  );
  if (r.status !== 0) throw new Error((r.stderr || 'psql failed').trim());
  return r.stdout.trim();
}

function cookie() {
  const r = spawnSync(process.execPath, [resolve(HERE, 'n8n-admin.mjs'), 'cookie'], { encoding: 'utf8', cwd: resolve(HERE, '..') });
  if (r.status !== 0) throw new Error('could not mint n8n session: ' + (r.stderr || r.stdout));
  return r.stdout.trim();
}

function projectId() {
  const owner = process.env.N8N_OWNER_ID
    || psql(`SELECT id FROM "user" WHERE "roleSlug" = 'global:owner' LIMIT 1;`);
  const pid = psql(`SELECT "projectId" FROM project_relation WHERE "userId" = '${owner}' AND role = 'project:personalOwner' LIMIT 1;`);
  if (!pid) throw new Error('could not find the owner\'s personal project');
  return pid;
}

let COOKIE;
async function api(method, path, body) {
  COOKIE ||= cookie();
  const res = await fetch(REST + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `n8n-auth=${COOKIE}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json && 'data' in json ? json.data : json;
}

export function seedRow(e) {
  return {
    entry_key: e.key,
    topic: e.topic || '',
    customer_question: e.q,
    other_ways_to_ask: e.alt || '',
    staff_answer: e.a,
    lesson: e.lesson || '',
    copy_exactly: !!e.exact,
    golden_rule: !!e.golden,
    free_past_limit: !!e.free,
    enabled: true,
    embedding: '',
    embedded_hash: '',
    updated_by: 'seed',
  };
}

async function allRows(base, tableId) {
  const out = [];
  for (let skip = 0; ; skip += 500) {
    const page = await api('GET', `${base}/${tableId}/rows?take=500&skip=${skip}`);
    const rows = page.data || [];
    out.push(...rows);
    if (rows.length < 500) break;
  }
  return out;
}

async function settingsTable() {
  const base = `/projects/${projectId()}/data-tables`;
  const t = ((await api('GET', `${base}?take=200`)).data || []).find((x) => x.name === 'bot_settings');
  return t ? { base, id: t.id } : null;
}

// bot_settings as a plain {key: value} map ({} when the table doesn't exist yet).
export async function readBotSettings() {
  const t = await settingsTable();
  if (!t) return {};
  const out = {};
  for (const r of await allRows(t.base, t.id)) if (r.setting_key) out[r.setting_key] = String(r.value ?? '');
  return out;
}

// Insert settings whose key is missing; never touches an existing key.
export async function addMissingSettings(pairs, note = '') {
  const t = await settingsTable();
  if (!t) throw new Error('bot_settings table is missing — run node dev/setup-notebook.mjs first');
  const have = await readBotSettings();
  const rows = Object.entries(pairs).filter(([k, v]) => !(k in have) && v != null && v !== '')
    .map(([setting_key, value]) => ({ setting_key, value: String(value), note, updated_by: 'seed' }));
  if (rows.length) await api('POST', `${t.base}/${t.id}/insert`, { data: rows, returnType: 'count' });
  return rows.map((r) => r.setting_key);
}

async function main() {
  const pid = projectId();
  const base = `/projects/${pid}/data-tables`;
  const existing = (await api('GET', `${base}?take=200`)).data || [];
  const byName = new Map(existing.map((t) => [t.name, t]));

  for (const [name, cols] of Object.entries(TABLES)) {
    let table = byName.get(name);
    if (!table) {
      if (CHECK_ONLY) { console.log(`missing table: ${name}`); continue; }
      table = await api('POST', base, { name, columns: cols.map(([n, type]) => ({ name: n, type })) });
      console.log(`created table ${name} (${table.id})`);
    } else {
      const have = new Set((await api('GET', `${base}/${table.id}/columns`)).map((c) => c.name));
      for (const [n, type] of cols) {
        if (have.has(n)) continue;
        if (CHECK_ONLY) { console.log(`missing column: ${name}.${n}`); continue; }
        await api('POST', `${base}/${table.id}/columns`, { name: n, type });
        console.log(`added column ${name}.${n}`);
      }
    }
    byName.set(name, table);
  }
  if (CHECK_ONLY) { console.log('--check done'); return; }

  // notebook: add only entry_keys we don't have yet
  const nb = byName.get('support_notebook');
  const haveKeys = new Set((await allRows(base, nb.id)).map((r) => r.entry_key));
  const newRows = NOTEBOOK_SEED.filter((e) => !haveKeys.has(e.key)).map(seedRow);
  if (newRows.length) await api('POST', `${base}/${nb.id}/insert`, { data: newRows, returnType: 'count' });
  console.log(`support_notebook: ${newRows.length} added, ${haveKeys.size} already there (left untouched)`);

  // settings: add only keys we don't have yet
  const st = byName.get('bot_settings');
  const haveSettings = new Set((await allRows(base, st.id)).map((r) => r.setting_key));
  const newSettings = DEFAULT_SETTINGS.filter(([k]) => !haveSettings.has(k))
    .map(([setting_key, value, note]) => ({ setting_key, value, note, updated_by: 'seed' }));
  if (newSettings.length) await api('POST', `${base}/${st.id}/insert`, { data: newSettings, returnType: 'count' });
  console.log(`bot_settings: ${newSettings.length} added, ${haveSettings.size} already there (left untouched)`);

  // profile form: staff ask age before suggesting (all products 18+, serum
  // 20+, snail/retinal 25+), so the form needs an age question. Added once.
  const pq = (existing.find((t) => t.name === 'profile_questions'));
  if (pq) {
    const pqRows = await allRows(base, pq.id);
    if (!pqRows.some((r) => String(r.field_key).trim() === 'age')) {
      await api('POST', `${base}/${pq.id}/insert`, { data: [{ field_key: 'age', label: 'Age', field_type: 'select', options: 'Under 18,18-19,20-24,25-34,35+', sort_order: 1.5, active: true }], returnType: 'count' });
      console.log('profile_questions: added the age question');
    }
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('setup-notebook.mjs')) {
  main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
