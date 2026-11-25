-- Up Migration
-- Own metrics pinned to a workload's or a server's page (1.0.0, ADR-236): at most 6 on a page,
-- shown there as "Its own metrics". A pin names the metric and the page's owner.
CREATE TABLE own_pins (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  metric_id uuid NOT NULL REFERENCES own_metrics (id) ON DELETE CASCADE,
  owner_kind text NOT NULL CHECK (owner_kind IN ('workload', 'server')),
  owner_namespace text NOT NULL DEFAULT '',
  owner_workload_kind text NOT NULL DEFAULT '',
  owner_name text NOT NULL CHECK (length(owner_name) BETWEEN 1 AND 253),
  position integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT own_pins_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE,
  UNIQUE (cluster_id, metric_id, owner_kind, owner_namespace, owner_workload_kind, owner_name)
);
CREATE INDEX own_pins_org_idx ON own_pins (org_id);
CREATE INDEX own_pins_page_idx
  ON own_pins (cluster_id, owner_kind, owner_namespace, owner_workload_kind, owner_name);
CREATE TRIGGER own_pins_org BEFORE INSERT ON own_pins
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();
ALTER TABLE own_pins ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON own_pins
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- Down Migration
DROP TABLE own_pins;
