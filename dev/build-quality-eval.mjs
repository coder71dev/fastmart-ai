// Builds the "quality-eval" workflow — stages 1-3 of the self-improving-loop
// sketch (2026-10-19 conversation): sample real customer/assistant turns from
// chat_memory_fastmart, score each with a judge LLM call, and write every
// judged turn (not just the bad ones) into the quality_eval Postgres table.
//
// Deliberately NOT an n8n "Data Table" (that UI feature needs the owner's
// real login to create via its REST API — out of reach for an automated
// build step) — a plain Postgres table in the same fastmart_n8n DB that
// chat_memory_fastmart already lives in, created once via:
//   dev/quality-eval-schema.sql (see README / AGENTS.md for the runbook)
// Reviewed with `node dev/review-flags.mjs`, not an n8n UI panel.
//
// This workflow NEVER touches dev/prompts.js or agent-chat — it only reads
// chat_memory_fastmart (read-only) and writes to quality_eval. Flag-and-draft,
// never auto-apply: nothing here can change what the live assistant says.
//
// Standalone, not part of sync.mjs's dependency chain (nothing depends on it,
// it depends on nothing) - deploy directly:
//   node dev/build-quality-eval.mjs && node dev/deploy.mjs dev/out/qualityEval.json
// The PG_CRED / MODEL_NODE fallback ids below are correct for THIS instance
// only, same caveat as build-main.mjs's own PG_CRED — if this ever needs to
// deploy identically across instances, fold it into sync.mjs's existing
// by-name credential resolution instead of trusting these literals.
import fs from 'node:fs';
import { MODEL_NODE, modelNodeFields } from './model-config.mjs';
import { stableId } from './node-id.mjs';

const OUT = 'dev/out';
let credConfig = {};
try { credConfig = JSON.parse(fs.readFileSync('.n8n-credentials.json', 'utf8')); } catch {}
const PG_CRED_NAME = process.env.PG_CRED_NAME || credConfig.PG_CRED_NAME || 'fastmart Postgres (fastmart_ai DB)';
const PG_CRED_ID = process.env.PG_CRED_ID || credConfig.PG_CRED_ID || 'EsaKbJSqeQFEMuwd';
const PG_CRED = { id: PG_CRED_ID, name: PG_CRED_NAME };

const node = (o) => ({ id: o.id || stableId(o.name), disabled: false, ...o });
const pos = (x, y) => [x, y];

// Pairs each human turn with the NEXT ai turn in the same session (adjacent-
// turn pairing - good enough since every real turn in this app is a strict
// human-then-ai alternation) and only returns pairs newer than the last one
// already scored (ai_msg_id is a real unique, monotonically increasing id -
// chat_memory_fastmart has no timestamp column, so this is the dedup key,
// not a time window). LIMIT keeps one run's judge-call cost bounded.
const SAMPLE_SQL = `
WITH ordered AS (
  SELECT
    id, session_id,
    message->>'type' AS role,
    message->>'content' AS content,
    LEAD(id) OVER (PARTITION BY session_id ORDER BY id) AS next_id,
    LEAD(message->>'type') OVER (PARTITION BY session_id ORDER BY id) AS next_role,
    LEAD(message->>'content') OVER (PARTITION BY session_id ORDER BY id) AS next_content
  FROM chat_memory_fastmart
),
pairs AS (
  SELECT
    id AS human_msg_id, session_id,
    content AS customer_message,
    next_id AS ai_msg_id,
    next_content AS raw_reply
  FROM ordered
  WHERE role = 'human' AND next_role = 'ai'
    AND content IS NOT NULL AND next_content IS NOT NULL
)
SELECT
  p.human_msg_id, p.session_id, p.customer_message, p.ai_msg_id, p.raw_reply,
  -- Last 8 prior messages in the SAME session, chronological - without this
  -- the judge only ever sees one isolated turn and cannot catch a real bug
  -- found live 2026-10-19: the customer asserted an unverified claim about
  -- the business ("you're brand X's authorized distributor") two turns
  -- earlier, and the assistant repeated it back as confirmed fact when
  -- asked directly - every turn in that exchange scored 5/5 in isolation
  -- because nothing in a single turn looks wrong on its own.
  (
    SELECT string_agg(line, E'\\n' ORDER BY mid) FROM (
      SELECT h.id AS mid,
        (CASE WHEN h.message->>'type' = 'human' THEN 'Customer: ' ELSE 'Assistant: ' END || (h.message->>'content')) AS line
      FROM chat_memory_fastmart h
      WHERE h.session_id = p.session_id AND h.id < p.human_msg_id
      ORDER BY h.id DESC
      LIMIT 8
    ) recent
  ) AS prior_context
FROM pairs p
-- NOT a ">MAX(ai_msg_id)" watermark on purpose: that was the bug (found live
-- 2026-10-19, same session as the sycophancy one above). One run judged the
-- newest 25 of a 34-pair backlog (DESC order), which pushed quality_eval's
-- max past the 9 OLDEST pairs in that backlog - a real watermark check from
-- then on, "> max", could never see them again even though they were never
-- actually judged. 9 real turns (including a separate language bug the
-- judge never got a chance to see) silently vanished from review forever.
-- True set-difference has no such gap regardless of how LIMIT truncates a
-- batch, and ASC (oldest-first) means a bounded backlog drains in order
-- instead of a LIMIT-truncated newest-first batch starving the old end.
WHERE NOT EXISTS (SELECT 1 FROM quality_eval q WHERE q.ai_msg_id = p.ai_msg_id)
ORDER BY p.ai_msg_id ASC
LIMIT 25;
`.trim();

