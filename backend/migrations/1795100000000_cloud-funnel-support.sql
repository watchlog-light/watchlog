-- Up Migration
-- The funnel, the lifecycle emails, the Cloud admin's writes and support mode (ADR-179).
--
-- Community never writes any of these: the funnel, the lifecycle emails, the internal admin
-- API and support mode are Cloud only. The tenant tables carry org_id and Row-Level
-- Security (ADR-174).

-- Funnel events (SPEC §10.4). `once_key` makes a one-time event unique in the database:
-- '' for once per org, 'user:<id>' for once per user, 'cluster:<id>' for once per cluster;
-- NULL for events that may repeat (a copied command, a cluster created).
CREATE TABLE funnel_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  name text NOT NULL CHECK (name ~ '^[a-z0-9_]{1,64}$'),
  props jsonb NOT NULL DEFAULT '{}'::jsonb,
  once_key text CHECK (length(once_key) <= 80),
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX funnel_events_once_idx ON funnel_events (org_id, name, once_key)
  WHERE once_key IS NOT NULL;
CREATE INDEX funnel_events_name_ts_idx ON funnel_events (name, ts);
ALTER TABLE funnel_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON funnel_events
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- Lifecycle emails sent: one row per user and kind, so none is sent twice. The org is the
-- one the email was about (the user's signup org, or the org whose billing changes).
CREATE TABLE lifecycle_emails (
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'welcome', 'no_data', 'first_alert', 'day3_tips', 'near_limit', 'beta_notice'
  )),
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);
CREATE INDEX lifecycle_emails_user_sent_idx ON lifecycle_emails (user_id, sent_at);
CREATE INDEX lifecycle_emails_org_idx ON lifecycle_emails (org_id);
ALTER TABLE lifecycle_emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON lifecycle_emails
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- The beta-to-billing notice is sent only when billing asks for it (the internal API):
-- one row per org, with the day billing starts.
CREATE TABLE beta_notices (
  org_id uuid PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
  billing_starts_at timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE beta_notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON beta_notices
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- One-click unsubscribe from the lifecycle emails (a user's choice, across orgs).
ALTER TABLE users ADD COLUMN lifecycle_unsubscribed_at timestamptz;

-- Staff can suspend an org (the internal admin API): ingest answers 402, sign-in still
-- works so its Owners can read, export or delete.
ALTER TABLE orgs
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN suspended_reason text CHECK (length(suspended_reason) <= 500);

-- Support sessions (ADR-179): staff open one for one org with a reason; read-only, at most
-- an hour. The sign-in code (one use, 2 minutes) and the browser token are stored as
-- SHA-256 only.
CREATE TABLE support_sessions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  staff_email text NOT NULL CHECK (length(staff_email) <= 254),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  code_hash bytea UNIQUE,
  code_expires_at timestamptz NOT NULL,
  token_hash bytea UNIQUE,
  entered_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  CHECK (expires_at <= started_at + interval '1 hour')
);
CREATE INDEX support_sessions_org_idx ON support_sessions (org_id, started_at DESC);
ALTER TABLE support_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON support_sessions
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- What a support session opened: each API path (ids included, never the query string),
-- once, with how often.
CREATE TABLE support_session_views (
  session_id uuid NOT NULL REFERENCES support_sessions (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  path text NOT NULL CHECK (length(path) <= 300),
  first_at timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, path)
);
ALTER TABLE support_session_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON support_session_views
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- The staff's writes and support sessions in the org's audit events, and tokens read in
-- support mode ("accessed by WatchLog staff").
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
  'invite_created', 'invite_copied', 'invite_renewed', 'invite_revoked', 'invite_accepted',
  'role_changed', 'reset_link_created', 'password_reset', 'user_removed', 'ownership_transferred',
  'logs_read',
  'staff_entitlements_set', 'staff_org_suspended', 'staff_org_unsuspended',
  'support_session_started', 'support_session_ended', 'support_tokens_accessed'
));
ALTER TABLE api_token_events DROP CONSTRAINT api_token_events_kind_check;
ALTER TABLE api_token_events ADD CONSTRAINT api_token_events_kind_check CHECK (
  kind IN ('created', 'first_use', 'new_ip', 'expired', 'revoked', 'reminder_sent', 'staff_access')
);
-- A token's history says each support session that read it, not just the first.
DROP INDEX api_token_events_once_idx;
CREATE UNIQUE INDEX api_token_events_once_idx ON api_token_events (token_id, kind)
  WHERE kind NOT IN ('new_ip', 'staff_access');
