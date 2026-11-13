// SPDX-License-Identifier: AGPL-3.0-only
// The tables that hold no tenant data, and why (ADR-174). Every other table has org_id and
// Row-Level Security; a new table must have both or be added here with its reason.
export const GLOBAL_TABLES = [
  // A user can belong to several orgs; sessions and reset links are the user's.
  'users',
  'sessions',
  'password_resets',
  // The installation's settings (ADR-093); in Cloud the operator's, their routes 404.
  'server_settings',
  // The secret key's canary (ADR-133).
  'secret_key_check',
  // The alert workers' own state (ADR-088).
  'alert_worker_heartbeats',
  'alerting_periods',
  // Hashes of revoked cluster tokens, read by the ingest token check before any org.
  'retired_cluster_tokens',
  // node-pg-migrate's bookkeeping; watchlog_app has no grant on it.
  'pgmigrations',
] as const;
