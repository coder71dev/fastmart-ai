// prod-bench.mjs — production-readiness benchmark for the agent-chat webhook.
// Measures, against a LIVE n8n webhook (widget channel: POST {message, conversation_id},
// wait for full {reply, blocks}), three things a deploy decision needs:
//   1. LATENCY  — median/p90 HTTP wall time per real turn type (serial).
//   2. LOAD     — concurrency ramp 1 -> N: success rate, latency growth, where it breaks.
//   3. COST     — tokens per full turn (orchestrator + child specialist executions, from
//                 n8n's own Postgres metrics) x projected monthly chat volume.
//
// Usage:
//   node dev/prod-bench.mjs                            local baseline (latency + ramp)
//   node dev/prod-bench.mjs --phase latency --reps 3
//   node dev/prod-bench.mjs --phase ramp --ramp 1,2,5,10
//   node dev/prod-bench.mjs --webhook <vps-url> --store <live-store> --force-db   # run ON the VPS host
//   node dev/prod-bench.mjs --monthly-chats 3000 --out bench.json
//
// DB cost decode only applies when the bench talks to the SAME n8n as the local docker
// containers (webhook on localhost) OR you pass --force-db (bench runs on the n8n host).
// Otherwise tokens/cost come back null and only latency/load are reported.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

// ---- arg parsing (same style as eval-harness.mjs) --------------------------
const ARGS = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]?.startsWith('--') ? true : (arr[i + 1] ?? true)] : null)).filter(Boolean));
const WEBHOOK = String(ARGS.webhook ?? 'http://localhost:5678/webhook/spike/agent-chat');
const STORE = String(ARGS.store ?? 'http://fastmart-pro.test').replace(/\/+$/, '');
const PHASE = ARGS.phase === 'latency' || ARGS.phase === 'ramp' ? ARGS.phase : 'all';
const REPS = Number(ARGS.reps ?? 3);
const RAMP = String(ARGS.ramp ?? '1,2,5,10').split(',').map(Number).filter((n) => n > 0);
const TIMEOUT_MS = Number(ARGS.timeout ?? 150000);
const REPORT = ARGS.out ? String(ARGS.out) : null;
const MONTHLY_CHATS = Number(ARGS.monthly_chats ?? 0);
const NO_DB = ARGS['no-db'] === true;
const FORCE_DB = ARGS['force-db'] === true;
const QUICK = ARGS.quick === true;
const SESSION = 'b' + Date.now().toString(36);

// ---- model price basis (paid list rates; override with --price-in/--price-out) --
const PRICE_IN = Number(ARGS['price-in'] ?? 0.75);    // USD per 1M input tokens
const PRICE_OUT = Number(ARGS['price-out'] ?? 3.75);   // USD per 1M output tokens
const MODEL_NOTE = 'rates still default to the old gemini-3.7-flash list price (in=$0.75 out=$3.75 per 1M); the workflows now run deepseek/deepseek-v4.1-flash, so pass --price-in/--price-out or the cost column is wrong';

// ---------------------------------------------------------------------------
const localDb = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(WEBHOOK);
const useDb = !NO_DB && (localDb || FORCE_DB) && dockerAvailable();
const now = () => Date.now();
let runs = 0, timeouts = 0, httpErrs = 0;