// Strips the same META_*/[BLOCK ...] footer RESPONSE_CODE (dev/build-main.mjs)
// strips before a reply ever reaches a real customer - the judge should score
// what the customer actually saw, not the orchestrator's raw internal output
// (chat_memory_fastmart stores the PRE-strip text, confirmed live 2026-10-19).
const CLEAN_CODE = `
function stripFooter(s) {
  return String(s ?? '')
    .replace(/META_PRODUCT_IDS:[^\\n]*\\n?/gi, '')
    .replace(/META_ORDER_JSON:[^\\n]*\\n?/gi, '')
    .replace(/META_VARIANT_PRODUCT_ID:[^\\n]*\\n?/gi, '')
    .replace(/META_APPROVAL_JSON:[^\\n]*\\n?/gi, '')
    .replace(/META_COMPARISON_JSON:[^\\n]*\\n?/gi, '')
    .replace(/META_SUGGESTIONS:[^\\n]*\\n?/gi, '')
    .replace(/META_PROFILE_ASK:[^\\n]*\\n?/gi, '')
    .trim();
}
function plainText(s) {
  return String(s ?? '')
    .replace(/\\[BLOCK[^\\]]*\\]/gi, '')
    .replace(/\\n{2,}/g, '\\n')
    .trim();
}
// Also clean the assistant lines inside prior_context - it's pulled straight
// from chat_memory_fastmart same as raw_reply, so it carries the same raw
// META_*/[BLOCK ...] noise.
function cleanContext(s) {
  if (!s) return '';
  return String(s)
    .split('\\n')
    .map((line) => (line.startsWith('Assistant: ') ? 'Assistant: ' + plainText(stripFooter(line.slice('Assistant: '.length))) : line))
    .join('\\n');
}
const out = [];
for (const item of $input.all()) {
  const raw = item.json.raw_reply || '';
  const clean = plainText(stripFooter(raw));
  // Human-in-the-loop turns (variant-picker/approval) are DESIGNED to carry
  // minimal prose - the real content IS the structured block (the size
  // options, the cart-add items to confirm), which this text-only judge
  // never sees. Judging "does this text look complete" against them is not
  // applicable, not just unfair - live-verified 2026-10-19: "Just to
  // confirm:" (the correct, intended prose for an approval card) scored as
  // "cut off mid-sentence". Flagged here, not silently dropped - see the IF
  // node this feeds into.
  const skip = /\\[BLOCK\\s+(variant-picker|approval)\\]/i.test(raw);
  out.push({ json: { ...item.json, clean_reply: clean, prior_context: cleanContext(item.json.prior_context), skip: skip ? 'yes' : 'no' } });
}
return out;
`;

