-- Up Migration
-- Alerts redesign: settings made in the UI for this installation: the public address,
-- the email server (SMTP) and Telegram's outbound proxy. Environment variables still
-- override them. Secret parts (the SMTP password) are AES-GCM ciphertexts (ADR-079).

CREATE TABLE server_settings (
  key text PRIMARY KEY CHECK (key IN ('general', 'smtp', 'telegram')),
  value jsonb NOT NULL DEFAULT '{}',
  secret text,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
