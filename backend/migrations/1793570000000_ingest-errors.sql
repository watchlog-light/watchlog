-- Up Migration
-- Ingest errors per cluster and endpoint (ADR-117). A request the backend answered with
-- an error (5xx, 413, 400) used to leave no trace but the agent's log: the namespace-
-- marker 500 held back pod changes for days unnoticed. failing_since is the first error
-- after the last success; a success clears it. The overview and Settings show it, and
-- the default rule "WatchLog ingest failing" fires after 5 minutes.

CREATE TABLE ingest_errors (
  cluster_id uuid NOT NULL REFERENCES clusters (id) ON DELETE CASCADE,
  endpoint text NOT NULL CHECK (endpoint IN ('write', 'heartbeat', 'objects', 'events')),
  failing_since timestamptz,
  last_error_at timestamptz NOT NULL,
  last_status integer NOT NULL,
  last_message text NOT NULL DEFAULT '',
  failures bigint NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  PRIMARY KEY (cluster_id, endpoint)
);
