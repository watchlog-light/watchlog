-- Up Migration
-- Discovered services someone chose to ignore (ADR-132 amended, owner 2026-11-09): one
-- candidate by its discovery key, or every candidate in a Kubernetes namespace or a
-- Compose project. Ignored ones leave the Applications page's discovered list; they can
-- be restored. Additive (ADR-107).
CREATE TABLE discovery_ignores (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  cluster_id uuid NOT NULL REFERENCES clusters (id) ON DELETE CASCADE,
  service_key text CHECK (length(service_key) <= 600),
  group_name text CHECK (length(group_name) <= 253),
  -- What the person saw ("postgres e2e-pg-gen", "namespace pg-e2e"), for the restore list.
  label text NOT NULL CHECK (length(label) <= 300),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((service_key IS NULL) <> (group_name IS NULL))
);
CREATE UNIQUE INDEX discovery_ignores_key ON discovery_ignores
  (cluster_id, coalesce(service_key, ''), coalesce(group_name, ''));

-- Services a seed file monitors once discovered (ADR-142 as built): each is applied once
-- per organization, so a service someone stops monitoring isn't added back.
CREATE TABLE seed_services (
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  seed_key text NOT NULL CHECK (length(seed_key) <= 300),
  integration_id uuid REFERENCES integrations (id) ON DELETE SET NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, seed_key)
);
