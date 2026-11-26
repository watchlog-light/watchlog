-- Up Migration
-- Undo and edit on the network pages (1.0.2):
--   paused      a device the user paused: not polled, its alerts rest, its history stays;
--   cert_prev   the certificate pinned before an Owner accepted a new one, so an accept made
--               by mistake can be undone (the device is paused again until an Owner decides).
ALTER TABLE network_devices DROP CONSTRAINT network_devices_status_check;
ALTER TABLE network_devices ADD CONSTRAINT network_devices_status_check
  CHECK (status IN ('pending', 'ok', 'unreachable', 'auth_failed', 'cert_changed', 'error',
                    'disconnected', 'provisioning', 'paused'));
ALTER TABLE network_devices ADD COLUMN cert_prev text;

-- Down Migration
UPDATE network_devices SET status = 'pending' WHERE status = 'paused';
ALTER TABLE network_devices DROP COLUMN cert_prev;
ALTER TABLE network_devices DROP CONSTRAINT network_devices_status_check;
ALTER TABLE network_devices ADD CONSTRAINT network_devices_status_check
  CHECK (status IN ('pending', 'ok', 'unreachable', 'auth_failed', 'cert_changed', 'error',
                    'disconnected', 'provisioning'));
