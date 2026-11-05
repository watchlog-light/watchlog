-- Up Migration
-- ADR-069 (as accepted): hashes of the tokens of deleted clusters. The Helm chart's
-- bootstrap token stays in the backend's environment after the user deletes its
-- cluster in Settings; a retired hash keeps a restart from recreating the cluster.

CREATE TABLE retired_cluster_tokens (
  token_hash bytea PRIMARY KEY,
  retired_at timestamptz NOT NULL DEFAULT now()
);
