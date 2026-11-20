-- Up Migration
-- Certificates and scheduled jobs (0.10.0, ADR-222 to ADR-224). The agents send each server's
-- or cluster's certificates and jobs as one inventory snapshot (`/ingest/v1/objects`,
-- `source: "inventory"`); the series the rules read go to VictoriaMetrics as usual. `node` is
-- the server the snapshot came from, '' for a cluster's. Tenant tables with org_id, the
-- composite key to their cluster and Row-Level Security (ADR-174). Only tables are added
-- (ADR-107): agents older than 0.10 send nothing here.

-- Every certificate (by fingerprint) seen under one identity (its names, cert_id); `current`
-- while the last snapshot still had it. A new fingerprint under the same identity while an
-- older one was current is a renewal: `renewed_from` and how many days before the older one
-- expired.
CREATE TABLE certificates (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  node text NOT NULL DEFAULT '' CHECK (length(node) <= 253),
  cert_id text NOT NULL CHECK (cert_id ~ '^[0-9a-f]{16}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  names text[] NOT NULL CHECK (cardinality(names) BETWEEN 1 AND 100),
  subject text NOT NULL DEFAULT '' CHECK (length(subject) <= 512),
  issuer text NOT NULL DEFAULT '' CHECK (length(issuer) <= 512),
  issuer_org text NOT NULL DEFAULT '' CHECK (length(issuer_org) <= 512),
  serial text NOT NULL DEFAULT '' CHECK (length(serial) <= 128),
  not_before timestamptz NOT NULL,
  not_after timestamptz NOT NULL,
  key_type text NOT NULL DEFAULT '' CHECK (length(key_type) <= 16),
  key_bits integer NOT NULL DEFAULT 0,
  chain text NOT NULL CHECK (chain IN ('complete', 'incomplete', 'private', 'self-signed')),
  name_mismatch text[] NOT NULL DEFAULT '{}',
  endpoints jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(endpoints) = 'array'),
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  current boolean NOT NULL DEFAULT true,
  renewed_from text CHECK (renewed_from IS NULL OR renewed_from ~ '^[0-9a-f]{64}$'),
  renewed_days_before real,
  PRIMARY KEY (cluster_id, node, cert_id, fingerprint),
  CONSTRAINT certificates_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE INDEX certificates_current_idx ON certificates (cluster_id, not_after) WHERE current;
CREATE INDEX certificates_org_idx ON certificates (org_id);
CREATE TRIGGER certificates_org BEFORE INSERT ON certificates
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();
ALTER TABLE certificates ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON certificates
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- What each snapshot could and couldn't read (the pages' "not covered"), and when it came.
CREATE TABLE inventory_coverage (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  node text NOT NULL DEFAULT '' CHECK (length(node) <= 253),
  certificates jsonb,
  jobs jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster_id, node),
  CONSTRAINT inventory_coverage_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE INDEX inventory_coverage_org_idx ON inventory_coverage (org_id);
CREATE TRIGGER inventory_coverage_org BEFORE INSERT ON inventory_coverage
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();
ALTER TABLE inventory_coverage ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON inventory_coverage
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- Each scheduled job as its agent last worked it out (state and its reasons). A job no
-- longer sent is `gone_at`, and deleted with its runs a week later.
CREATE TABLE scheduled_jobs (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  node text NOT NULL DEFAULT '' CHECK (length(node) <= 253),
  job_id text NOT NULL CHECK (job_id ~ '^[0-9a-f]{16}$'),
  kind text NOT NULL CHECK (kind IN ('timer', 'cron', 'cronjob')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 512),
  unit text NOT NULL DEFAULT '' CHECK (length(unit) <= 256),
  schedule text NOT NULL DEFAULT '' CHECK (length(schedule) <= 256),
  source text NOT NULL DEFAULT '' CHECK (length(source) <= 256),
  enabled boolean NOT NULL,
  persistent boolean NOT NULL DEFAULT false,
  random_delay_sec integer NOT NULL DEFAULT 0,
  next_at timestamptz,
  every_sec bigint NOT NULL DEFAULT 0,
  state text NOT NULL CHECK (state IN ('working', 'failed', 'missed', 'slow', 'running', 'disabled', 'new')),
  failed_streak integer NOT NULL DEFAULT 0,
  last_good_at timestamptz,
  missed_runs integer NOT NULL DEFAULT 0,
  missed_why text CHECK (missed_why IS NULL OR missed_why IN ('not-run', 'server-off', 'timer-off', 'agent-stopped')),
  missed_at timestamptz,
  usual_seconds real,
  frequent boolean NOT NULL DEFAULT false,
  first_seen timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  gone_at timestamptz,
  PRIMARY KEY (cluster_id, node, job_id),
  CONSTRAINT scheduled_jobs_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE INDEX scheduled_jobs_org_idx ON scheduled_jobs (org_id);
CREATE TRIGGER scheduled_jobs_org BEFORE INSERT ON scheduled_jobs
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();
ALTER TABLE scheduled_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON scheduled_jobs
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- A job's runs: 100 a job and 30 days; a job that runs every 5 minutes or more often keeps
-- its last 14 here and an hourly summary below (ADR-224).
CREATE TABLE job_runs (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  node text NOT NULL DEFAULT '' CHECK (length(node) <= 253),
  job_id text NOT NULL CHECK (job_id ~ '^[0-9a-f]{16}$'),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  code integer,
  result text NOT NULL CHECK (result IN ('success', 'failed', 'running', 'unknown')),
  PRIMARY KEY (cluster_id, node, job_id, started_at),
  CONSTRAINT job_runs_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE INDEX job_runs_org_idx ON job_runs (org_id);
CREATE TRIGGER job_runs_org BEFORE INSERT ON job_runs
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();
ALTER TABLE job_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON job_runs
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- Each job's runs per hour (counted when a run ends): runs, failures, the longest. 30 days.
CREATE TABLE job_run_hours (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  node text NOT NULL DEFAULT '' CHECK (length(node) <= 253),
  job_id text NOT NULL CHECK (job_id ~ '^[0-9a-f]{16}$'),
  hour timestamptz NOT NULL,
  runs integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  longest_seconds real NOT NULL DEFAULT 0,
  PRIMARY KEY (cluster_id, node, job_id, hour),
  CONSTRAINT job_run_hours_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE INDEX job_run_hours_org_idx ON job_run_hours (org_id);
CREATE TRIGGER job_run_hours_org BEFORE INSERT ON job_run_hours
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();
ALTER TABLE job_run_hours ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON job_run_hours
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
