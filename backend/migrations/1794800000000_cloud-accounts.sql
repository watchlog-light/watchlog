-- Up Migration
-- Accounts in Cloud (ADR-175): email verification, GitHub and Google identities, TOTP with
-- recovery codes, a current org and a 2FA step per session, and a minimal entitlements row
-- per org (slice 4 of the Cloud build owns that table and adds the limits).
--
-- Community never writes any of it: its routes are Cloud-only. users.password_hash becomes
-- nullable for accounts made with GitHub or Google, and the unique email index covers the
-- accounts with a password only: an account made with GitHub stays separate from a password
-- account with the same address until its owner links them (ADR-175). Community's users all
-- have a password, so for Community the constraint is the same as before.

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
DROP INDEX users_email_key;
CREATE UNIQUE INDEX users_email_key ON users (email) WHERE password_hash IS NOT NULL;
CREATE INDEX users_email_idx ON users (email);

ALTER TABLE users
  -- AES-256-GCM under WATCHLOG_SECRET_KEY, bound to the user's id (ADR-079).
  ADD COLUMN totp_secret text,
  -- Set once the first code was confirmed; until then the secret is only being set up.
  ADD COLUMN totp_enabled_at timestamptz,
  -- The last 30-second step accepted, so a code is never accepted twice.
  ADD COLUMN totp_last_step bigint,
  ADD COLUMN disabled_at timestamptz;

ALTER TABLE sessions
  -- The org the session works in; null: the user's first membership. Not named org_id: a
  -- session is the user's, not an org's row (only tenant tables carry org_id, ADR-174).
  ADD COLUMN current_org_id uuid REFERENCES orgs (id) ON DELETE SET NULL,
  -- `mfa`: the password or OAuth step passed, the TOTP code not yet (10 minutes).
  ADD COLUMN stage text NOT NULL DEFAULT 'full' CHECK (stage IN ('full', 'mfa')),
  ADD COLUMN mfa_passed_at timestamptz,
  ADD COLUMN mfa_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN ip text CHECK (length(ip) <= 64),
  ADD COLUMN user_agent text CHECK (length(user_agent) <= 256);

-- GitHub and Google accounts, linked by the provider's id only (never by email).
CREATE TABLE user_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('github', 'google')),
  provider_user_id text NOT NULL CHECK (length(provider_user_id) BETWEEN 1 AND 128),
  -- The provider's verified address when linked; shown, never used to match accounts.
  email text CHECK (length(email) <= 254),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (provider, provider_user_id),
  UNIQUE (user_id, provider)
);

-- Email verification links: 256-bit tokens stored as SHA-256 (ADR-025), single-use.
CREATE TABLE email_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify')),
  -- The address the link proves; a later change of address makes the link useless.
  email text NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX email_tokens_user_idx ON email_tokens (user_id);

-- Ten single-use recovery codes per user with TOTP, stored as SHA-256.
CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash bytea NOT NULL CHECK (length(code_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  UNIQUE (user_id, code_hash)
);

-- What an org may use (ADR-177). A stub here: the plan and where it comes from. Slice 4 of
-- the Cloud build adds the limits; the billing service and staff write it.
CREATE TABLE entitlements (
  org_id uuid PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
  plan text NOT NULL CHECK (plan IN ('free', 'pro', 'enterprise')),
  source text NOT NULL CHECK (source IN ('signup', 'beta', 'billing', 'staff')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER entitlements_set_updated_at BEFORE UPDATE ON entitlements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON entitlements
  USING (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid)
  WITH CHECK (org_id = nullif(current_setting('watchlog.org_id', true), '')::uuid);