function dockerAvailable() {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  return r.status === 0;
}
function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', 'fastmart-n8n-postgres', 'psql', '-U', 'n8n', '-d', 'fastmart_n8n', '-t', '-A', '-F', '\u0001'], { encoding: 'utf8', input: sql });
  if (r.status !== 0) throw new Error('psql failed: ' + (r.stderr || '').slice(0, 300));
  return r.stdout.split('\n').filter((l) => l).map((l) => l.split('\u0001'));
}
function resolveFlatted(table) {
  // depth guard: some blobs hold cyclic refs (or very deep message history);
  // we only need the shallow runData paths where tokenUsage lives, so cap depth.
  const MAX = 600;
  const resolve = (v, depth) => {
    if (depth > MAX) return '[max-depth]';
    if (typeof v === 'string' && /^\d+$/.test(v)) return +v < table.length ? resolve(table[+v], depth + 1) : v;
    if (Array.isArray(v)) return v.map((x) => resolve(x, depth + 1));
    if (v && typeof v === 'object') { const o = {}; for (const [k, val] of Object.entries(v)) o[resolve(k, depth + 1)] = resolve(val, depth + 1); return o; }
    return v;
  };
  return resolve(table, 0);
}
// Decode one execution -> token totals + metadata.
function decodeExec(id) {
  try {
    const row = psql(`SELECT mode, status, "startedAt", "stoppedAt" FROM execution_entity WHERE id = ${id}`)[0];
    if (!row) return null;
    const r = psql(`SELECT data FROM execution_data WHERE "executionId" = ${id}`);
    if (!r[0]?.[0]) return { id, mode: row[0], status: row[1], parent: null, inTok: 0, outTok: 0, ms: null };
    const root = resolveFlatted(JSON.parse(r[0][0]))[0];
    let inTok = 0, outTok = 0;
    const runData = root?.resultData?.runData ?? {};
    for (const node of Object.values(runData)) {
      for (const task of node) {
        const llm = task?.data?.ai_languageModel?.[0]?.[0]?.json?.tokenUsage;
        if (llm && Number.isFinite(Number(llm.promptTokens))) { inTok += Number(llm.promptTokens); outTok += Number(llm.completionTokens ?? 0); }
      }
    }
    const s = row[2] ? new Date(row[2]).getTime() : null;
    const e = row[3] ? new Date(row[3]).getTime() : null;
    return { id, mode: row[0], status: row[1], parent: root?.parentExecution?.executionId ?? null, inTok, outTok, ms: s && e ? e - s : null };
  } catch (err) {
    console.error(`    (decode warn: exec ${id} skipped — ${err.message})`);
    return { id, mode: 'unknown', status: 'decode-skip', parent: null, inTok: 0, outTok: 0, ms: null, skipped: true };
  }
}
// Full-turn token total = the exec + every integrated child linked to it.
function collectTurn(fromIdExclusive) {
  const rows = psql(`SELECT id FROM execution_entity WHERE id > ${fromIdExclusive} ORDER BY id ASC`);
  const execs = rows.map((r) => decodeExec(Number(r[0]))).filter(Boolean);
  const roots = execs.filter((x) => x.mode === 'webhook');
  const children = execs.filter((x) => x.mode === 'integrated' && x.parent && roots.some((r) => String(r.id) === x.parent));
  const all = roots.concat(children);
  const sum = all.reduce((a, x) => ({ inTok: a.inTok + x.inTok, outTok: a.outTok + x.outTok, ms: a.ms + (x.ms || 0), err: a.err || x.status !== 'success' }), { inTok: 0, outTok: 0, ms: 0, err: false });
  return { execs: all.map((x) => x.id), status: all.every((x) => x.status === 'success') ? 'success' : all.some((x) => x.status === 'success') ? 'partial' : 'error', tokens: { in: sum.inTok, out: sum.outTok, total: sum.inTok + sum.outTok }, execMs: sum.ms };
}
function maxExecId() {
  const r = psql('SELECT COALESCE(MAX(id),0) FROM execution_entity');
  return Number(r[0]?.[0] ?? 0);
}
function costOf(t) { return t ? (t.in / 1e6) * PRICE_IN + (t.out / 1e6) * PRICE_OUT : null; }
function fmtUSD(c) { return c == null ? 'n/a' : '$' + c.toFixed(4); }

// ---- HTTP (same channel the widget uses) ------------------------------------
function stripExtraneous(t) { const i = t.indexOf('{'); return i > 0 ? t.slice(i) : t; }
async function postChat(message, conversation_id) {
  const t0 = now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, conversation_id }), signal: ctrl.signal });
    const txt = stripExtraneous(await r.text());
    let json = null; try { json = txt ? JSON.parse(txt) : null; } catch {}
    return { status: r.status, ok: r.status === 200 && !!json, json, ms: now() - t0 };
  } catch (e) { return { status: 0, ok: false, json: null, ms: now() - t0, error: e.name === 'AbortError' ? 'timeout' : e.message }; }
  finally { clearTimeout(timer); }
}

