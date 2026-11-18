-- Phase 3: encrypted secrets. Values are sealed with libsodium secretbox; the
-- master key lives in a Docker secret file, never in the database or .env.
CREATE TABLE secrets (
  name        TEXT PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9_.-]{0,62}$'),
  nonce       BYTEA NOT NULL,
  ciphertext  BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
