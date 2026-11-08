-- Up Migration
-- The MCP call log (ADR-127): one row per tool call with an API token, so a user can see
-- what their AI assistant read. Never the output: the tool, a short summary of its
-- arguments, how it went, how long it took and how big the answer was. Rows are kept
-- 30 days (the alert-worker deletes older ones) and go with their token. A new table:
-- nothing to do on existing installs (ADR-107).

CREATE TABLE mcp_calls (
  id uuid PRIMARY KEY,
  token_id uuid NOT NULL REFERENCES api_tokens (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  tool text NOT NULL CHECK (length(tool) BETWEEN 1 AND 64),
  -- Written by WatchLog from the arguments, capped; shown in Settings → API tokens.
  args text NOT NULL DEFAULT '' CHECK (length(args) <= 200),
  status text NOT NULL CHECK (status IN ('ok', 'truncated', 'rate_limited', 'error')),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  bytes integer NOT NULL CHECK (bytes >= 0)
);
CREATE INDEX mcp_calls_token_id_at_idx ON mcp_calls (token_id, at DESC);
CREATE INDEX mcp_calls_at_idx ON mcp_calls (at);
