// SPDX-License-Identifier: AGPL-3.0-only
// Asking rules of one snapshot (rules.ts' runRules), apart from the catalog so that a rule can
// ask the object rules in turn (dependency_down asks them of the dependency) without an import
// cycle.
import type { Evidence } from '../evidence.js';
import type { Rule } from '../rules.js';
import type { Candidate } from '../types.js';

/** Every rule that applies to the snapshot's object; a rule's `covers` drops others' candidates. */
export function run(ev: Evidence, rules: readonly Rule[], hops = 0): Candidate[] {
  const out: Candidate[] = [];
  const covered = new Set<string>();
  for (const r of rules) {
    if (!r.platforms.includes(ev.platform) || !r.applies(ev.focus, ev.platform)) continue;
    const m = r.match(ev);
    if (!m) continue;
    const { covers, explains, ...rest } = m;
    for (const c of covers ?? []) covered.add(c);
    out.push({ ...rest, rule: r.code, hops, explains: explains ?? r.explains });
  }
  return out.filter((c) => !covered.has(c.rule));
}
