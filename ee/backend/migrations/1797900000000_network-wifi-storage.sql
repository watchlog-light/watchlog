-- Up Migration
-- Network devices, part 2 (ee/, ADR-234): Wi-Fi access points and their clients, storage
-- (a NAS's iSCSI sessions), recorders and UPSes. Tenant tables, as 0.16's (ADR-174).

-- Recorders are read over their HTTP API (protocol 'dahua'). Access points aren't polled:
-- the controller that manages them reports them (protocol 'capsman', parent_id the
-- controller, managed_ap true: free, not a unit).
ALTER TABLE network_devices DROP CONSTRAINT network_devices_protocol_check;
ALTER TABLE network_devices ADD CONSTRAINT network_devices_protocol_check
  CHECK (protocol IN ('snmp', 'routeros', 'dahua', 'capsman'));
ALTER TABLE network_devices DROP CONSTRAINT network_devices_status_check;
ALTER TABLE network_devices ADD CONSTRAINT network_devices_status_check
  CHECK (status IN ('pending', 'ok', 'unreachable', 'auth_failed', 'cert_changed', 'error',
                    'disconnected', 'provisioning'));
ALTER TABLE network_credentials DROP CONSTRAINT network_credentials_protocol_check;
ALTER TABLE network_credentials ADD CONSTRAINT network_credentials_protocol_check
  CHECK (protocol IN ('snmp', 'routeros', 'dahua'));
ALTER TABLE network_devices
  ADD COLUMN parent_id uuid REFERENCES network_devices (id) ON DELETE CASCADE,
  -- The device's own MAC address when it has no ports of its own to read (a recorder, an access
  -- point): the switch port it is behind comes from the MAC tables.
  ADD COLUMN mac macaddr,
  -- A UPS: the WatchLog servers and nodes it feeds ([{clusterId, node}]), set on its page.
  ADD COLUMN feeds jsonb NOT NULL DEFAULT '[]',
  -- A recorder: its three signals and since when each has failed (ADR-234).
  ADD COLUMN recording jsonb NOT NULL DEFAULT '{}',
  -- When this device's status last changed (an access point's disconnection).
  ADD COLUMN status_since timestamptz;
CREATE INDEX network_devices_parent_idx ON network_devices (parent_id) WHERE parent_id IS NOT NULL;
-- Access points are named by their controller; the same name may come back after a removal.
CREATE UNIQUE INDEX network_devices_ap_idx ON network_devices (parent_id, name)
  WHERE parent_id IS NOT NULL AND removed_at IS NULL;

-- Wi-Fi clients, replaced from each controller's registration tables every round: rows, never
-- series labels. Their counts per AP and SSID are series.
CREATE TABLE network_wifi_clients (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid REFERENCES orgs (id) ON DELETE CASCADE,
  mac macaddr NOT NULL,
  controller_id uuid NOT NULL REFERENCES network_devices (id) ON DELETE CASCADE,
  ap_id uuid REFERENCES network_devices (id) ON DELETE CASCADE,
  ap text NOT NULL,
  interface text NOT NULL DEFAULT '',
  ssid text NOT NULL DEFAULT '',
  band text NOT NULL DEFAULT '',
  vendor text NOT NULL DEFAULT '',
  signal_dbm real,
  tx_rate text NOT NULL DEFAULT '',
  rx_rate text NOT NULL DEFAULT '',
  uptime_s bigint,
  bytes_tx double precision NOT NULL DEFAULT 0,
  bytes_rx double precision NOT NULL DEFAULT 0,
  seen_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, mac)
);
CREATE INDEX network_wifi_clients_controller_idx ON network_wifi_clients (controller_id);
CREATE INDEX network_wifi_clients_org_idx ON network_wifi_clients (org_id);
ALTER TABLE network_wifi_clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON network_wifi_clients
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- Wireless backhaul between access points (wifi mesh or WDS): a dotted link on the map.
CREATE TABLE network_mesh_links (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid REFERENCES orgs (id) ON DELETE CASCADE,
  from_id uuid NOT NULL REFERENCES network_devices (id) ON DELETE CASCADE,
  to_id uuid NOT NULL REFERENCES network_devices (id) ON DELETE CASCADE,
  signal_dbm real,
  rate text NOT NULL DEFAULT '',
  seen_at timestamptz NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX network_mesh_links_org_idx ON network_mesh_links (org_id);
ALTER TABLE network_mesh_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON network_mesh_links
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- iSCSI sessions between a recorder and a NAS's LUN: from the recorder's own view of its iSCSI
-- disks, the NAS's targets, and the switch ports between them (QTS gives no session table over
-- SNMP, ADR-234). `connected_since` is the session's start as WatchLog saw it.
CREATE TABLE network_iscsi_sessions (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid REFERENCES orgs (id) ON DELETE CASCADE,
  recorder_id uuid NOT NULL REFERENCES network_devices (id) ON DELETE CASCADE,
  disk text NOT NULL,
  nas_id uuid REFERENCES network_devices (id) ON DELETE SET NULL,
  lun text NOT NULL DEFAULT '',
  target text NOT NULL DEFAULT '',
  connected boolean NOT NULL,
  connected_since timestamptz,
  lost_at timestamptz,
  seen_at timestamptz NOT NULL,
  PRIMARY KEY (recorder_id, disk)
);
CREATE INDEX network_iscsi_sessions_org_idx ON network_iscsi_sessions (org_id);
CREATE INDEX network_iscsi_sessions_nas_idx ON network_iscsi_sessions (nas_id);
ALTER TABLE network_iscsi_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON network_iscsi_sessions
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- Down Migration
DROP TABLE network_iscsi_sessions;
DROP TABLE network_mesh_links;
DROP TABLE network_wifi_clients;
DROP INDEX network_devices_ap_idx;
DROP INDEX network_devices_parent_idx;
ALTER TABLE network_devices
  DROP COLUMN status_since,
  DROP COLUMN recording,
  DROP COLUMN feeds,
  DROP COLUMN mac,
  DROP COLUMN parent_id;
DELETE FROM network_devices WHERE protocol IN ('dahua', 'capsman');
DELETE FROM network_credentials WHERE protocol = 'dahua';
ALTER TABLE network_credentials DROP CONSTRAINT network_credentials_protocol_check;
ALTER TABLE network_credentials ADD CONSTRAINT network_credentials_protocol_check
  CHECK (protocol IN ('snmp', 'routeros'));
ALTER TABLE network_devices DROP CONSTRAINT network_devices_status_check;
ALTER TABLE network_devices ADD CONSTRAINT network_devices_status_check
  CHECK (status IN ('pending', 'ok', 'unreachable', 'auth_failed', 'cert_changed', 'error'));
ALTER TABLE network_devices DROP CONSTRAINT network_devices_protocol_check;
ALTER TABLE network_devices ADD CONSTRAINT network_devices_protocol_check
  CHECK (protocol IN ('snmp', 'routeros'));
