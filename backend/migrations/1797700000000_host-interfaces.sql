-- Up Migration
-- A server's or a Kubernetes node's network cards (0.16.0, ADR-233), from its agent's
-- inventory snapshot: each physical port's and bond's name, MAC address, IPv4 addresses,
-- speed and link state. Core and harmless in Community: the network module (ee/) matches them
-- to the switches' MAC and ARP tables, so a server or node shows the switch port it is on.
-- Replaced per node with each snapshot. A tenant table as every other (ADR-174).
CREATE TABLE host_interfaces (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  node text NOT NULL,
  name text NOT NULL,
  mac macaddr NOT NULL,
  addresses inet[] NOT NULL DEFAULT '{}',
  speed_mbps integer,
  up boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster_id, node, name),
  CONSTRAINT host_interfaces_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE INDEX host_interfaces_org_idx ON host_interfaces (org_id);
CREATE INDEX host_interfaces_mac_idx ON host_interfaces (mac);
CREATE TRIGGER host_interfaces_org BEFORE INSERT ON host_interfaces
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();
ALTER TABLE host_interfaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON host_interfaces
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- Down Migration
DROP TABLE host_interfaces;
