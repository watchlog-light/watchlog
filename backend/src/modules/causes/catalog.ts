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
] as const;
export type RuleCode = (typeof CATALOG)[number];

export const catalogIndex = (code: string) => {
  const i = (CATALOG as readonly string[]).indexOf(code);
  return i < 0 ? CATALOG.length : i;
};
