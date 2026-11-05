-- Up Migration
-- Phase 1 slice 5: one row per agent (Docker host or node), updated by heartbeats (ADR-029).

CREATE TABLE agent_instances (
  id uuid PRIMARY KEY,
  cluster_id uuid NOT NULL REFERENCES clusters (id) ON DELETE CASCADE,
  node text NOT NULL CHECK (length(node) BETWEEN 1 AND 253),
  mode text NOT NULL CHECK (mode IN ('node', 'cluster', 'docker')),
  agent_version text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}',
  series integer NOT NULL DEFAULT 0 CHECK (series >= 0),
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cluster_id, node)
);
CREATE INDEX agent_instances_cluster_last_seen_idx ON agent_instances (cluster_id, last_seen_at);

CREATE TRIGGER agent_instances_set_updated_at BEFORE UPDATE ON agent_instances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
