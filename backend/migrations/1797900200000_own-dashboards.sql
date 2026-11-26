-- Up Migration
-- Dashboards of a user's own metrics (1.0.0, ADR-237): the org's, built from widgets. A widget
-- is a metric (by its cluster and name), a shape, at most one label to split by, and a width on
-- a 12-column grid. No query, no variable, no formula: the columns a widget has say so.
CREATE TABLE own_dashboards (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid
    REFERENCES orgs (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- In the order they are shown: [{id, clusterId, metric, title, shape, by, w}].
  widgets jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(widgets) = 'array'),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX own_dashboards_org_name_idx ON own_dashboards (org_id, lower(name));
CREATE TRIGGER own_dashboards_set_updated_at BEFORE UPDATE ON own_dashboards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE own_dashboards ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON own_dashboards
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- Down Migration
DROP TABLE own_dashboards;
