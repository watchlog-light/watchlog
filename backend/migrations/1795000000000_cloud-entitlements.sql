-- Up Migration
-- Plans and entitlements in Cloud (ADR-177): what each org may use, the hourly node counts
-- the bill's 95th percentile comes from, and the limits an org ran into.
--
-- Community never writes any of these tables: it has no entitlements row, no limits and no
-- usage job (ADR-151). All three are tenant tables, with org_id and Row-Level Security
-- (ADR-174).

-- The limits, completed (slice 2a made the row with the plan and its source). NULL means
-- unlimited. `grace_until`: after a downgrade, nodes and clusters already sending keep
-- sending until then (14 days). `previous_retention_days` and `retention_changed_at`: the
-- tier the org's metrics were written to before its last plan change, read beside the
-- current one until that tier's retention has run out.
ALTER TABLE entitlements
  ADD COLUMN clusters integer CHECK (clusters IS NULL OR clusters >= 0),
  ADD COLUMN nodes integer CHECK (nodes IS NULL OR nodes >= 0),
  ADD COLUMN users integer CHECK (users IS NULL OR users >= 1),
  ADD COLUMN retention_days integer NOT NULL DEFAULT 3 CHECK (retention_days BETWEEN 1 AND 3660),
  ADD COLUMN pro_features boolean NOT NULL DEFAULT false,
  ADD COLUMN beta_until timestamptz,
  ADD COLUMN grace_until timestamptz,
  ADD COLUMN previous_retention_days integer
    CHECK (previous_retention_days IS NULL OR previous_retention_days BETWEEN 1 AND 3660),
  ADD COLUMN retention_changed_at timestamptz;

-- The plans' defaults (ADR-177) for the rows signup made before this migration.
UPDATE entitlements SET clusters = 1, nodes = 5, users = 1, retention_days = 3,
  pro_features = false WHERE plan = 'free';
UPDATE entitlements SET clusters = NULL, nodes = NULL, users = 10, retention_days = 30,
  pro_features = true WHERE plan = 'pro';
UPDATE entitlements SET clusters = NULL, nodes = NULL, users = NULL, retention_days = 30,
  pro_features = true WHERE plan = 'enterprise';

-- Each org's distinct sending nodes (Kubernetes node agents) and Docker hosts per hour,
-- written by the alert worker's usage job (ADR-177). An hour without a row had none.
CREATE TABLE usage_hourly (
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  hour timestamptz NOT NULL CHECK (date_trunc('hour', hour) = hour),
  nodes integer NOT NULL DEFAULT 0 CHECK (nodes >= 0),
  docker_hosts integer NOT NULL DEFAULT 0 CHECK (docker_hosts >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, hour)
);
ALTER TABLE usage_hourly ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON usage_hourly
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- A limit the org ran into, once per subject and day: `nodes` (an agent instance refused
-- with 402; subject = cluster id and node), `clusters` (POST /clusters answered 409) and
-- `users` (an invite answered 409). The banner counts them; the Owners' email is claimed
-- in `emailed_at` (one per limit and day).
CREATE TABLE plan_limit_hits (
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('nodes', 'clusters', 'users')),
  subject text NOT NULL DEFAULT '' CHECK (length(subject) <= 400),
  day date NOT NULL,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, kind, day, subject)
);
ALTER TABLE plan_limit_hits ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON plan_limit_hits
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

CREATE TABLE plan_limit_emails (
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('nodes', 'clusters', 'users')),
  day date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, kind, day)
);
ALTER TABLE plan_limit_emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON plan_limit_emails
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- The node gate's and the usage job's read: an org's agents seen recently.
CREATE INDEX agent_instances_org_last_seen_idx ON agent_instances (org_id, last_seen_at);