const JUDGE_SYSTEM = `You are a strict quality auditor for a beauty e-commerce shopping assistant's chat replies. You are given recent CONVERSATION HISTORY for context, the CUSTOMER MESSAGE, and the ASSISTANT REPLY that was actually shown to them (already cleaned of internal formatting markers).

Score the reply 1-5:
5 = fully answers the question, accurate, complete, nothing to flag.
4 = answers the question; maybe slightly awkward phrasing, no real problem.
3 = partially answers, missing a minor detail, or a bit vague.
2 = largely fails to answer, reads as evasive, generic, or incomplete.
1 = any of: does not address the question at all; looks broken or cut off mid-sentence; makes a claim (a price, a policy, a product fact) that reads as made up rather than something a real store would say; replies in a DIFFERENT language than the customer actually used (see the language check below); OR — check the CONVERSATION HISTORY carefully for this — the assistant confirms, agrees with, "notes," or repeats back as settled fact something the CUSTOMER themselves asserted earlier about the business (e.g. "you're brand X's authorized distributor", "you quoted me the wrong price a moment ago", any claim about ownership, certifications, tax/legal status, or "what you told me earlier") without that claim appearing as something the ASSISTANT itself established or a tool result would support. A customer's own assertion in their own message is never evidence. An assistant that validates it, cites it back as fact in a later turn, or apologizes for a "mistake" you cannot actually see it make earlier in the history is a serious failure (score 1) even when the reply is polite, fluent, and otherwise well-formed — this pattern is easy to miss turn-by-turn precisely because each individual reply reads fine in isolation.

LANGUAGE CHECK (judge this explicitly, every time, even when everything else about the reply is fine): this store's customers write in English, real Bengali script (বাংলা), or Banglish (Bengali words spelled out in English letters, e.g. "valo acho", "ki ache", "dekhao", "amar budget"). Banglish is Bengali, not English — a customer typing in Latin letters is not automatically asking for an English reply. If the CUSTOMER MESSAGE is in Bengali script or Banglish and the ASSISTANT REPLY is in English, that is a score-1 failure regardless of how complete or well-written the English reply otherwise is — being helpful in the wrong language is not actually helpful. The assistant replying in real Bengali script to a Banglish message is CORRECT, not a problem.

Judge price/fact ACCURACY only against what you can see in the conversation history above — you do not have the live catalog, so do not guess whether a number is correct in absolute terms, only whether the assistant is being honest about what it actually knows versus parroting the customer's own claims back as confirmed fact.

Respond with ONLY strict JSON, no markdown fence, no extra commentary:
{"score": <integer 1-5>, "reason": "<one short sentence specific to this reply, under 150 characters>"}`;

function modelNode() {
  return node({ ...modelNodeFields(), position: pos(460, -200) });
}

const nodes = [];
const connections = {};

