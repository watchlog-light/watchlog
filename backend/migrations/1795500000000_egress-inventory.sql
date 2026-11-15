-- Up Migration
-- Egress watch's inventory (ADR-185, ADR-186, ADR-187, ADR-192): every external destination
-- each source talked to, when it was first and last used, and the expectations that cover
-- destinations. Community and Cloud alike; tenant tables with org_id, the composite key to
-- their cluster and Row-Level Security, as every tenant table (ADR-174). An insert that
-- leaves org_id out gets the connection's org (Cloud), or its cluster's from the trigger
-- (Community). Deleting a cluster deletes its rows.

-- A source, as its identity labels (jsonb, so equality is canonical whatever the key order):
--   Kubernetes: {"namespace", "workload_kind", "workload"} (flow series have no pod label);
--   Docker: {"compose_project", "compose_service"} when the container has them, so a
--   re-created container keeps its rows, otherwise {"host", "container"}.

-- One row per source, destination and port. `destination` is the flow series' `dst`: a DNS
-- name, a raw network (/24 or /48) or "Internet" (port 0: its series has no port).
-- `destination_class` tells the page and the rules what it is: a name, a single-label
-- (local) name, a public or private raw network, or "Internet" (slice 1's measurements:
-- private networks and local names are listed but don't raise "New external destination").
-- `first_seen_before`: the first sample was the oldest one retained when the inventory
-- started, so the destination is older than `first_seen` ("before <date>").
-- `approved_by`, `approved_at` and `pattern` copy the expectation that covers the row, for
-- the page (ADR-186). Rows last seen more than 90 days ago are deleted by the worker.
CREATE TABLE egress_destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  destination text NOT NULL CHECK (length(destination) BETWEEN 1 AND 300),
  dst_kind text NOT NULL CHECK (dst_kind IN ('external', 'internet')),
  port integer NOT NULL CHECK (port BETWEEN 0 AND 65535),
  destination_class text NOT NULL CHECK (destination_class IN (
    'name', 'local_name', 'public_network', 'private_network', 'internet'
  )),
  first_seen timestamptz NOT NULL,
  first_seen_before boolean NOT NULL DEFAULT false,
  last_seen timestamptz NOT NULL,
  approved_by uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_at timestamptz,
  pattern text CHECK (length(pattern) <= 300),
  CONSTRAINT egress_destinations_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE,
  CONSTRAINT egress_destinations_key UNIQUE (cluster_id, source, destination, port)
);
CREATE INDEX egress_destinations_last_seen_idx ON egress_destinations (org_id, last_seen);
CREATE INDEX egress_destinations_first_seen_idx ON egress_destinations (cluster_id, first_seen);
CREATE TRIGGER egress_destinations_org BEFORE INSERT ON egress_destinations
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();

-- When WatchLog first saw each source talk to an external destination: it starts the
-- source's learning period (ADR-187) and outlives rollouts and re-created containers.
-- `last_seen` lets the worker forget a source gone for 90 days.
CREATE TABLE egress_sources (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  PRIMARY KEY (cluster_id, source),
  CONSTRAINT egress_sources_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE INDEX egress_sources_last_seen_idx ON egress_sources (org_id, last_seen);
CREATE TRIGGER egress_sources_org BEFORE INSERT ON egress_sources
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();

-- Expected destinations (ADR-186): an exact name, `*.` and a suffix, or a CIDR; for one port
-- or any (NULL), for one source or every source (NULL). Kept until someone removes them,
-- never forgotten with the inventory. The matcher, routes and UI come in a later slice.
CREATE TABLE egress_expected (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  pattern text NOT NULL CHECK (length(pattern) BETWEEN 1 AND 300),
  port integer CHECK (port BETWEEN 1 AND 65535),
  source jsonb CHECK (source IS NULL OR jsonb_typeof(source) = 'object'),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  comment text CHECK (length(comment) <= 500),
  CONSTRAINT egress_expected_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX egress_expected_key ON egress_expected
  (cluster_id, pattern, coalesce(port, 0), coalesce(source, 'null'::jsonb));
CREATE TRIGGER egress_expected_org BEFORE INSERT ON egress_expected
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();

-- Per cluster: when the learning period of "New external destination" starts (ADR-187), and
-- when the first-seen look-back through the retained series ran (ADR-185). A cluster that
-- exists at the upgrade learns from the upgrade; one added later has NULL here and learns
-- from its first report (`first_seen_at`).
ALTER TABLE clusters
  ADD COLUMN egress_learning_since timestamptz,
  ADD COLUMN egress_backfilled_at timestamptz;
UPDATE clusters SET egress_learning_since = now();

ALTER TABLE egress_destinations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON egress_destinations
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE egress_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON egress_sources
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE egress_expected ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON egress_expected
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
