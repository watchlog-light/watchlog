-- Up Migration
-- The Enterprise licence (0.15.0, ADR-232), self-hosted only. A key pasted in Settings →
-- License is the installation's setting (`server_settings`, key 'license', ADR-093), kept
-- encrypted in `secret`; WATCHLOG_LICENSE or WATCHLOG_LICENSE_FILE wins over it. Setting and
-- removing it are audited. `license_notices` remembers the one email each key gets 30 days
-- before it ends, so a restart or a second worker never sends it twice. Both belong to the
-- installation, not an org (as server_settings), so neither has org_id or Row-Level Security.
ALTER TABLE server_settings DROP CONSTRAINT server_settings_key_check;
ALTER TABLE server_settings ADD CONSTRAINT server_settings_key_check
  CHECK (key IN ('general', 'smtp', 'telegram', 'namespaces', 'logs', 'license'));

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
  'anomaly_feedback_given', 'anomaly_feedback_undone',
  'preferences_changed',
  'license_set', 'license_removed'
));

CREATE TABLE license_notices (
  license_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('expiring')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (license_id, kind)
);

-- Down Migration
DROP TABLE license_notices;
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
  'anomaly_feedback_given', 'anomaly_feedback_undone',
  'preferences_changed'
));
ALTER TABLE server_settings DROP CONSTRAINT server_settings_key_check;
ALTER TABLE server_settings ADD CONSTRAINT server_settings_key_check
  CHECK (key IN ('general', 'smtp', 'telegram', 'namespaces', 'logs'));
