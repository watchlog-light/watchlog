-- Up Migration
-- Multi-user (v0.3, ADR-140): invites by link (emailed when SMTP is set up), password
-- reset links, the log of user changes, and one Owner per organization. Installs so far
-- have one user, the Owner: nothing to convert (ADR-107).

-- A link that lets someone join with a role. The token is checked by its SHA-256; while
-- pending, the link is also kept encrypted (WATCHLOG_SECRET_KEY, bound to the invite's
-- id) so Owners and Admins can copy it again. Cleared when used, revoked or expired.
CREATE TABLE invites (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email) AND length(email) <= 254),
  role text NOT NULL CHECK (role IN ('admin', 'viewer')),
  token_hash bytea NOT NULL UNIQUE,
  token_ciphertext text,
  invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
  -- The inviter's name when it was made, for the accept page after they're gone.
  invited_by_name text CHECK (length(invited_by_name) <= 256),
  emailed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz
);
-- One open invite per address.
CREATE UNIQUE INDEX invites_open_email_key ON invites (org_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- A single-use link to set a new password, valid for one hour. The old password works
-- until a new one is set.
CREATE TABLE password_resets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  -- Who made it: an Owner or Admin (created_by), the user themself by email, or the
  -- command line inside the backend container.
  via text NOT NULL CHECK (via IN ('admin', 'email', 'cli')),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id);

-- Who changed which user, when and from where (ADR-140). Never a token or password.
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN (
    'invite_created', 'invite_copied', 'invite_renewed', 'invite_revoked', 'invite_accepted',
    'role_changed', 'reset_link_created', 'password_reset', 'user_removed', 'ownership_transferred'
  )),
  actor_id uuid REFERENCES users (id) ON DELETE SET NULL,
  -- "command line" for the CLI; the actor's name at the time otherwise.
  actor_name text CHECK (length(actor_name) <= 256),
  subject_email text CHECK (length(subject_email) <= 254),
  ip text CHECK (length(ip) <= 64),
  details jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_at_idx ON audit_events (org_id, at DESC);

-- One Owner per organization (ADR-140): handing ownership over is one transaction.
CREATE UNIQUE INDEX memberships_one_owner_key ON memberships (org_id) WHERE role = 'owner';
