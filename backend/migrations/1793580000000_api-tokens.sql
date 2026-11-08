-- Up Migration
-- Personal API tokens (ADR-125): `wl_pat_` + 256 random bits, stored as SHA-256 like
-- cluster tokens (ADR-040), read scope only. A token belongs to a user in an org and acts
-- as that user. Expired and revoked tokens stay listed for 30 days, then the alert-worker
-- deletes them with their history. A new table: nothing to do on existing installs (ADR-107).

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  token_hash bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  -- For display only ("wl_pat_7Kq2…"); not unique, never used to look a token up.
  prefix text NOT NULL CHECK (prefix ~ '^wl_pat_[A-Za-z0-9_-]{4}$'),
  scope text NOT NULL DEFAULT 'read' CHECK (scope IN ('read')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- NULL: never expires.
  expires_at timestamptz,
  -- Written at most once a minute per token.
  last_used_at timestamptz,
  -- Shortened to its /24 (IPv4) or /48 (IPv6) once the token is expired or revoked.
  last_used_ip inet,
  -- Only from a trusted proxy's country header (WATCHLOG_CLIENT_COUNTRY_HEADER).
  last_used_country text CHECK (last_used_country ~ '^[A-Z0-9]{2}$'),
  -- Last use of the REST API (MCP calls are logged apart).
  used_rest_at timestamptz,
  -- The expiry reminder email went out (once per token).
  reminded_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX api_tokens_user_id_idx ON api_tokens (user_id);
CREATE INDEX api_tokens_org_id_idx ON api_tokens (org_id);
CREATE INDEX api_tokens_expires_at_idx ON api_tokens (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX api_tokens_revoked_at_idx ON api_tokens (revoked_at) WHERE revoked_at IS NOT NULL;

CREATE TRIGGER api_tokens_set_updated_at BEFORE UPDATE ON api_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A token's history, shown on its row: not the general audit log (Enterprise, SPEC §4.10).
CREATE TABLE api_token_events (
  id uuid PRIMARY KEY,
  token_id uuid NOT NULL REFERENCES api_tokens (id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (
    kind IN ('created', 'first_use', 'new_ip', 'expired', 'revoked', 'reminder_sent')
  ),
  ip inet,
  country text CHECK (country ~ '^[A-Z0-9]{2}$'),
  detail jsonb
);
CREATE INDEX api_token_events_token_id_idx ON api_token_events (token_id, at DESC);
-- Every kind but new_ip happens at most once per token, also with several replicas.
CREATE UNIQUE INDEX api_token_events_once_idx ON api_token_events (token_id, kind)
  WHERE kind <> 'new_ip';
-- An address is recorded once per token: its first use, or a later first use from it.
CREATE UNIQUE INDEX api_token_events_ip_idx ON api_token_events (token_id, ip)
  WHERE kind IN ('first_use', 'new_ip');
