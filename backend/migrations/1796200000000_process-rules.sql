-- Up Migration
-- A Server fleet's own process-group rules (ADR-207, ADR-208): the agent groups a server's
-- processes by these first, in order, before its built-in rules. A rule matches on the
-- executable's base name (a glob), the systemd unit (a glob) and a pattern over the arguments
-- (RE2), evaluated on the server; its name is a template over the pattern's captures. At most
-- 50 a fleet (the routes enforce it).
CREATE TABLE process_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 49),
  exe text CHECK (length(exe) <= 100),
  unit text CHECK (length(unit) <= 200),
  args text CHECK (length(args) <= 300),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 63),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT process_rules_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE,
  CONSTRAINT process_rules_position UNIQUE (cluster_id, position)
);
CREATE TRIGGER process_rules_org BEFORE INSERT ON process_rules
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();
ALTER TABLE process_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON process_rules
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
