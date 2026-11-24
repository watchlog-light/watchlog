-- Up Migration
-- Network devices (ee/, ADR-233), Enterprise: run by the core's migrate after its own, in
-- pgmigrations_ee, only when ee/ is there. Every table is a tenant table (org_id, Row-Level
-- Security), as the core's (ADR-174).

-- Credential profiles: one SNMPv3 or RouterOS login used by several devices. The secret part
-- (community, keys, password) is AES-256-GCM with the install's key, bound to the row
-- (`network_credentials:<id>`), write-only, and sent only to the pollers of its devices.
CREATE TABLE network_credentials (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid REFERENCES orgs (id) ON DELETE CASCADE,
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  protocol text NOT NULL CHECK (protocol IN ('snmp', 'routeros')),
  -- What isn't secret: SNMP version, user, auth and privacy protocols, port; RouterOS user,
  -- transport, port, allow-plain.
  settings jsonb NOT NULL DEFAULT '{}',
  ciphertext text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE INDEX network_credentials_org_idx ON network_credentials (org_id);
ALTER TABLE network_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON network_credentials
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

INSERT INTO module_secret_columns (table_name, id_column, secret_column)
  VALUES ('network_credentials', 'id', 'ciphertext');

-- Devices: what is polled, by which collector (a cluster's, or a server's: poller_host), and
-- what it last said. Removing one keeps the row (removed_at) for the unit count's history.
CREATE TABLE network_devices (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid REFERENCES orgs (id) ON DELETE CASCADE,
  id uuid PRIMARY KEY,
  cluster_id uuid NOT NULL,
  poller_host text NOT NULL DEFAULT '',
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 253),
  address text NOT NULL CHECK (length(address) BETWEEN 1 AND 253),
  protocol text NOT NULL CHECK (protocol IN ('snmp', 'routeros')),
  profile text,
  credential_id uuid REFERENCES network_credentials (id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'switch',
  vendor text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  serial text NOT NULL DEFAULT '',
  firmware text NOT NULL DEFAULT '',
  sys_name text NOT NULL DEFAULT '',
  sys_descr text NOT NULL DEFAULT '',
  sys_object_id text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ok', 'unreachable', 'auth_failed', 'cert_changed', 'error')),
  error text,
  failures integer NOT NULL DEFAULT 0,
  uptime_s bigint,
  polled_at timestamptz,
  -- RouterOS: the certificate pinned on first contact, and a different one seen since.
  cert_pin text,
  cert_seen text,
  -- An access point a controller manages (CAPsMAN): free, not a unit (next release's).
  managed_ap boolean NOT NULL DEFAULT false,
  health jsonb NOT NULL DEFAULT '{}',
  -- The last inventory's neighbours, MAC and ARP tables, routes: what links and endpoints are
  -- merged from, org-wide, each time one comes in.
  inventory jsonb NOT NULL DEFAULT '{}',
  inventory_at timestamptz,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_devices_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE INDEX network_devices_org_idx ON network_devices (org_id);
CREATE UNIQUE INDEX network_devices_address_idx ON network_devices (org_id, address)
  WHERE removed_at IS NULL;
CREATE INDEX network_devices_poller_idx ON network_devices (cluster_id, poller_host)
  WHERE removed_at IS NULL;
ALTER TABLE network_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON network_devices
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- Ports, from the inventory every 5 minutes and the state every round.
CREATE TABLE network_interfaces (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid REFERENCES orgs (id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES network_devices (id) ON DELETE CASCADE,
  if_index integer NOT NULL,
  name text NOT NULL,
  descr text NOT NULL DEFAULT '',
  alias text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'ethernet',
  mac macaddr,
  speed_mbps bigint,
  -- The speed it usually runs at (the highest seen while up), for "speed dropped".
  usual_speed_mbps bigint,
  admin_up boolean NOT NULL DEFAULT true,
  oper_up boolean NOT NULL DEFAULT false,
  vlans integer[] NOT NULL DEFAULT '{}',
  poe_watts real,
  errors double precision NOT NULL DEFAULT 0,
  -- Errors growing: since when, and the last round they grew (it ends 10 minutes after).
  errors_rising_since timestamptz,
  errors_last_rise timestamptz,
  changed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, name)
);
CREATE INDEX network_interfaces_org_idx ON network_interfaces (org_id);
ALTER TABLE network_interfaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON network_interfaces
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- Links between two ports: learnt from CDP, LLDP or MNDP (either end), or from a MAC table
-- (one device's address behind another's port). Stored once per pair, a < b by device id.
CREATE TABLE network_links (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid REFERENCES orgs (id) ON DELETE CASCADE,
  id uuid PRIMARY KEY,
  a_device uuid NOT NULL REFERENCES network_devices (id) ON DELETE CASCADE,
  a_port text NOT NULL,
  b_device uuid NOT NULL REFERENCES network_devices (id) ON DELETE CASCADE,
  b_port text NOT NULL,
  via text[] NOT NULL DEFAULT '{}',
  speed_mbps bigint,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  UNIQUE (a_device, a_port, b_device, b_port)
);
CREATE INDEX network_links_org_idx ON network_links (org_id);
ALTER TABLE network_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON network_links
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- Endpoints: a MAC address behind a switch port (the port nearest it: one that isn't a link
-- to another switch), its IP from ARP, its vendor from the IEEE registry, and the WatchLog
-- server or node it is, when its agent reported that MAC.
CREATE TABLE network_endpoints (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid REFERENCES orgs (id) ON DELETE CASCADE,
  mac macaddr NOT NULL,
  ip inet,
  vendor text NOT NULL DEFAULT '',
  device_id uuid REFERENCES network_devices (id) ON DELETE CASCADE,
  port text,
  vlan integer,
  cluster_id uuid,
  node text,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, mac)
);
CREATE INDEX network_endpoints_org_idx ON network_endpoints (org_id);
CREATE INDEX network_endpoints_device_idx ON network_endpoints (device_id, port);
CREATE INDEX network_endpoints_node_idx ON network_endpoints (cluster_id, node);
ALTER TABLE network_endpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON network_endpoints
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- What happened on a device, for its page: a port down or up, a speed change, errors, a
-- reboot, a changed certificate. The places behind a port get theirs in their Events list.
CREATE TABLE network_events (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid REFERENCES orgs (id) ON DELETE CASCADE,
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES network_devices (id) ON DELETE CASCADE,
  port text NOT NULL DEFAULT '',
  reason text NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  message text NOT NULL,
  at timestamptz NOT NULL
);
CREATE INDEX network_events_device_idx ON network_events (device_id, at DESC);
CREATE INDEX network_events_org_idx ON network_events (org_id, at DESC);
ALTER TABLE network_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON network_events
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- The map's layout an org dragged, by node id.
CREATE TABLE network_layouts (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid REFERENCES orgs (id) ON DELETE CASCADE,
  id smallint NOT NULL DEFAULT 1 CHECK (id = 1),
  positions jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
CREATE INDEX network_layouts_org_idx ON network_layouts (org_id);
ALTER TABLE network_layouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON network_layouts
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- Discoveries asked for on the Add page: sent to the chosen poller, answered in its reports.
CREATE TABLE network_discoveries (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid REFERENCES orgs (id) ON DELETE CASCADE,
  id uuid PRIMARY KEY,
  cluster_id uuid NOT NULL,
  poller_host text NOT NULL DEFAULT '',
  request jsonb NOT NULL,
  found jsonb NOT NULL DEFAULT '[]',
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT network_discoveries_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE INDEX network_discoveries_org_idx ON network_discoveries (org_id);
ALTER TABLE network_discoveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON network_discoveries
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- Down Migration
DROP TABLE network_discoveries;
DROP TABLE network_layouts;
DROP TABLE network_events;
DROP TABLE network_endpoints;
DROP TABLE network_links;
DROP TABLE network_interfaces;
DROP TABLE network_devices;
DELETE FROM module_secret_columns WHERE table_name = 'network_credentials';
DROP TABLE network_credentials;
