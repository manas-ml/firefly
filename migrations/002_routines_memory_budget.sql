-- Phase 2: scheduled routines, memory index, budget state, global settings.

CREATE TABLE schedules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id      BIGINT NOT NULL REFERENCES chats(id),
  name         TEXT NOT NULL,
  cron         TEXT NOT NULL,
  timezone     TEXT NOT NULL DEFAULT 'America/Toronto',
  prompt       TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  last_run_at  TIMESTAMPTZ,
  next_run_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_id, name)
);

ALTER TABLE tasks
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'routine')),
  ADD COLUMN schedule_id UUID REFERENCES schedules(id) ON DELETE SET NULL;

CREATE TABLE memories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic           TEXT NOT NULL,
  content         TEXT NOT NULL,
  source_task_id  UUID REFERENCES tasks(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  search          TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', topic || ' ' || content)) STORED
);
CREATE INDEX memories_topic_idx ON memories (topic);
CREATE INDEX memories_search_idx ON memories USING GIN (search);

CREATE TABLE budget_months (
  month       DATE PRIMARY KEY,           -- first day of the month, in the configured TZ
  raised_usd  NUMERIC(12, 6) NOT NULL DEFAULT 0,
  warned_at   TIMESTAMPTZ
);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
