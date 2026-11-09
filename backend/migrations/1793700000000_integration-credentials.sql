-- Up Migration
-- Connecting a service that needs a user (v0.3, ADR-133, ADR-134): its credential,
-- encrypted; the probes the connect drawer runs before Start monitoring; and the log of
-- who set, verified, paused or removed what. New tables only (ADR-107).

-- One credential per monitored service. `generated` and `entered` keep the password
-- encrypted with WATCHLOG_SECRET_KEY, bound to the service's id (associated data);
-- `reference` keeps only where it lives (a Kubernetes Secret and key, or a file on the
-- Docker host).
CREATE TABLE integration_credentials (
  integration_id uuid PRIMARY KEY REFERENCES integrations (id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('generated', 'entered', 'reference')),
  username text CHECK (length(username) <= 128),
  ciphertext text,
  reference jsonb,
  set_by uuid REFERENCES users (id) ON DELETE SET NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  CHECK ((method = 'reference') = (ciphertext IS NULL)),
  CHECK ((method = 'reference') = (reference IS NOT NULL))
);

-- A connection test before a service is monitored (or when its access changes): the
-- collector that would reach it tries every 5 s until it works or the probe expires.
CREATE TABLE integration_probes (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  cluster_id uuid NOT NULL REFERENCES clusters (id) ON DELETE CASCADE,
  collector_host text NOT NULL DEFAULT '' CHECK (length(collector_host) <= 253),
  type text NOT NULL,
  target jsonb NOT NULL,
  -- The service it tests access for, when it already is monitored (settings drawer).
  integration_id uuid REFERENCES integrations (id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('none', 'generated', 'entered', 'reference')),
  username text CHECK (length(username) <= 128),
  ciphertext text,
  reference jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'failed')),
  -- The collector's last answer: error, version, facts, privileges beyond what's needed.
  result jsonb,
  attempts integer NOT NULL DEFAULT 0,
  -- "Check now" bumps it so the collector tries at once.
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_probes_cluster_idx ON integration_probes (cluster_id, collector_host, expires_at);

CREATE TRIGGER integration_probes_set_updated_at BEFORE UPDATE ON integration_probes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Who did what to a service's monitoring and access (ADR-133). Never a password. Kept
-- after the service is removed, so "removed by" stays readable.
CREATE TABLE integration_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  integration_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN (
    'monitored', 'credential_set', 'credential_replaced', 'credential_removed',
    'verified', 'paused', 'resumed', 'settings_changed', 'removed'
  )),
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  -- The name at the time, so the log reads the same after a user is removed.
  user_name text CHECK (length(user_name) <= 256),
  ip text CHECK (length(ip) <= 64),
  details jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_events_integration_idx ON integration_events (integration_id, at DESC);
