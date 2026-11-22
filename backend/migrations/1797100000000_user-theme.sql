-- Up Migration
-- The dashboard's theme follows the user (0.12.0, ADR-228): System (the computer's setting,
-- the default), Light or Dark, chosen in the account menu and saved here so it is the same in
-- every browser. A change is audited like the other changes a user makes to their account.
ALTER TABLE users
  ADD COLUMN theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark'));

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
