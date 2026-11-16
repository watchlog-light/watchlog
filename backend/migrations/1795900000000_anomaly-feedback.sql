-- Up Migration
-- What changed's anomaly alerts (0.8.0, ADR-200): "Was this worth an alert?". Each answer an
-- Owner or Admin gives on an anomaly alert, kept by series and hour of the week. "No, this is
-- normal for us" (`normal`) widens that series' usual range in that hour so the value it
-- reached scores 4 or less: `min_spread` is the spread the anomaly-worker uses at least there
-- (the reached distance from the median over the score). "Yes, keep alerting" (`useful`) is
-- stored for tuning. An answer is undone by setting `undone_at`; the worker reads only the
-- answers not undone. A tenant table with org_id, the composite key to its cluster and
-- Row-Level Security (ADR-174). Answers are audited (audit_events, below).
CREATE TABLE anomaly_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  series_hash bytea NOT NULL CHECK (length(series_hash) = 32),
  metric text NOT NULL CHECK (length(metric) BETWEEN 1 AND 100),
  subject jsonb NOT NULL CHECK (jsonb_typeof(subject) = 'object'),
  bucket smallint NOT NULL CHECK (bucket BETWEEN 0 AND 167),
  answer text NOT NULL CHECK (answer IN ('useful', 'normal')),
  -- The anomaly alert answered (no foreign key: resolved alerts are pruned, answers stay).
  alert_id uuid,
  -- `normal` only: the value reached, the bucket's median then, and the spread kept from now.
  value double precision,
  median double precision,
  min_spread double precision CHECK (min_spread IS NULL OR min_spread > 0),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by_name text CHECK (length(created_by_name) <= 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_by uuid REFERENCES users (id) ON DELETE SET NULL,
  undone_by_name text CHECK (length(undone_by_name) <= 256),
  undone_at timestamptz,
  CHECK (answer = 'useful' OR min_spread IS NOT NULL),
  CONSTRAINT anomaly_feedback_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE INDEX anomaly_feedback_series_idx ON anomaly_feedback (cluster_id, series_hash, bucket)
  WHERE undone_at IS NULL;
CREATE INDEX anomaly_feedback_alert_idx ON anomaly_feedback (alert_id);
CREATE INDEX anomaly_feedback_org_idx ON anomaly_feedback (org_id);
CREATE TRIGGER anomaly_feedback_org BEFORE INSERT ON anomaly_feedback
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();

ALTER TABLE anomaly_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON anomaly_feedback
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- The anomaly rule is added only to orgs with What changed (ADR-200). An org that loses it has
-- the rule turned off by the upkeep, which marks it here so that getting Pro back turns it on
-- again, while a rule the org turned off itself stays off.
ALTER TABLE alert_rules ADD COLUMN plan_paused boolean NOT NULL DEFAULT false;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
  'invite_created', 'invite_copied', 'invite_renewed', 'invite_revoked', 'invite_accepted',
  'role_changed', 'reset_link_created', 'password_reset', 'user_removed', 'ownership_transferred',
  'logs_read',
  'staff_entitlements_set', 'staff_org_suspended', 'staff_org_unsuspended',
  'support_session_started', 'support_session_ended', 'support_tokens_accessed',
  'org_exported', 'org_deletion_requested', 'org_deletion_cancelled',
  'org_inactive_warned', 'org_inactive_suspended', 'org_reactivated',
  'egress_expected_added', 'egress_expected_removed',
  'anomaly_feedback_given', 'anomaly_feedback_undone'
));
