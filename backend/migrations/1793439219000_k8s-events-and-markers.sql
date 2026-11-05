-- Up Migration
-- Phase 2 slice 3 (ADR-061): Kubernetes events, de-duplicated per day by involved
-- object and reason, in daily range partitions (created and dropped by the
-- backend's maintenance job); change markers derived from object changes.
-- k8s_events has no id column: a partitioned table's key must include the
-- partition column, so the natural key is the primary key.

CREATE TABLE k8s_events (
  cluster_id uuid NOT NULL REFERENCES clusters (id) ON DELETE CASCADE,
  day date NOT NULL,
  -- The involved object's uid, or kind/namespace/name when the event has none.
  involved_key text NOT NULL CHECK (length(involved_key) BETWEEN 1 AND 640),
  reason text NOT NULL CHECK (length(reason) <= 128),
  namespace text NOT NULL DEFAULT '',
  involved_kind text NOT NULL DEFAULT '',
  involved_name text NOT NULL DEFAULT '',
  involved_uid text NOT NULL DEFAULT '',
  type text NOT NULL CHECK (length(type) <= 32),
  message text NOT NULL DEFAULT '',
  -- Sum of event_counts: each Kubernetes Event object (uid) with its latest count,
  -- so re-sent events are not counted twice.
  count integer NOT NULL,
  event_counts jsonb NOT NULL DEFAULT '{}',
  first_ts timestamptz NOT NULL,
  last_ts timestamptz NOT NULL,
  reporting_controller text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster_id, day, involved_key, reason)
) PARTITION BY RANGE (day);
CREATE INDEX k8s_events_cluster_last_idx ON k8s_events (cluster_id, last_ts DESC);
CREATE INDEX k8s_events_involved_idx ON k8s_events (cluster_id, involved_uid);

CREATE TABLE change_markers (
  id uuid PRIMARY KEY,
  cluster_id uuid NOT NULL REFERENCES clusters (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('rollout', 'image', 'scale', 'node')),
  -- "Deployment/<namespace>/<name>" or "Node/<name>".
  target text NOT NULL CHECK (length(target) <= 600),
  namespace text NOT NULL DEFAULT '',
  details jsonb NOT NULL DEFAULT '{}',
  ts timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_markers_cluster_ts_idx ON change_markers (cluster_id, ts DESC);
