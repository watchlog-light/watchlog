-- Up Migration
-- Egress watch (ADR-186): marking a destination expected and removing an expectation are
-- audited like every other change an Owner or Admin makes.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
  'invite_created', 'invite_copied', 'invite_renewed', 'invite_revoked', 'invite_accepted',
  'role_changed', 'reset_link_created', 'password_reset', 'user_removed', 'ownership_transferred',
  'logs_read',
  'staff_entitlements_set', 'staff_org_suspended', 'staff_org_unsuspended',
  'support_session_started', 'support_session_ended', 'support_tokens_accessed',
  'org_exported', 'org_deletion_requested', 'org_deletion_cancelled',
  'org_inactive_warned', 'org_inactive_suspended', 'org_reactivated',
  'egress_expected_added', 'egress_expected_removed'
));
