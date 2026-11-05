-- Up Migration
-- Phase 3 slice 4. ADR-079: a canary encrypted with WATCHLOG_SECRET_KEY on first start,
-- so a wrong key is caught before it meets a stored secret. ADR-080: open Telegram
-- deep-link verifications (one-time code, 10 minutes).

CREATE TABLE secret_key_check (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  canary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE telegram_verifications (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES alert_channels (id) ON DELETE CASCADE,
  code_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  -- getUpdates offset already read for this verification.
  update_offset bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_verifications_channel_idx ON telegram_verifications (channel_id);