// ---- scenario mix (mirrors real widget traffic; cart/memory share a conv) ----
const SEQUENCES = [
  { id: 'greeting', conv: () => `tmp-bench-${SESSION}-g`, msgs: ['hi'] },
  { id: 'product-search', conv: () => `tmp-bench-${SESSION}-p`, msgs: ['find me face serums'] },
  { id: 'support-policy', conv: () => `tmp-bench-${SESSION}-s`, msgs: ['what is your return policy?'] },
  { id: 'order-track', conv: () => `tmp-bench-${SESSION}-o`, msgs: ['track my order PERF-0000'] },
  { id: 'bengali', conv: () => `tmp-bench-${SESSION}-bn`, msgs: ['আপনার রিটার্ন পলিসি কী?'] },
  { id: 'cart', conv: () => `tmp-bench-${SESSION}-c`, msgs: ['add the iUNIK Tea Tree Relief Serum to my cart', 'show me my cart', 'remove the serum from my cart'] },
  { id: 'memory', conv: () => `tmp-bench-${SESSION}-m`, msgs: ['remember this for later: my skin is very oily and I want under 700 taka', 'what skin type and budget did I tell you?'] },
];
const RAMP_POOL = ['find me face serums', 'what is your return policy?', 'how long does delivery take?', 'show me a vitamin c serum under 2000 taka', 'hi', 'track my order PERF-0000'];

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const stats = (arr) => ({ n: arr.length, mean: arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0, p50: Math.round(pct(arr, 0.5)), p90: Math.round(pct(arr, 0.9)), max: arr.length ? Math.round(Math.max(...arr)) : 0, min: arr.length ? Math.round(Math.min(...arr)) : 0 });

// ---- phase 1: serial latency -------------------------------------------------
async function phaseLatency() {
  console.log(`\n== LATENCY phase (serial, reps=${REPS}, session=${SESSION}) ==`);
  const samples = []; // {seq, step, label, ok, ms, status, tokens, cost, error}
  let fromId = useDb ? maxExecId() : 0;
  for (const seq of QUICK ? SEQUENCES.filter((s) => ['greeting', 'product-search', 'support-policy'].includes(s.id)) : SEQUENCES) {
    for (let rep = 0; rep < REPS; rep++) {
      const conv = seq.conv();
      for (let step = 0; step < seq.msgs.length; step++) {
        const label = `${seq.id}#${step + 1}`;
        process.stdout.write(`  ${label} (rep ${rep + 1}/${REPS}) ... `);
        const pre = useDb ? maxExecId() : 0;
        const res = await postChat(seq.msgs[step], conv);
        let tokens = null, execMs = null;
        if (useDb) { const t = collectTurn(pre === 0 ? fromId : pre); tokens = t.tokens.total ? t.tokens : null; execMs = t.execMs; fromId = pre === 0 ? fromId : pre; }
        if (!res.ok) { if (res.error === 'timeout') timeouts++; else httpErrs++; }
        runs++;
        samples.push({ label, conv, rep, step, ok: res.ok, status: res.status, ms: res.ms, execMs, tokens, cost: costOf(tokens), error: res.error || null });
        const tok = tokens ? ` tok=${tokens.total}` : '';
        console.log(`${res.ok ? 'ok' : 'FAIL(' + (res.error || res.status) + ')'} ${res.ms}ms${tok}`);
        if (step === 0 && res.ok && res.ms > 60000) console.log('    (slow first turn — cold model?)');
      }
    }
  }
  return samples;
}

