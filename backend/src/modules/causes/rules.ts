// SPDX-License-Identifier: AGPL-3.0-only
// The rule interface and the catalog (ADR-150). A rule is a pure function of an evidence
// snapshot: it says which objects it applies to and, when its evidence is there, returns a
// candidate cause with its chain. Strength is not the rule's to give: ranking (rank.ts) gives
// it from the chain and the timing (ADR-147).
//
// Adding a rule (slices 2–4): a file in rules/ exporting a Rule, added to RULES below; its
// codes in web/src/i18n/en.json (causes.cause.<code>, causes.headline.<code>, causes.step.<code>)
// and a fixture case in web/test/cause-templates.test.ts; unit tests from evidence fixtures
// (test/support/causes.ts).
import type { Evidence, Focus } from './evidence.js';
import type { Candidate, CheckTopic, Platform } from './types.js';

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

/** What a rule returns: a candidate, without what the engine fills in. */
export type Match = Omit<Candidate, 'rule' | 'hops' | 'explains'> & {
  /** The checks it explains, when not the rule's own list. */
  explains?: CheckTopic[];
};

export interface Rule {
  code: RuleCode;
  /** ImagePullBackOff and FailedScheduling have no Docker form (ADR-149). */
  platforms: Platform[];
  /** Whether it applies to this object at all (a pod, a workload, a container…). */
  applies(focus: Focus, platform: Platform): boolean;
  /** Its cause, when the evidence shows it; null otherwise. */
  match(ev: Evidence): Match | null;
  /** The checks its cause explains, for "What we checked". */
  explains: CheckTopic[];
}

/** The catalog's rules, in ADR-150's order. Slice 1 has none: every answer is "no clear cause". */
export const RULES: Rule[] = [];

export const catalogIndex = (code: string) => {
  const i = (CATALOG as readonly string[]).indexOf(code);
  return i < 0 ? CATALOG.length : i;
};

/** Every rule that applies to the snapshot's object, asked in catalog order. */
export function runRules(ev: Evidence, rules: Rule[] = RULES, hops = 0): Candidate[] {
  const out: Candidate[] = [];
  for (const r of rules) {
    if (!r.platforms.includes(ev.platform) || !r.applies(ev.focus, ev.platform)) continue;
    const m = r.match(ev);
    if (m) out.push({ ...m, rule: r.code, hops, explains: m.explains ?? r.explains });
  }
  return out;
}
