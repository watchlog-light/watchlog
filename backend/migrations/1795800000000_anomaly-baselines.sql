-- Up Migration
-- What changed (0.8.0, ADR-196, ADR-198, ADR-204): the anomaly-worker's baselines, the
-- unusual periods it finds, and when each org started learning. Tenant tables with org_id,
-- the composite key to their cluster and Row-Level Security, as every tenant table
-- (ADR-174). Only the anomaly-worker writes them, and it runs only in Cloud and the live
-- demo (ADR-197): in Community they stay empty.

-- When an org was first seen with What changed (Pro, or the demo), and when it last had it.
-- Learning reads nothing older than `learning_since` (ADR-204). An org that lost it keeps its
-- baselines 30 days after `entitled_at`, so an upgrade back resumes; then the worker deletes
-- them and this row, and a later upgrade learns again from then.
CREATE TABLE anomaly_orgs (
  org_id uuid PRIMARY KEY DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid
    REFERENCES orgs (id) ON DELETE CASCADE,
  learning_since timestamptz NOT NULL,
  entitled_at timestamptz NOT NULL
);

-- One row per series: the catalog key (or the map edge's key) and its subject labels,
-- hashed into `series_hash` (sha256 of the key and the subject's canonical JSON). The median
-- and MAD of each hour of the week (UTC, Sunday 00:00 is element 1) over the last 14 days,
-- and the minutes behind each (0: not computed yet). The hourly recompute rewrites one
-- element of each array: `fillfactor` 70 leaves room on the page so the update stays HOT
-- (slice 1: 2,172 bytes a row with its index, 180,000 rows at 1,000 nodes).
CREATE TABLE anomaly_baselines (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  series_hash bytea NOT NULL CHECK (length(series_hash) = 32),
  metric text NOT NULL CHECK (length(metric) BETWEEN 1 AND 100),
  subject jsonb NOT NULL CHECK (jsonb_typeof(subject) = 'object'),
  medians real[] NOT NULL CHECK (cardinality(medians) = 168),
  mads real[] NOT NULL CHECK (cardinality(mads) = 168),
  minutes smallint[] NOT NULL CHECK (cardinality(minutes) = 168),
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  PRIMARY KEY (cluster_id, series_hash),
  CONSTRAINT anomaly_baselines_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
) WITH (fillfactor = 70);
CREATE INDEX anomaly_baselines_org_idx ON anomaly_baselines (org_id);
CREATE TRIGGER anomaly_baselines_org BEFORE INSERT ON anomaly_baselines
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();

-- Unusual periods (ADR-198): a series past score 4 for 10 minutes, until 10 minutes at 4 or
-- less. `bucket`, `median`, `usual_low` and `usual_high` are the usual range at the start's
-- hour; `peak_*` the furthest minute; `last_*` the latest minute while it lasts. The page
-- (slice 3), the anomaly alerts (slice 4) and the API read these rows; kept for the org's
-- retention. At most one open period per series.
CREATE TABLE anomaly_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  series_hash bytea NOT NULL CHECK (length(series_hash) = 32),
  metric text NOT NULL CHECK (length(metric) BETWEEN 1 AND 100),
  subject jsonb NOT NULL CHECK (jsonb_typeof(subject) = 'object'),
  started_at timestamptz NOT NULL,
  ended_at timestamptz CHECK (ended_at IS NULL OR ended_at >= started_at),
  bucket smallint NOT NULL CHECK (bucket BETWEEN 0 AND 167),
  median double precision NOT NULL,
  usual_low double precision NOT NULL,
  usual_high double precision NOT NULL,
  peak_score real NOT NULL,
  peak_value double precision NOT NULL,
  peak_at timestamptz NOT NULL,
  last_value double precision NOT NULL,
  last_at timestamptz NOT NULL,
  CONSTRAINT anomaly_periods_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX anomaly_periods_open_key ON anomaly_periods (cluster_id, series_hash)
  WHERE ended_at IS NULL;
CREATE INDEX anomaly_periods_started_idx ON anomaly_periods (cluster_id, started_at);
CREATE INDEX anomaly_periods_org_idx ON anomaly_periods (org_id, started_at);
CREATE TRIGGER anomaly_periods_org BEFORE INSERT ON anomaly_periods
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();

ALTER TABLE anomaly_orgs ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON anomaly_orgs
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE anomaly_baselines ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON anomaly_baselines
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE anomaly_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON anomaly_periods
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