// ---- phase 2: concurrency ramp ------------------------------------------------
async function phaseRamp() {
  console.log(`\n== RAMP phase (levels: ${RAMP.join(' -> ')}) ==`);
  const results = []; // per level summary + per-request records
  let fromId = useDb ? maxExecId() : 0;
  let poolIdx = 0;
  for (const level of RAMP) {
    const baseId = useDb ? maxExecId() : 0;
    const reqs = [];
    for (let i = 0; i < level; i++) {
      const msg = RAMP_POOL[poolIdx++ % RAMP_POOL.length];
      const conv = `tmp-bench-${SESSION}-r${poolIdx}`;
      reqs.push({ msg, conv });
    }
    const t0 = now();
    const settled = await Promise.all(reqs.map((q) => postChat(q.msg, q.conv)));
    const done = settled.map((res, i) => ({ ...reqs[i], ...res }));
    const durMs = now() - t0;
    let levelTok = null;
    if (useDb) {
      const t = collectTurn(baseId === 0 ? fromId : baseId);
      if (baseId !== 0) fromId = baseId;
      levelTok = t.tokens;
    }
    const ok = done.filter((d) => d.ok);
    const failed = done.filter((d) => !d.ok);
    failed.forEach((d) => { if (d.error === 'timeout') timeouts++; else httpErrs++; });
    runs += done.length;
    results.push({
      level, ok: ok.length, fail: failed.length, wallMs: durMs,
      lat: stats(ok.map((d) => d.ms)), errors: failed.map((d) => d.error || String(d.status)),
      tokens: levelTok, cost: costOf(levelTok), costPerOk: ok.length ? costOf(levelTok) / ok.length : null,
    });
    console.log(`  level=${level}  ok=${ok.length}/${done.length}  wall=${durMs}ms  okLat med=${ok.length ? Math.round(pct(ok.map((d) => d.ms), 0.5)) : '-'}ms p90=${ok.length ? Math.round(pct(ok.map((d) => d.ms), 0.9)) : '-'}ms` + (levelTok ? `  avgTok=${Math.round(levelTok.total / Math.max(ok.length, 1))}` : '') + (failed.length ? `  errors=${JSON.stringify(results.at(-1).errors)}` : ''));
    await new Promise((r) => setTimeout(r, 2500));
  }
  return results;
}

// ---- output -------------------------------------------------------------------
function buildReport(latency, ramp) {
  const okLat = (latency || []).filter((s) => s.ok);
  const bySeq = {};
  for (const s of latency || []) (bySeq[s.label.split('#')[0]] ??= []).push(s);
  const perSeq = Object.entries(bySeq).map(([seq, arr]) => {
    const oks = arr.filter((x) => x.ok).map((x) => x.ms);
    const toks = arr.filter((x) => x.tokens).map((x) => x.tokens);
    const avgTok = toks.length ? { in: Math.round(toks.reduce((a, t) => a + t.in, 0) / toks.length), out: Math.round(toks.reduce((a, t) => a + t.out, 0) / toks.length) } : null;
    return { seq, samples: arr.length, ok: oks.length, latencyMs: stats(oks), avgTokensPerTurn: avgTok, avgCostPerTurn: toks.length ? costOf({ in: (toks.reduce((a, t) => a + t.in, 0)) / toks.length, out: toks.reduce((a, t) => a + t.out, 0) / toks.length }) : null };
  });
  const rampRows = (ramp || []).map((r) => ({ ...r, errors: undefined }));
  const allCost = (latency || []).filter((s) => s.tokens).reduce((a, s) => a + (s.cost || 0), 0);
  const costRows = (ramp || []).filter((r) => r.tokens).reduce((a, r) => a + (r.cost || 0), 0);
  return {
    session: SESSION, at: new Date().toISOString(), webhook: WEBHOOK, store: STORE,
    dbCostDecode: useDb ? 'on (n8n postgres)' : 'off (no local db access for this target)', priceBasis: MODEL_NOTE, priceInPerM: PRICE_IN, priceOutPerM: PRICE_OUT,
    timeoutMs: TIMEOUT_MS, monthlyChats: MONTHLY_CHATS,
    totals: { runs, timeouts, httpErrs },
    latency: perSeq,
    latencyAllOkMs: okLat.length ? stats(okLat.map((s) => s.ms)) : null,
    ramp: rampRows,
    cost: { latencyTotal: allCost, rampTotal: costRows, latencyPlusRamp: allCost + costRows },
    projectionMonthly: MONTHLY_CHATS > 0 ? {
      chats: MONTHLY_CHATS,
      at0_5perChatLatencyAvgCost: allCost ? (allCost / Math.max(okLat.length, 1)) * MONTHLY_CHATS : null,
      note: 'estimate = measured avg $/turn x monthly chats; uses only turns that produced DB token data',
    } : null,
    recommendation: recommend(perSeq, rampRows),
  };
}
function recommend(perSeq, rampRows) {
  const notes = [];
  const worstSeq = [...perSeq].sort((a, b) => (b.latencyMs.p90 || 0) - (a.latencyMs.p90 || 0))[0];
  if (worstSeq) notes.push(`worst p90 = ${worstSeq.seq} at ${worstSeq.latencyMs.p90}ms (target <~15000ms for a chat turn)`);
  for (const r of rampRows) if (r.fail > 0) notes.push(`at concurrency ${r.level}: ${r.fail}/${r.level} requests failed (${r.errors.join(', ')})`);
  const maxClean = rampRows.filter((r) => r.fail === 0).at(-1);
  if (maxClean) notes.push(`clean through concurrency ${maxClean.level} (median ${maxClean.lat.p50}ms)`);
  else if (rampRows.length) notes.push('no concurrency level completed cleanly — check model quota / n8n concurrency limit');
  notes.push('production knobs if load exceeds the clean level: raise N8N_CONCURRENCY_PRODUCTION_LIMIT in docker-compose, and check the Command Code key quota/rate limit (the workflows and the Assistant share one key).');
  return notes;
}

