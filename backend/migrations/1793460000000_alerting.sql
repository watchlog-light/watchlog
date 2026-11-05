-- Up Migration
-- Phase 3 slice 1: alert rules, channels, states (one row per episode), the
-- notification outbox, silences and worker heartbeats (ADR-073…ADR-077, ADR-083, ADR-088).

CREATE TABLE alert_channels (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('slack', 'telegram', 'email', 'webhook')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- Settings that are not secret (recipients, chat id, bot name).
  config jsonb NOT NULL DEFAULT '{}',
  -- ADR-079: the secret fields as one AES-256-GCM ciphertext (`v1:…`).
  secret text,
  verified_at timestamptz,
  last_sent_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_channels_org_idx ON alert_channels (org_id);
CREATE TRIGGER alert_channels_set_updated_at BEFORE UPDATE ON alert_channels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE alert_rules (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  -- NULL: every cluster of the org.
  cluster_id uuid REFERENCES clusters (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type text NOT NULL CHECK (type IN ('default', 'threshold')),
  rule_key text CHECK (length(rule_key) <= 100),
  metric text CHECK (length(metric) <= 100),
  scope jsonb NOT NULL DEFAULT '{}',
  condition jsonb NOT NULL DEFAULT '{}',
  for_seconds integer NOT NULL DEFAULT 0 CHECK (for_seconds BETWEEN 0 AND 86400),
  -- 0: never re-notify.
  renotify_seconds integer NOT NULL DEFAULT 14400 CHECK (renotify_seconds BETWEEN 0 AND 604800),
  severity text NOT NULL CHECK (severity IN ('warning', 'critical')),
  enabled boolean NOT NULL DEFAULT true,
  channel_ids uuid[] NOT NULL DEFAULT '{}',
  -- Why the last evaluation failed; NULL when it succeeded.
  eval_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'default') = (rule_key IS NOT NULL))
);
CREATE UNIQUE INDEX alert_rules_org_key_idx ON alert_rules (org_id, rule_key) WHERE rule_key IS NOT NULL;
CREATE TRIGGER alert_rules_set_updated_at BEFORE UPDATE ON alert_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE alert_states (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES alert_rules (id) ON DELETE CASCADE,
  cluster_id uuid NOT NULL REFERENCES clusters (id) ON DELETE CASCADE,
  fingerprint text NOT NULL CHECK (length(fingerprint) BETWEEN 1 AND 1024),
  state text NOT NULL CHECK (state IN ('pending', 'firing', 'resolved')),
  severity text NOT NULL CHECK (severity IN ('warning', 'critical')),
  labels jsonb NOT NULL DEFAULT '{}',
  details jsonb NOT NULL DEFAULT '{}',
  -- Since when the condition holds (from the data when it says, else first sight).
  started_at timestamptz NOT NULL,
  fired_at timestamptz,
  resolved_at timestamptz,
  false_since timestamptz,
  false_cycles integer NOT NULL DEFAULT 0,
  last_notified_at timestamptz,
  notified_firing boolean NOT NULL DEFAULT false,
  silenced boolean NOT NULL DEFAULT false,
  flapping boolean NOT NULL DEFAULT false,
  notify_seq integer NOT NULL DEFAULT 0,
  -- Optimistic concurrency: a worker that lost its lock cannot write a second transition.
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX alert_states_open_idx ON alert_states (rule_id, cluster_id, fingerprint)
  WHERE state <> 'resolved';
CREATE INDEX alert_states_org_state_idx ON alert_states (org_id, state);
CREATE INDEX alert_states_fired_idx ON alert_states (rule_id, cluster_id, fingerprint, fired_at);
CREATE INDEX alert_states_resolved_idx ON alert_states (resolved_at) WHERE state = 'resolved';
CREATE TRIGGER alert_states_set_updated_at BEFORE UPDATE ON alert_states
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ADR-074: the outbox. One row per channel and message; a message can cover
-- several alerts of one rule and cluster (ADR-075).
CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES alert_channels (id) ON DELETE CASCADE,
  rule_id uuid REFERENCES alert_rules (id) ON DELETE SET NULL,
  cluster_id uuid REFERENCES clusters (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('firing', 'resolved', 'renotify', 'escalated', 'flapping', 'test')),
  payload jsonb NOT NULL,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) <= 200),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, dedupe_key)
);
CREATE INDEX notifications_due_idx ON notifications (next_attempt_at)
  WHERE status IN ('pending', 'sending');
CREATE INDEX notifications_finished_idx ON notifications (created_at)
  WHERE status IN ('sent', 'failed');
CREATE TRIGGER notifications_set_updated_at BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE notification_alerts (
  notification_id uuid NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  alert_state_id uuid NOT NULL REFERENCES alert_states (id) ON DELETE CASCADE,
  PRIMARY KEY (notification_id, alert_state_id)
);
CREATE INDEX notification_alerts_state_idx ON notification_alerts (alert_state_id);

CREATE TABLE silences (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  matchers jsonb NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  comment text NOT NULL DEFAULT '' CHECK (length(comment) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX silences_org_ends_idx ON silences (org_id, ends_at);
CREATE TRIGGER silences_set_updated_at BEFORE UPDATE ON silences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ADR-088: one row per running alert-worker. The lock connection's pid and start
-- time tell other workers whether it is alive (ADR-073).
CREATE TABLE alert_worker_heartbeats (
  worker_id text PRIMARY KEY CHECK (length(worker_id) <= 200),
  version text NOT NULL,
  started_at timestamptz NOT NULL,
  lock_pid integer,
  lock_backend_start timestamptz,
  buckets integer NOT NULL DEFAULT 0,
  last_cycle_at timestamptz,
  last_cycle_ms integer,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
