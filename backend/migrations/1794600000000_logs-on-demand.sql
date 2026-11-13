-- Up Migration
-- Container logs on demand (ADR-167): the Settings switch (who may read) and one audit row
-- per read (who, which container, how many lines; never the lines).
ALTER TABLE server_settings DROP CONSTRAINT server_settings_key_check;
ALTER TABLE server_settings ADD CONSTRAINT server_settings_key_check
  CHECK (key IN ('general', 'smtp', 'telegram', 'namespaces', 'logs'));

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
  'invite_created', 'invite_copied', 'invite_renewed', 'invite_revoked', 'invite_accepted',
  'role_changed', 'reset_link_created', 'password_reset', 'user_removed', 'ownership_transferred',
  'logs_read'
));
