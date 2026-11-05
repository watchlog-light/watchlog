// SPDX-License-Identifier: AGPL-3.0-only
// Silence matchers (ADR-077): equality on rule, cluster, namespace, workload, node
// and severity. Every field that is set must match.
import type { Severity } from './state-machine.js';

export const SILENCE_FIELDS = [
  'rule',
  'cluster',
  'namespace',
  'workload',
  'node',
  'severity',
] as const;
export type SilenceMatchers = Partial<Record<(typeof SILENCE_FIELDS)[number], string>>;

export interface ActiveSilence {
  matchers: SilenceMatchers;
  startsAt: number;
  endsAt: number;
}

/** The labels a silence sees: the alert's labels plus its rule, cluster and severity. */
export function silenceTarget(
  labels: Record<string, string>,
  ruleId: string,
  clusterId: string,
  severity: Severity,
): Record<string, string> {
  return { ...labels, rule: ruleId, cluster: clusterId, severity };
}

export function isSilenced(
  silences: ActiveSilence[],
  target: Record<string, string>,
  now: number,
): boolean {
  return silences.some(
    (s) =>
      s.startsAt <= now &&
      now < s.endsAt &&
      SILENCE_FIELDS.some((f) => s.matchers[f] !== undefined) &&
      SILENCE_FIELDS.every((f) => s.matchers[f] === undefined || s.matchers[f] === target[f]),
  );
}
