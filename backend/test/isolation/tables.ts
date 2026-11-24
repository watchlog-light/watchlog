// SPDX-License-Identifier: AGPL-3.0-only
// The tables that hold no tenant data, and why (ADR-174). Every other table has org_id and
// Row-Level Security; a new table must have both or be added here with its reason.
export const GLOBAL_TABLES = [
  // A user can belong to several orgs; sessions and reset links are the user's.
  'users',
  'sessions',
  'password_resets',
  // Cloud accounts (ADR-175): a user's sign-in methods, verification links and 2FA codes.
  'user_identities',
  'email_tokens',
  'recovery_codes',
  // The installation's settings (ADR-093); in Cloud the operator's, their routes 404.
  'server_settings',
  // The installation's licence (ADR-232): the one reminder each key gets.
  'license_notices',
  // The secret key's canary (ADR-133).
  'secret_key_check',
  // The alert workers' own state (ADR-088).
  'alert_worker_heartbeats',
  'alerting_periods',
  // Hashes of revoked cluster tokens, read by the ingest token check before any org.
  'retired_cluster_tokens',
  // Cloud (ADR-181): the record of each org deletion, kept after the org's rows are gone.
  'org_deletions',
  // Cloud (ADR-173): the signup mode and the signup invites of the waves, before any org.
  'cloud_settings',
  'signup_invites',
  // node-pg-migrate's bookkeeping; watchlog_app has no grant on it. Enterprise modules'
  // migrations (ADR-233) keep their own, present only with ee/.
  'pgmigrations',
  'pgmigrations_ee',
  // The columns Enterprise modules encrypt, for rotate-secret-key (ADR-233): table names only.
  'module_secret_columns',
] as const;
