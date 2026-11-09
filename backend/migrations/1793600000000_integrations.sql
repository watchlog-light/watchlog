-- Up Migration
-- Applications (v0.3, SPEC §4.12): the integrations collectors and the services they
-- monitor (ADR-131). New tables only: nothing to do on existing installs (ADR-107).

-- One row per collector: the cluster's Deployment on Kubernetes (host ''), one per
-- Docker host that runs a monitored service. Kept apart from agent_instances, which
-- counts nodes and hosts.
CREATE TABLE integration_collectors (
  id uuid PRIMARY KEY,
  cluster_id uuid NOT NULL REFERENCES clusters (id) ON DELETE CASCADE,
  host text NOT NULL CHECK (length(host) <= 253),
  mode text NOT NULL CHECK (mode IN ('kubernetes', 'docker')),
  version text NOT NULL CHECK (length(version) <= 64),
  -- Its own memory and CPU, for the budget (ADR-131).
  self jsonb NOT NULL DEFAULT '{}',
  -- The configuration version it last applied.
  config_etag text CHECK (length(config_etag) <= 64),
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cluster_id, host)
);

CREATE TRIGGER integration_collectors_set_updated_at BEFORE UPDATE ON integration_collectors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per monitored service instance.
CREATE TABLE integrations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  cluster_id uuid NOT NULL REFERENCES clusters (id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('redis', 'postgres', 'nginx', 'rabbitmq', 'mongodb', 'elasticsearch')),
  -- "namespace/workload" on Kubernetes, the container or Compose service on Docker.
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 253),
  -- What it is and how to reach it: kind (workload, compose, container, address) with
  -- the names the agents saw, and the port.
  target jsonb NOT NULL,
  -- The collector that reaches it: '' for the cluster's collector on Kubernetes, the
  -- host name on Docker.
  collector_host text NOT NULL DEFAULT '' CHECK (length(collector_host) <= 253),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connecting', 'ok', 'error', 'paused')),
  -- The collector's last report: error, members, permissions per tab.
  status_details jsonb NOT NULL DEFAULT '{}',
  version text CHECK (length(version) <= 64),
  settings jsonb NOT NULL DEFAULT '{"query_text": true}',
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  monitored_since timestamptz NOT NULL DEFAULT now(),
  last_report_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cluster_id, type, name)
);
CREATE INDEX integrations_org_id_idx ON integrations (org_id);

CREATE TRIGGER integrations_set_updated_at BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
