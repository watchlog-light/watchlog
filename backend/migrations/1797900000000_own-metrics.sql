-- Up Migration
-- A user's own metrics (1.0.0, ADR-236): the sources they arrive from, each metric with its type
-- and unit, the series known (for the caps: a known series keeps flowing, a new one is admitted
-- only under them), and the write-only tokens for remote write and pushes. The values themselves
-- are in VictoriaMetrics, under the label `wl_own`. Tenant tables with org_id, the composite key
-- to their cluster and Row-Level Security (ADR-174). Only tables are added (ADR-107).

-- A write-only token for own metrics and change events: `wl_mt_` + 256 random bits, stored as
-- SHA-256 with an 8-character prefix, like a cluster token (ADR-025). It belongs to one cluster
-- or fleet; it can write own metrics and change events there and read nothing.
CREATE TABLE own_metric_tokens (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  token_hash bytea NOT NULL,
  prefix text NOT NULL CHECK (length(prefix) = 8),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT own_metric_tokens_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX own_metric_tokens_prefix_idx ON own_metric_tokens (prefix);
CREATE INDEX own_metric_tokens_cluster_idx ON own_metric_tokens (cluster_id);
CREATE INDEX own_metric_tokens_org_idx ON own_metric_tokens (org_id);
CREATE TRIGGER own_metric_tokens_org BEFORE INSERT ON own_metric_tokens
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();
ALTER TABLE own_metric_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON own_metric_tokens
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- Where own metrics arrive from. `kind`: a scraped pod endpoint of a workload ('scrape_pod',
-- found by its annotation), an address scraped on one server ('scrape_address', added in the
-- panel), a token's remote write or a token's pushes. `key` names it within its cluster.
-- `owner` is what its series belong to by default. `dropped` says what its last report lost
-- and why; `error` why its last scrape failed.
CREATE TABLE own_sources (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('scrape_pod', 'scrape_address', 'remote_write', 'push')),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 600),
  label text NOT NULL CHECK (length(label) <= 300),
  owner jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(owner) = 'object'),
  config jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
  token_id uuid REFERENCES own_metric_tokens (id) ON DELETE CASCADE,
  series integer NOT NULL DEFAULT 0,
  dropped jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(dropped) = 'object'),
  error text CHECK (error IS NULL OR length(error) <= 512),
  -- Over the plan's number of sources: nothing of it is stored until one is removed.
  refused boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_reported_at timestamptz,
  CONSTRAINT own_sources_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE,
  UNIQUE (cluster_id, key)
);
CREATE INDEX own_sources_org_idx ON own_sources (org_id);
CREATE TRIGGER own_sources_org BEFORE INSERT ON own_sources
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();
ALTER TABLE own_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON own_sources
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- One metric (a histogram is one, with its buckets). `type` and `unit` are what was detected;
-- the user's corrections are `type_override` and `unit_override`. `refused` says why its series
-- are not stored (a label with too many values).
CREATE TABLE own_metrics (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type text NOT NULL CHECK (type IN ('counter', 'gauge', 'histogram', 'summary', 'timestamp')),
  type_override text
    CHECK (type_override IS NULL OR type_override IN ('counter', 'gauge', 'histogram', 'summary', 'timestamp')),
  unit text NOT NULL DEFAULT 'count'
    CHECK (unit IN ('seconds', 'bytes', 'celsius', 'ratio', 'percent', 'count')),
  unit_override text
    CHECK (unit_override IS NULL OR unit_override IN ('seconds', 'bytes', 'celsius', 'ratio', 'percent', 'count')),
  help text NOT NULL DEFAULT '' CHECK (length(help) <= 500),
  hidden boolean NOT NULL DEFAULT false,
  label_names text[] NOT NULL DEFAULT '{}',
  refused jsonb CHECK (refused IS NULL OR jsonb_typeof(refused) = 'object'),
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT own_metrics_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE,
  UNIQUE (cluster_id, name)
);
CREATE INDEX own_metrics_org_idx ON own_metrics (org_id);
CREATE TRIGGER own_metrics_org BEFORE INSERT ON own_metrics
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();
ALTER TABLE own_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON own_metrics
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- Every series known: its fingerprint (the stored name and labels), the metric and the source
-- it came with, what it belongs to, and when it last reported. A pushed counter keeps its
-- running total here. Rows not seen for a day are removed; the values age out with the
-- retention.
CREATE TABLE own_series (
  org_id uuid NOT NULL DEFAULT nullif(current_setting('watchlog.org_id', true), '')::uuid,
  cluster_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{24}$'),
  metric_id uuid NOT NULL REFERENCES own_metrics (id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES own_sources (id) ON DELETE CASCADE,
  series_name text NOT NULL CHECK (length(series_name) <= 200),
  labels jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(labels) = 'object'),
  owner_kind text NOT NULL DEFAULT '' CHECK (owner_kind IN ('', 'workload', 'server')),
  owner_namespace text NOT NULL DEFAULT '',
  owner_workload_kind text NOT NULL DEFAULT '',
  owner_name text NOT NULL DEFAULT '',
  total double precision,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster_id, fingerprint),
  CONSTRAINT own_series_cluster_org_fkey
    FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE INDEX own_series_org_seen_idx ON own_series (org_id, last_seen);
CREATE INDEX own_series_metric_idx ON own_series (metric_id);
CREATE INDEX own_series_source_idx ON own_series (source_id);
CREATE INDEX own_series_owner_idx
  ON own_series (cluster_id, owner_kind, owner_namespace, owner_name) WHERE owner_kind <> '';
CREATE TRIGGER own_series_org BEFORE INSERT ON own_series
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION watchlog_org_from_cluster();
ALTER TABLE own_series ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON own_series
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- A cluster's own switch: also scrape pods annotated `prometheus.io/scrape` (off by default).
ALTER TABLE clusters ADD COLUMN own_metrics_prometheus_annotations boolean NOT NULL DEFAULT false;
