-- token_cost_log — running log of real Gemini/Command Code token usage and
-- cost per n8n execution (orchestrator + each specialist sub-workflow),
-- built because this n8n version cannot read its own AI Agent's token usage
-- in-workflow (see dev/build-main.mjs's RESPONSE_CODE comment, verified live
-- 2026-10-22: every $('<model node>') accessor throws "No data found from
-- main input" for an ai_languageModel sub-node). The token-cost-log workflow
-- (dev/build-token-cost-log.mjs) reads each execution back out-of-band
-- through n8n's own REST API instead and writes one row per execution here.
--
-- Run once per instance:
--   docker exec -i fastmart-n8n-postgres psql -U n8n -d fastmart_ai < dev/token-cost-log-schema.sql
-- (swap the container/db name for whatever the target instance's
-- "fastmart Postgres (fastmart_ai DB)" credential actually points at — same
-- database PG Memory's chat_memory_fastmart table lives in.)

CREATE TABLE IF NOT EXISTS token_cost_log (
  id                   SERIAL PRIMARY KEY,
  execution_id         INTEGER NOT NULL UNIQUE,
  parent_execution_id  INTEGER,
  workflow_name        TEXT NOT NULL,
  mode                 TEXT,
  status               TEXT,
  started_at           TIMESTAMPTZ,
  stopped_at           TIMESTAMPTZ,
  provider             TEXT,
  model                TEXT,
  input_tokens         INTEGER,
  cached_tokens        INTEGER,
  output_tokens        INTEGER,
  total_tokens         INTEGER,
  cost_usd             NUMERIC(10,6),
  logged_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS token_cost_log_started_at_idx ON token_cost_log (started_at);
CREATE INDEX IF NOT EXISTS token_cost_log_parent_idx ON token_cost_log (parent_execution_id);