// ---- main ----------------------------------------------------------------------
console.log(`prod-bench — webhook ${WEBHOOK}\nstore ${STORE} · session ${SESSION} · db-cost=${useDb ? 'on' : 'off'} · timeout=${TIMEOUT_MS}ms`);
console.log(MODEL_NOTE);
if (!localDb && useDb) console.log('(db decode FORCED — ensure this box hosts fastmart-n8n-postgres)');

const latency = (PHASE === 'all' || PHASE === 'latency') ? await phaseLatency() : null;
const ramp = (PHASE === 'all' || PHASE === 'ramp') ? await phaseRamp() : null;

if (latency) {
  console.log('\n-- LATENCY by sequence (successful turns only) --');
  for (const s of buildReport(latency, null).latency) console.log(`  ${s.seq.padEnd(15)} n=${String(s.ok).padStart(2)}/${s.samples}  med=${String(s.latencyMs.p50).padStart(5)}ms p90=${String(s.latencyMs.p90).padStart(5)}ms max=${String(s.latencyMs.max).padStart(5)}ms  avgTok=${s.avgTokensPerTurn ? s.avgTokensPerTurn.in + '+' + s.avgTokensPerTurn.out : 'n/a'}  avgCost=${fmtUSD(s.avgCostPerTurn)}`);
}
const report = buildReport(latency, ramp);
console.log('\n' + '='.repeat(60));
console.log(`SUMMARY  runs=${runs}  timeouts=${timeouts}  httpErr=${httpErrs}`);
if (report.latencyAllOkMs) console.log(`all-turn ok latency: med=${report.latencyAllOkMs.p50}ms p90=${report.latencyAllOkMs.p90}ms`);
console.log(`measured cost (db tokens): latency=${fmtUSD(report.cost.latencyTotal)} ramp=${fmtUSD(report.cost.rampTotal)}`);
if (report.projectionMonthly) console.log(`projected ${MONTHLY_CHATS} chats/mo ~= ${fmtUSD(report.projectionMonthly.at0_5perChatLatencyAvgCost)} (avg measured $/turn x chats)`);
for (const n of report.recommendation) console.log('• ' + n);
if (REPORT) {
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('report ->', REPORT);
}
process.exit(timeouts > 0 || httpErrs > 0 ? 1 : 0);
