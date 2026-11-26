-- Up Migration
-- An Enterprise module's changes are in the audit trail too (1.0.2): the network module's
-- credential profiles and devices, named `network_<what happened>`. The core lists its own
-- actions as before and lets a module's through by its prefix, so a module adds an action
-- without a core migration.
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
) OR action ~ '^network_[a-z_]{1,48}$');

-- Down Migration
DELETE FROM audit_events WHERE action ~ '^network_';
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
