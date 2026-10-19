// review-flags.mjs — the human review step for quality_eval (stage 3 of the
// self-improving-loop sketch, 2026-10-19 conversation). The quality-eval
// workflow (dev/build-quality-eval.mjs) only ever WRITES rows here - nothing
// in that workflow or this script can change dev/prompts.js or redeploy
// anything. "Flag and draft, never auto-apply": this is where a human looks
// at what the judge flagged and decides what's real.
//
// Usage:
//   node dev/review-flags.mjs                     worst-first, status=new, score<=3
//   node dev/review-flags.mjs --threshold 4        widen/narrow the cutoff
//   node dev/review-flags.mjs --all                every status, every score
//   node dev/review-flags.mjs --stats              just the score distribution
//   node dev/review-flags.mjs --mark-reviewed 123  mark a row handled (keeps the record)
//   node dev/review-flags.mjs --dismiss 123        mark a row as noise (judge was wrong)
import { spawnSync } from 'node:child_process';

const ARGS = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]?.startsWith('--') ? true : (arr[i + 1] ?? true)] : null)).filter(Boolean));

function psqlJson(query) {
  const r = spawnSync('docker', ['exec', '-i', 'fastmart-n8n-postgres', 'psql', '-U', 'n8n', '-d', 'fastmart_n8n', '-t', '-A', '-c', query], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'psql failed');
  const out = (r.stdout || '').trim();
  if (!out || out === '') return [];
  try { return JSON.parse(out) || []; } catch (e) { throw new Error(`could not parse psql JSON output: ${e.message}\n${out.slice(0, 500)}`); }
}
function psqlExec(query) {
  const r = spawnSync('docker', ['exec', '-i', 'fastmart-n8n-postgres', 'psql', '-U', 'n8n', '-d', 'fastmart_n8n', '-c', query], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'psql failed');
  return (r.stdout || '').trim();
}
function esc(s) { return String(s).replace(/'/g, "''"); }

if (ARGS['mark-reviewed']) {
  const id = Number(ARGS['mark-reviewed']);
  console.log(psqlExec(`UPDATE quality_eval SET status = 'reviewed' WHERE id = ${id};`));
  process.exit(0);
}
if (ARGS.dismiss) {
  const id = Number(ARGS.dismiss);
  console.log(psqlExec(`UPDATE quality_eval SET status = 'dismissed' WHERE id = ${id};`));
  process.exit(0);
}
if (ARGS.stats) {
  const rows = psqlJson(`SELECT json_agg(t) FROM (SELECT score, status, COUNT(*) AS n FROM quality_eval GROUP BY score, status ORDER BY score, status) t;`);
  console.log('Score / status breakdown:');
  for (const r of rows) console.log(`  score=${r.score}  status=${r.status}  count=${r.n}`);
  const total = psqlJson(`SELECT json_agg(t) FROM (SELECT COUNT(*) AS n, MIN(id) AS min_id, MAX(id) AS max_id FROM quality_eval) t;`)[0];
  console.log(`\nTotal judged: ${total.n} (quality_eval id range ${total.min_id}-${total.max_id})`);
  process.exit(0);
}

const showAll = ARGS.all === true;
const threshold = Number(ARGS.threshold ?? 3);
const where = showAll ? '' : `WHERE status = 'new' AND score <= ${threshold}`;
const rows = psqlJson(`SELECT json_agg(t) FROM (SELECT id, session_id, human_msg_id, ai_msg_id, score, reason, status, customer_message, reply_text, evaluated_at FROM quality_eval ${where} ORDER BY score ASC, id DESC) t;`);

if (!rows.length) {
  console.log(showAll ? 'quality_eval is empty.' : `No new flags at or below score ${threshold}. (--all to see everything, --stats for a breakdown)`);
  process.exit(0);
}
console.log(`${rows.length} row(s)${showAll ? '' : ` (status=new, score<=${threshold})`}:\n`);
for (const r of rows) {
  console.log(`#${r.id}  score=${r.score}  status=${r.status}  session=${r.session_id}  (chat_memory ids ${r.human_msg_id}/${r.ai_msg_id})`);
  console.log(`  customer: ${r.customer_message.replace(/\n/g, ' ').slice(0, 200)}`);
  console.log(`  reply:    ${r.reply_text.replace(/\n/g, ' ').slice(0, 200)}`);
  console.log(`  judge:    ${r.reason}`);
  console.log('');
}
console.log(`Mark handled: node dev/review-flags.mjs --mark-reviewed <id>`);
console.log(`Dismiss as noise: node dev/review-flags.mjs --dismiss <id>`);
