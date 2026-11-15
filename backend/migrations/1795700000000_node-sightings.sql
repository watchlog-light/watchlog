-- Up Migration
-- Trustworthy node counts (ADR-194, SR-8). The bill counted the agent instances whose
-- heartbeat fell in the hour, so an agent that changed its X-WatchLog-Agent header or its
-- heartbeat's mode, or sent no heartbeat, wasn't counted. Ingest now also records each
-- node and Docker host it sees in the written series (their `node` and `host` labels, the
-- cluster-agent's list of the Kubernetes API's Nodes included), once per cluster and hour.
-- Cloud only writes it; the worker deletes rows older than two days.
CREATE TABLE node_sightings (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  hour timestamptz NOT NULL CHECK (date_trunc('hour', hour) = hour),
  node text NOT NULL CHECK (length(node) BETWEEN 1 AND 4096),
  PRIMARY KEY (cluster_id, hour, node),
  CONSTRAINT node_sightings_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE INDEX node_sightings_hour_idx ON node_sightings (hour);
CREATE TRIGGER node_sightings_org BEFORE INSERT ON node_sightings
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();
ALTER TABLE node_sightings ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON node_sightings
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- Each hour keeps both counts, so a question about a bill can be answered: `reported_*`
-- from the agents' heartbeats (the count before this change), `observed_*` from the
-- sightings. `nodes` and `docker_hosts`, which the bill reads, are the higher of the two.
-- Hours recorded before this change were all reported counts.
ALTER TABLE usage_hourly
  ADD COLUMN reported_nodes integer NOT NULL DEFAULT 0 CHECK (reported_nodes >= 0),
  ADD COLUMN reported_docker_hosts integer NOT NULL DEFAULT 0 CHECK (reported_docker_hosts >= 0),
  ADD COLUMN observed_nodes integer NOT NULL DEFAULT 0 CHECK (observed_nodes >= 0),
  ADD COLUMN observed_docker_hosts integer NOT NULL DEFAULT 0 CHECK (observed_docker_hosts >= 0);
UPDATE usage_hourly SET reported_nodes = nodes, reported_docker_hosts = docker_hosts;
