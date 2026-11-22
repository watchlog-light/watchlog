-- Up Migration
-- What changed's live map (0.14.0, ADR-231): the anomaly-worker's last scoring of each
-- cluster or fleet, one row per cluster, rewritten every minute. `series` is a compact array,
-- one element per scored series: [key, subject, value, usual low, usual high, score, open],
-- with `open` true while the series has an unusual period. `learning` counts the series that
-- have a baseline but haven't learned their week yet (not shown). The page reads this row in
-- one query every 60 s; nothing is scored on request. A tenant table as every other
-- (ADR-174): org_id, the composite key to its cluster, Row-Level Security.
CREATE TABLE anomaly_live (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid PRIMARY KEY,
  scored_at timestamptz NOT NULL,
  learning integer NOT NULL DEFAULT 0 CHECK (learning >= 0),
  series jsonb NOT NULL CHECK (jsonb_typeof(series) = 'array'),
  CONSTRAINT anomaly_live_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE INDEX anomaly_live_org_idx ON anomaly_live (org_id);
CREATE TRIGGER anomaly_live_org BEFORE INSERT ON anomaly_live
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();
ALTER TABLE anomaly_live ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON anomaly_live
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
