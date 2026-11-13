-- Up Migration
-- Tenancy (ADR-174, completes ADR-035): org_id on every tenant row and Row-Level Security.
--
-- 1. The tables keyed by a cluster or a parent row gain org_id NOT NULL, backfilled from it,
--    with a composite foreign key to that parent, so a row can't name one org's cluster (or
--    parent) under another org. An insert that leaves org_id out gets the connection's org
--    (Cloud), or, with none set, its parent's from a trigger (Community), so 0.5.0's writes
--    keep working unchanged.
-- 2. Every tenant table gets RLS: a row is visible and writable only while the connection's
--    `watchlog.org_id` setting names its org. Unset or empty matches nothing.
--
-- Community keeps connecting as the owner, whom RLS doesn't apply to (no FORCE): behaviour is
-- 0.5.0's. Cloud's request path connects as watchlog_app (NOBYPASSRLS); the Cloud kit creates
-- that role and `migrate` grants it (src/db/app-role.ts). Not tenant data, and global: users,
-- sessions, password_resets (a user spans orgs), server_settings (the installation's, ADR-093),
-- secret_key_check, alert_worker_heartbeats, alerting_periods (the worker's), retired_cluster_tokens
-- (hashes only, read by the ingest token check), pgmigrations. orgs gets RLS on its own id.

-- The composite foreign keys need (id, org_id) to be unique on each parent.
ALTER TABLE clusters ADD CONSTRAINT clusters_id_org_key UNIQUE (id, org_id);
ALTER TABLE integrations ADD CONSTRAINT integrations_id_org_key UNIQUE (id, org_id);
ALTER TABLE notifications ADD CONSTRAINT notifications_id_org_key UNIQUE (id, org_id);
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_id_org_key UNIQUE (id, org_id);
ALTER TABLE alert_channels ADD CONSTRAINT alert_channels_id_org_key UNIQUE (id, org_id);

-- Fills org_id from the row's cluster when an insert leaves it out. SECURITY DEFINER: it reads
-- clusters as the owner, and RLS's WITH CHECK still refuses a row of another org's cluster.
CREATE FUNCTION watchlog_org_from_cluster() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  SELECT c.org_id INTO NEW.org_id FROM clusters c WHERE c.id = NEW.cluster_id;
  RETURN NEW;
END $$;

-- The same from a parent row: TG_ARGV[0] is the parent table, TG_ARGV[1] the column naming it.
CREATE FUNCTION watchlog_org_from_parent() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  EXECUTE format('SELECT org_id FROM %I WHERE id = $1', TG_ARGV[0])
    INTO NEW.org_id USING (to_jsonb(NEW) ->> TG_ARGV[1])::uuid;
  RETURN NEW;
END $$;

-- objects: from its cluster.
ALTER TABLE objects ADD COLUMN org_id uuid;
UPDATE objects x SET org_id = c.org_id FROM clusters c WHERE c.id = x.cluster_id;
ALTER TABLE objects ALTER COLUMN org_id SET NOT NULL,
  ALTER COLUMN org_id SET DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid;
ALTER TABLE objects ADD CONSTRAINT objects_cluster_org_fkey
  FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE;
CREATE TRIGGER objects_org BEFORE INSERT ON objects
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();

-- change_markers: from its cluster.
ALTER TABLE change_markers ADD COLUMN org_id uuid;
UPDATE change_markers x SET org_id = c.org_id FROM clusters c WHERE c.id = x.cluster_id;
ALTER TABLE change_markers ALTER COLUMN org_id SET NOT NULL,
  ALTER COLUMN org_id SET DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid;
ALTER TABLE change_markers ADD CONSTRAINT change_markers_cluster_org_fkey
  FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE;
CREATE TRIGGER change_markers_org BEFORE INSERT ON change_markers
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();

-- agent_instances: from its cluster.
ALTER TABLE agent_instances ADD COLUMN org_id uuid;
UPDATE agent_instances x SET org_id = c.org_id FROM clusters c WHERE c.id = x.cluster_id;
ALTER TABLE agent_instances ALTER COLUMN org_id SET NOT NULL,
  ALTER COLUMN org_id SET DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid;
ALTER TABLE agent_instances ADD CONSTRAINT agent_instances_cluster_org_fkey
  FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE;
CREATE TRIGGER agent_instances_org BEFORE INSERT ON agent_instances
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();

-- cluster_tokens: from its cluster.
ALTER TABLE cluster_tokens ADD COLUMN org_id uuid;
UPDATE cluster_tokens x SET org_id = c.org_id FROM clusters c WHERE c.id = x.cluster_id;
ALTER TABLE cluster_tokens ALTER COLUMN org_id SET NOT NULL,
  ALTER COLUMN org_id SET DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid;
ALTER TABLE cluster_tokens ADD CONSTRAINT cluster_tokens_cluster_org_fkey
  FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE;
CREATE TRIGGER cluster_tokens_org BEFORE INSERT ON cluster_tokens
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();

-- ingest_errors: from its cluster.
ALTER TABLE ingest_errors ADD COLUMN org_id uuid;
UPDATE ingest_errors x SET org_id = c.org_id FROM clusters c WHERE c.id = x.cluster_id;
ALTER TABLE ingest_errors ALTER COLUMN org_id SET NOT NULL,
  ALTER COLUMN org_id SET DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid;
ALTER TABLE ingest_errors ADD CONSTRAINT ingest_errors_cluster_org_fkey
  FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE;
CREATE TRIGGER ingest_errors_org BEFORE INSERT ON ingest_errors
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();

-- integration_collectors: from its cluster.
ALTER TABLE integration_collectors ADD COLUMN org_id uuid;
UPDATE integration_collectors x SET org_id = c.org_id FROM clusters c WHERE c.id = x.cluster_id;
ALTER TABLE integration_collectors ALTER COLUMN org_id SET NOT NULL,
  ALTER COLUMN org_id SET DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid;
ALTER TABLE integration_collectors ADD CONSTRAINT integration_collectors_cluster_org_fkey
  FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE;
CREATE TRIGGER integration_collectors_org BEFORE INSERT ON integration_collectors
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();

-- k8s_events: from its cluster.
ALTER TABLE k8s_events ADD COLUMN org_id uuid;
UPDATE k8s_events x SET org_id = c.org_id FROM clusters c WHERE c.id = x.cluster_id;
ALTER TABLE k8s_events ALTER COLUMN org_id SET NOT NULL,
  ALTER COLUMN org_id SET DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid;
ALTER TABLE k8s_events ADD CONSTRAINT k8s_events_cluster_org_fkey
  FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE;
CREATE TRIGGER k8s_events_org BEFORE INSERT ON k8s_events
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();

-- integration_credentials: from integrations.
ALTER TABLE integration_credentials ADD COLUMN org_id uuid;
UPDATE integration_credentials x SET org_id = p.org_id FROM integrations p WHERE p.id = x.integration_id;
ALTER TABLE integration_credentials ALTER COLUMN org_id SET NOT NULL,
  ALTER COLUMN org_id SET DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid;
ALTER TABLE integration_credentials ADD CONSTRAINT integration_credentials_parent_org_fkey
  FOREIGN KEY (integration_id, org_id) REFERENCES integrations (id, org_id) ON DELETE CASCADE;
CREATE TRIGGER integration_credentials_org BEFORE INSERT ON integration_credentials
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_parent('integrations', 'integration_id');

-- notification_alerts: from notifications.
ALTER TABLE notification_alerts ADD COLUMN org_id uuid;
UPDATE notification_alerts x SET org_id = p.org_id FROM notifications p WHERE p.id = x.notification_id;
ALTER TABLE notification_alerts ALTER COLUMN org_id SET NOT NULL,
  ALTER COLUMN org_id SET DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid;
ALTER TABLE notification_alerts ADD CONSTRAINT notification_alerts_parent_org_fkey
  FOREIGN KEY (notification_id, org_id) REFERENCES notifications (id, org_id) ON DELETE CASCADE;
CREATE TRIGGER notification_alerts_org BEFORE INSERT ON notification_alerts
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_parent('notifications', 'notification_id');

-- api_token_events: from api_tokens.
ALTER TABLE api_token_events ADD COLUMN org_id uuid;
UPDATE api_token_events x SET org_id = p.org_id FROM api_tokens p WHERE p.id = x.token_id;
ALTER TABLE api_token_events ALTER COLUMN org_id SET NOT NULL,
  ALTER COLUMN org_id SET DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid;
ALTER TABLE api_token_events ADD CONSTRAINT api_token_events_parent_org_fkey
  FOREIGN KEY (token_id, org_id) REFERENCES api_tokens (id, org_id) ON DELETE CASCADE;
CREATE TRIGGER api_token_events_org BEFORE INSERT ON api_token_events
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_parent('api_tokens', 'token_id');

-- telegram_verifications: from alert_channels.
ALTER TABLE telegram_verifications ADD COLUMN org_id uuid;
UPDATE telegram_verifications x SET org_id = p.org_id FROM alert_channels p WHERE p.id = x.channel_id;
ALTER TABLE telegram_verifications ALTER COLUMN org_id SET NOT NULL,
  ALTER COLUMN org_id SET DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid;
ALTER TABLE telegram_verifications ADD CONSTRAINT telegram_verifications_parent_org_fkey
  FOREIGN KEY (channel_id, org_id) REFERENCES alert_channels (id, org_id) ON DELETE CASCADE;
CREATE TRIGGER telegram_verifications_org BEFORE INSERT ON telegram_verifications
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_parent('alert_channels', 'channel_id');

-- The tables that already had both: the same composite key (a null cluster_id is allowed).
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_cluster_org_fkey
  FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE;
ALTER TABLE alert_states ADD CONSTRAINT alert_states_cluster_org_fkey
  FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE;
ALTER TABLE discovery_ignores ADD CONSTRAINT discovery_ignores_cluster_org_fkey
  FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE;
ALTER TABLE integration_probes ADD CONSTRAINT integration_probes_cluster_org_fkey
  FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE;
ALTER TABLE integrations ADD CONSTRAINT integrations_cluster_org_fkey
  FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE;
ALTER TABLE notifications ADD CONSTRAINT notifications_cluster_org_fkey
  FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE;

-- Row-Level Security on every tenant table. The partitions of k8s_events get it too, with no
-- policy, so they can only be read through k8s_events (src/modules/events/partitions.ts does
-- the same for each new one).
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON orgs
  USING (id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

ALTER TABLE agent_instances ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON agent_instances
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE alert_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON alert_channels
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON alert_rules
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE alert_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON alert_states
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE api_token_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON api_token_events
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON api_tokens
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON audit_events
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE change_markers ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON change_markers
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE cluster_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON cluster_tokens
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE clusters ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON clusters
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE discovery_ignores ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON discovery_ignores
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE ingest_errors ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON ingest_errors
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE integration_collectors ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON integration_collectors
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE integration_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON integration_credentials
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE integration_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON integration_events
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE integration_probes ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON integration_probes
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON integrations
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON invites
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE k8s_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON k8s_events
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE mcp_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON mcp_calls
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON memberships
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE notification_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON notification_alerts
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON notifications
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON objects
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE seed_services ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON seed_services
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE silences ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON silences
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
ALTER TABLE telegram_verifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON telegram_verifications
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

DO $$
DECLARE p regclass;
BEGIN
  FOR p IN SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'k8s_events'::regclass LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p);
  END LOOP;
END $$;