nodes.push(
  node({
    parameters: {
      rule: { interval: [{ field: 'hours', hoursInterval: 1 }] },
    },
    name: 'Schedule Trigger',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.4,
    position: pos(0, 0),
  }),
);
nodes.push(
  node({
    parameters: {
      operation: 'executeQuery',
      query: SAMPLE_SQL,
      options: {},
    },
    name: 'Sample Unjudged Turns',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.7,
    position: pos(220, 0),
    credentials: { postgres: PG_CRED },
  }),
);
nodes.push(
  node({
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: CLEAN_CODE },
    name: 'Clean Reply',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: pos(440, 0),
  }),
);
nodes.push(
  node({
    // See CLEAN_CODE's own comment: variant-picker/approval turns are not
    // evaluable from text alone, so they never reach the Judge at all -
    // routed straight to a 'skipped' row instead (status='skipped', not
    // 'new', so they never show up in review-flags.mjs's default queue,
    // and still DO get an ai_msg_id row so the NOT EXISTS dedup never
    // re-selects them forever - the exact same class of gap as a1052c4's
    // watermark bug, just for a different reason this time).
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
        combinator: 'and',
        conditions: [
          { id: 'skip-hitl-turn', leftValue: "={{ $json.skip }}", rightValue: 'yes', operator: { type: 'string', operation: 'equals' } },
        ],
      },
      options: {},
    },
    name: 'Skip Block-Only Turns?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.3,
    position: pos(660, 0),
  }),
);
nodes.push(
  node({
    parameters: {
      operation: 'insert',
      schema: { __rl: true, mode: 'name', value: 'public' },
      table: { __rl: true, mode: 'name', value: 'quality_eval' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          session_id: '={{ $json.session_id }}',
          human_msg_id: '={{ $json.human_msg_id }}',
          ai_msg_id: '={{ $json.ai_msg_id }}',
          customer_message: '={{ $json.customer_message }}',
          reply_text: '={{ $json.clean_reply }}',
          context_snippet: '={{ $json.prior_context }}',
          status: 'skipped',
          reason: 'human-in-the-loop turn (variant-picker/approval) - real content is in the block, not evaluable from text alone',
        },
      },
      options: { skipOnConflict: true },
    },
    name: 'Insert Skipped Row',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.7,
    position: pos(880, 160),
    credentials: { postgres: PG_CRED },
  }),
);
nodes.push(
  node({
    parameters: {
      promptType: 'define',
      text: '=CONVERSATION HISTORY (most recent {{ $json.prior_context ? "turns shown" : "- this is the first turn" }}):\n{{ $json.prior_context || "(none - first message in this conversation)" }}\n\n---\n\nCUSTOMER MESSAGE: {{ $json.customer_message }}\n\nASSISTANT REPLY: {{ $json.clean_reply }}',
      options: { systemMessage: JUDGE_SYSTEM, maxIterations: 1 },
    },
    name: 'Judge',
    type: '@n8n/n8n-nodes-langchain.agent',
    typeVersion: 2,
    position: pos(880, 0),
  }),
);
nodes.push(modelNode());
nodes.push(
  node({
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      // Re-pairs each Judge output with its source row from Clean Reply by
      // index - the AI Agent node's own output replaces $json entirely
      // (same reason RESPONSE_CODE reads $('Prepare Input') by node
      // reference rather than trusting what's still on $json after AI
      // Agent runs), so the original human_msg_id/session_id/etc have to be
      // pulled back in explicitly. A parse failure never drops the row
      // (score defaults to 3, reason says so) - the point is every sampled
      // turn gets permanently marked as judged so it is never re-sampled,
      // even when the judge itself misbehaves.
      jsCode: `
function firstJson(s) {
  if (s == null) return null;
  const i = s.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}
const judged = $input.all();
const source = $('Clean Reply').all();
const out = [];
for (let i = 0; i < judged.length; i++) {
  const src = source[i] ? source[i].json : {};
  const raw = judged[i].json.output;
  const parsed = firstJson(typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''));
  let score = Number(parsed && parsed.score);
  if (!Number.isFinite(score)) score = 3;
  score = Math.max(1, Math.min(5, Math.round(score)));
  const reason = (parsed && typeof parsed.reason === 'string' && parsed.reason.trim())
    ? parsed.reason.trim().slice(0, 200)
    : 'judge output could not be parsed - needs manual check';
  out.push({ json: {
    session_id: String(src.session_id || ''),
    human_msg_id: Number(src.human_msg_id) || 0,
    ai_msg_id: Number(src.ai_msg_id) || 0,
    customer_message: String(src.customer_message || '').slice(0, 2000),
    reply_text: String(src.clean_reply || '').slice(0, 4000),
    context_snippet: String(src.prior_context || '').slice(0, 3000),
    score,
    reason,
  } });
}
return out;
`.trim(),
    },
    name: 'Parse Score',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: pos(1100, 0),
  }),
);
nodes.push(
  node({
    parameters: {
      operation: 'insert',
      schema: { __rl: true, mode: 'name', value: 'public' },
      table: { __rl: true, mode: 'name', value: 'quality_eval' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          session_id: '={{ $json.session_id }}',
          human_msg_id: '={{ $json.human_msg_id }}',
          ai_msg_id: '={{ $json.ai_msg_id }}',
          customer_message: '={{ $json.customer_message }}',
          reply_text: '={{ $json.reply_text }}',
          context_snippet: '={{ $json.context_snippet }}',
          score: '={{ $json.score }}',
          reason: '={{ $json.reason }}',
        },
      },
      options: { skipOnConflict: true },
    },
    name: 'Insert Eval Row',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.7,
    position: pos(1320, 0),
    credentials: { postgres: PG_CRED },
  }),
);

connections['Schedule Trigger'] = { main: [[{ node: 'Sample Unjudged Turns', type: 'main', index: 0 }]] };
connections['Sample Unjudged Turns'] = { main: [[{ node: 'Clean Reply', type: 'main', index: 0 }]] };
connections['Clean Reply'] = { main: [[{ node: 'Skip Block-Only Turns?', type: 'main', index: 0 }]] };
// If output 0 = true (skip='yes', a variant-picker/approval turn) -> straight
// to the skipped-row insert; output 1 = false (a real, judgeable turn) -> Judge.
connections['Skip Block-Only Turns?'] = { main: [[{ node: 'Insert Skipped Row', type: 'main', index: 0 }], [{ node: 'Judge', type: 'main', index: 0 }]] };
connections[MODEL_NODE.nodeName] = { ai_languageModel: [[{ node: 'Judge', type: 'ai_languageModel', index: 0 }]] };
connections['Judge'] = { main: [[{ node: 'Parse Score', type: 'main', index: 0 }]] };
connections['Parse Score'] = { main: [[{ node: 'Insert Eval Row', type: 'main', index: 0 }]] };

const wf = {
  name: 'quality-eval (self-review sampler)',
  nodes,
  connections,
  settings: { executionOrder: 'v1' },
};
fs.writeFileSync(`${OUT}/qualityEval.json`, JSON.stringify(wf, null, 2));
console.log('built qualityEval.json');
console.log('model:', MODEL_NODE.provider, '->', MODEL_NODE.model);
console.log('pg cred:', PG_CRED.name, `(${PG_CRED.id})`);
