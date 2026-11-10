// SPDX-License-Identifier: AGPL-3.0-only
// The rule interface and the catalog (ADR-150). A rule is a pure function of an evidence
// snapshot: it says which objects it applies to and, when its evidence is there, returns a
// candidate cause with its chain. Strength is not the rule's to give: ranking (rank.ts) gives
// it from the chain and the timing (ADR-147).
//
// Adding a rule: a file in rules/ exporting a Rule, added to RULES below (or OWN_RULES); its
// codes in web/src/i18n/en.json (causes.cause.<code>, causes.headline.<code>, causes.step.<code>)
// and a fixture case in web/test/cause-templates.test.ts; unit tests from evidence fixtures
// (test/support/causes.ts).
import type { RuleCode } from './catalog.js';
import type { Evidence, Focus } from './evidence.js';
import { applicationFinding } from './rules/application-finding.js';
import { connectionRefused } from './rules/connection-refused.js';
import { dependencyDown } from './rules/dependency-down.js';
import { dnsNxdomain } from './rules/dns-nxdomain.js';
import { OWN_RULES } from './rules/own.js';
import { run } from './rules/run.js';
import type { Candidate, CheckTopic, Platform } from './types.js';

export { CATALOG, catalogIndex, type RuleCode } from './catalog.js';

/** What a rule returns: a candidate, without what the engine fills in. */
export type Match = Omit<Candidate, 'rule' | 'hops' | 'explains'> & {
  /** The checks it explains, when not the rule's own list. */
  explains?: CheckTopic[];
  /**
   * Rules whose cause on the same object is a step of this one's chain (bad_change's new
   * version crashing is crash_exit's exit): their candidates are dropped when this matches.
   */
  covers?: RuleCode[];
  /** Rules on the caller one hop back this one explains (Candidate.coversCaller). */
  coversCaller?: RuleCode[];
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

/**
 * The catalog's rules. Slice 2: the rules on the object itself (OWN_RULES, rules/own.ts).
 * Slice 3: the rules across the map, which read what the walk followed (`ev.via`) or the
 * object's DNS and application findings. Slice 4: the rules under it (node_or_host,
 * cpu_throttled), in OWN_RULES, so dependency_down and a consumer's chain find them at the
 * far end too.
 */
export const RULES: Rule[] = [
  ...OWN_RULES,
  dependencyDown,
  connectionRefused,
  dnsNxdomain,
  applicationFinding,
];

/**
 * Rules about the calls the object makes, not the object itself: a complete cause from one
 * of them doesn't stop the walk, since what it calls may explain it better (a name that no
 * longer resolves because the container behind it stopped; a finding with a consumer behind it).
 */
export const CALL_RULES: readonly string[] = ['dns_nxdomain', 'application_finding'];

/** Every rule that applies to the snapshot's object, asked in catalog order. */
export function runRules(ev: Evidence, rules: Rule[] = RULES, hops = 0): Candidate[] {
  return run(ev, rules, hops);
}
