-- Up Migration
-- Invite waves, then public signup (ADR-173). Cloud only: Community never writes these.

-- Cloud's installation-wide settings that staff change through the internal admin API.
-- One key so far: `signup_mode` ({"mode": "invite"|"public"}); no row means `invite`.
-- Not tenant data; Row-Level Security on without a policy, so the request path's role
-- sees no row (the signup routes read it on the owner's connection).
CREATE TABLE cloud_settings (
  key text PRIMARY KEY CHECK (key IN ('signup_mode')),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The staff member's email (X-WatchLog-Staff).
  updated_by text NOT NULL
);
ALTER TABLE cloud_settings ENABLE ROW LEVEL SECURITY;

-- Signup invites: one code for one email, single use, valid 14 days, issued by staff for
-- a wave of the waitlist. Only the code's SHA-256 is stored. Issuing a new one for the
-- same address revokes the earlier unused one. Not tenant data (no org yet); RLS on
-- without a policy, like cloud_settings.
CREATE TABLE signup_invites (
  id uuid PRIMARY KEY,
  -- Lower-cased.
  email text NOT NULL,
  code_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by uuid REFERENCES users (id) ON DELETE SET NULL,
  revoked_at timestamptz,
  CONSTRAINT signup_invites_once CHECK (used_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX signup_invites_email_idx ON signup_invites (email, created_at DESC);
ALTER TABLE signup_invites ENABLE ROW LEVEL SECURITY;

