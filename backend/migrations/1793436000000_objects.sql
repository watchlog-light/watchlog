-- Up Migration
-- Phase 1 slice 7: inventory of Docker hosts and containers (Kubernetes objects from Phase 2), ADR-029.
-- `node` (the host/node an object runs on) is an addition to SPEC §7.

CREATE TABLE objects (
  id uuid PRIMARY KEY,
  cluster_id uuid NOT NULL REFERENCES clusters (id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('kubernetes', 'docker')),
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 63),
  namespace text NOT NULL DEFAULT '',
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 253),
  uid text NOT NULL CHECK (length(uid) BETWEEN 1 AND 128),
  node text NOT NULL DEFAULT '',
  spec_summary jsonb NOT NULL DEFAULT '{}',
  status_summary jsonb NOT NULL DEFAULT '{}',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cluster_id, uid)
);
CREATE INDEX objects_cluster_kind_live_idx ON objects (cluster_id, kind) WHERE deleted_at IS NULL;
CREATE INDEX objects_cluster_node_idx ON objects (cluster_id, node);

CREATE TRIGGER objects_set_updated_at BEFORE UPDATE ON objects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
