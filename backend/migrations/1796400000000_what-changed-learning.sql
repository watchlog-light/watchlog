-- Up Migration
-- What changed's learning week, shown (0.9.4, ADR-216): what the learning page reads, and who
-- asked for an email when it is ready. Tenant tables with org_id, the composite key to their
-- cluster and Row-Level Security, as every tenant table (ADR-174). Like the baselines, they
-- stay empty in Community.

-- One row per cluster or fleet, written by the anomaly-worker with each hourly recompute, so
-- the page reads one small row and never scans the baselines:
--   hours: per hour of the week (UTC, Sunday 00:00 is element 1, as anomaly_baselines), how
--     many series have a baseline for it (minutes behind it); 0 is "not seen yet";
--   series, series_learning, learning_until: the series read in the last hourly run, how many
--     of them are still inside their own 7 days, and when the last of those is ready;
--   first_seen: the cluster's earliest series (its learning starts there, ADR-204);
--   breakdown: the series' objects counted in the kind's words (nodes and workloads; servers,
--     services, process groups and containers; applications).
CREATE TABLE anomaly_learning (
  cluster_id uuid PRIMARY KEY,
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  hours integer[] NOT NULL CHECK (cardinality(hours) = 168),
  series integer NOT NULL DEFAULT 0 CHECK (series >= 0),
  series_learning integer NOT NULL DEFAULT 0 CHECK (series_learning >= 0),
  learning_until timestamptz,
  first_seen timestamptz,
  breakdown jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(breakdown) = 'object'),
  updated_at timestamptz NOT NULL,
  CONSTRAINT anomaly_learning_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE INDEX anomaly_learning_org_idx ON anomaly_learning (org_id);
CREATE TRIGGER anomaly_learning_org BEFORE INSERT ON anomaly_learning
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();
ALTER TABLE anomaly_learning ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON anomaly_learning
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- "Email me when it's ready": a member's own choice for one cluster or fleet, undone by
-- deleting the row. The worker's lifecycle task sends one email when the cluster's first
-- baseline is 7 days old and sets sent_at, so it is never sent twice.
CREATE TABLE anomaly_ready_emails (
  cluster_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  PRIMARY KEY (cluster_id, user_id),
  CONSTRAINT anomaly_ready_emails_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE INDEX anomaly_ready_emails_org_idx ON anomaly_ready_emails (org_id);
CREATE INDEX anomaly_ready_emails_user_idx ON anomaly_ready_emails (user_id);
CREATE INDEX anomaly_ready_emails_pending_idx ON anomaly_ready_emails (cluster_id)
  WHERE sent_at IS NULL;
CREATE TRIGGER anomaly_ready_emails_org BEFORE INSERT ON anomaly_ready_emails
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();
ALTER TABLE anomaly_ready_emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON anomaly_ready_emails
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
