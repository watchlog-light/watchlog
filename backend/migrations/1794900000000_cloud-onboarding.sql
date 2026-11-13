-- Up Migration
-- Onboarding in Cloud (ADR-176): the install codes behind `kubectl apply -f
-- …/install.yaml?code=wl_ic_…`, and each user's first-week checklist on the overview.
--
-- Community never writes either table: the install code and the first-week card are Cloud
-- only. Both are tenant tables, with org_id, Row-Level Security and, for the install codes,
-- the composite key to their cluster (ADR-174).

-- An install code (`wl_ic_` + 256 random bits) stands for one cluster token for 24 hours.
-- Stored as its SHA-256; the token it hands out is encrypted with a key derived from the
-- code itself, so the database alone can't give the token back. Deleted with its token or
-- cluster, and when the cluster's tokens rotate (a token issued or revoked).
CREATE TABLE install_codes (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  cluster_id uuid NOT NULL,
  token_id uuid NOT NULL REFERENCES cluster_tokens (id) ON DELETE CASCADE,
  code_hash bytea NOT NULL UNIQUE,
  token_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (cluster_id, org_id) REFERENCES clusters (id, org_id) ON DELETE CASCADE
);
CREATE INDEX install_codes_cluster_idx ON install_codes (cluster_id);
ALTER TABLE install_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON install_codes
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);

-- The first-week checklist per user and org: when the card was dismissed, and which steps
-- were already reported to the funnel (so each is reported once).
CREATE TABLE onboarding_states (
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  dismissed_at timestamptz,
  reported text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE TRIGGER onboarding_states_set_updated_at BEFORE UPDATE ON onboarding_states
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE onboarding_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON onboarding_states
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
