// SPDX-License-Identifier: AGPL-3.0-only
// The cause catalog (ADR-150): the rule codes in tie-break order. Apart from rules.ts so that
// ranking and the rules can use it without an import cycle.
/** ADR-150's catalog, in tie-break order. */
export const CATALOG = [
  'dependency_down',
  'bad_change',
  'oom_limit',
  'crash_exit',
  'image_pull',
  'unschedulable',
  'node_or_host',
  'application_finding',
  'connection_refused',
  'dns_nxdomain',
  'cpu_throttled',
  'job_failed',
  // ADR-187: the egress alerts' own rule, asked only for them.
  'change_before_egress',
] as const;
export type RuleCode = (typeof CATALOG)[number];

export const catalogIndex = (code: string) => {
  const i = (CATALOG as readonly string[]).indexOf(code);
  return i < 0 ? CATALOG.length : i;
};

/**
 * The egress alerts (ADR-187): change_before_egress is asked for them alone, and their symptom
 * is the first connection (the alert's start), not when it fired.
 */
export const EGRESS_ALERT_KEYS: ReadonlySet<string> = new Set([
  'egress.new_destination',
  'egress.raw_ip',
  'egress.large_upload_new',
]);
