-- Schema for the quality-eval pipeline (dev/build-quality-eval.mjs,
-- dev/review-flags.mjs — see AGENTS.md §7 and the 2026-10-19 session that
-- built this). Run once per instance against the SAME Postgres database
-- chat_memory_fastmart already lives in (the "fastmart Postgres (fastmart_ai
-- DB)" credential's actual database is fastmart_n8n, not a separate db —
-- confirmed live 2026-10-19, the credential name is just a friendly label):
--
--   docker exec -i <n8n-postgres-container> psql -U n8n -d fastmart_n8n \
--     < dev/quality-eval-schema.sql
--
-- Deliberately a plain table, not an n8n "Data Table" (that UI feature needs
-- the instance owner's real login to create via its REST API) — reviewed
-- with dev/review-flags.mjs instead of an n8n UI panel.
CREATE TABLE IF NOT EXISTS quality_eval (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(255) NOT NULL,
  human_msg_id INTEGER NOT NULL,
  ai_msg_id INTEGER NOT NULL UNIQUE, -- dedup key: chat_memory_fastmart has no timestamp column
  customer_message TEXT NOT NULL,
  reply_text TEXT NOT NULL,          -- cleaned of META_*/[BLOCK ...] markers, see dev/build-quality-eval.mjs's CLEAN_CODE
  context_snippet TEXT NOT NULL DEFAULT '', -- last ~8 prior turns the judge saw - added after a real miss (2026-10-19): a sycophancy bug only shows up across turns, invisible to a judge looking at one isolated reply
  score INTEGER,                     -- 1-5 from the judge LLM (see JUDGE_SYSTEM), NULL for status='skipped' rows never sent to the judge at all
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'new', -- new | reviewed | dismissed (dev/review-flags.mjs) | drafted (dev/draft-eval-cases.mjs) | skipped (variant-picker/approval turns - not evaluable from text alone, see CLEAN_CODE)
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quality_eval_status_score_idx ON quality_eval (status, score);
CREATE INDEX IF NOT EXISTS quality_eval_ai_msg_id_idx ON quality_eval (ai_msg_id);
