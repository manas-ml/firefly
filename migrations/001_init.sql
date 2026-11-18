CREATE TABLE chats (
  id                  BIGINT PRIMARY KEY,
  model               TEXT,
  session_file        TEXT,
  session_started_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id      BIGINT NOT NULL REFERENCES chats(id),
  message_id   BIGINT,
  prompt       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'waiting_approval', 'done', 'failed', 'cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  error        TEXT
);
CREATE INDEX tasks_chat_created_idx ON tasks (chat_id, created_at DESC);
CREATE INDEX tasks_status_idx ON tasks (status) WHERE status IN ('queued', 'running', 'waiting_approval');

CREATE TABLE tool_calls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID NOT NULL REFERENCES tasks(id),
  tool            TEXT NOT NULL,
  args            JSONB NOT NULL,
  decision        TEXT NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
  reason          TEXT NOT NULL,
  outcome         TEXT CHECK (outcome IN ('executed', 'denied_by_policy', 'denied_by_owner', 'expired', 'cancelled', 'error')),
  result_summary  TEXT,
  is_error        BOOLEAN,
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tool_calls_task_idx ON tool_calls (task_id, created_at);

CREATE TABLE approvals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID NOT NULL REFERENCES tasks(id),
  tool_call_id  UUID NOT NULL REFERENCES tool_calls(id),
  chat_id       BIGINT NOT NULL REFERENCES chats(id),
  message_id    BIGINT,
  summary       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  resolved_at   TIMESTAMPTZ
);
CREATE INDEX approvals_pending_idx ON approvals (chat_id) WHERE status = 'pending';

CREATE TABLE usage (
  id                 BIGSERIAL PRIMARY KEY,
  task_id            UUID REFERENCES tasks(id),
  model              TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd           NUMERIC(12, 6) NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX usage_created_idx ON usage (created_at);
CREATE INDEX usage_task_idx ON usage (task_id);
