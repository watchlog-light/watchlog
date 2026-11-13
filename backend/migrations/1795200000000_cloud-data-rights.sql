-- Up Migration
-- Cloud's data rights and inactive orgs (ADR-181). Community never writes any of these.

-- Deletion with a 7-day undo: an Owner asks, the org's ingest answers 402 and its Owners
-- see a banner with Undo; after `deletion_due_at` the worker deletes everything.
ALTER TABLE orgs
  ADD COLUMN deletion_requested_at timestamptz,
  ADD COLUMN deletion_due_at timestamptz,
  ADD COLUMN deletion_requested_by uuid REFERENCES users (id) ON DELETE SET NULL,
  -- A Free org with no data for 30 days is warned (this column); 7 days later it is
  -- suspended. Data arriving before then clears it.
  ADD COLUMN inactive_warned_at timestamptz,
  -- When the count of days without data starts again: a suspension lifted by staff or
  -- the Owners' "Reactivate".
  ADD COLUMN inactivity_reset_at timestamptz,
  -- Who suspended it: staff (the internal admin API) or the inactivity rule, which its
  -- Owners can lift themselves. NULL with suspended_at set means staff (before 0.6.0).
  ADD COLUMN suspension_kind text CHECK (suspension_kind IN ('staff', 'inactive')),
  ADD CONSTRAINT orgs_deletion_check CHECK (
    (deletion_requested_at IS NULL) = (deletion_due_at IS NULL)
  );
CREATE INDEX orgs_deletion_due_idx ON orgs (deletion_due_at) WHERE deletion_due_at IS NOT NULL;

-- The record of each deletion, kept after the org's rows are gone (no foreign keys): which
-- org, when it was asked for and by whom, when it ran, and what it removed. Not tenant
-- data (so not `org_id`): written by the worker on the owner's connection, read by staff.
-- Row-Level Security on without a policy: the request path's role sees no row of it.
CREATE TABLE org_deletions (
  deleted_org_id uuid PRIMARY KEY,
  org_name text NOT NULL,
  requested_at timestamptz NOT NULL,
  requested_by uuid,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  cluster_ids uuid[] NOT NULL DEFAULT '{}',
  users_deleted integer NOT NULL DEFAULT 0,
  -- {"3d": n, "30d": n} or {"all": n}: series VictoriaMetrics reported deleted per tier.
  series jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE org_deletions ENABLE ROW LEVEL SECURITY;

-- What an Owner did with the org's data, in its audit events.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check CHECK (action IN (
  'invite_created', 'invite_copied', 'invite_renewed', 'invite_revoked', 'invite_accepted',
  'role_changed', 'reset_link_created', 'password_reset', 'user_removed', 'ownership_transferred',
  'logs_read',
  'staff_entitlements_set', 'staff_org_suspended', 'staff_org_unsuspended',
  'support_session_started', 'support_session_ended', 'support_tokens_accessed',
  'org_exported', 'org_deletion_requested', 'org_deletion_cancelled',
  'org_inactive_warned', 'org_inactive_suspended', 'org_reactivated'
));
