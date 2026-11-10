// SPDX-License-Identifier: AGPL-3.0-only
// dns_nxdomain (ADR-150 #10): a name the subject looks up doesn't exist. From the service
// map's DNS rows of the subject (eBPF, ADR-113): NXDOMAIN answers, with search-path misses
// left out (a short name tried against each search domain first is no failure). When they
// began comes from the counted hour's NXDOMAIN series; a version change of the subject shortly
// before is where it starts ("after its rollout").
//
// Not counted: SERVFAIL and timeouts. They are the resolver's trouble, not a missing name
// (and some upstream resolvers answer SERVFAIL for any single-label name, measured on Lima),
// and on Docker a stopped container's name fails that way too: dependency_down's, at the
// far end of the edge that went quiet, which covers this rule on the caller.
//
// Which name failed isn't recorded (slice 0, gap 1: rcode counts per client only), so the
// words never name it, nor a "closest" name (ADR-153).
import { DNS_ERROR_RATIO, dnsTotals, shortName } from '../checks.js';
import type { Evidence } from '../evidence.js';
import { focusObject } from '../resolve.js';
import type { Match, Rule } from '../rules.js';
import type { Step } from '../types.js';
import { runFrom } from '../walk.js';
import { changeStep, iso, ROLLOUT_PODS_MS, SAME_MS, versionChanges } from './common.js';

/** At least this many NXDOMAIN answers a minute (one failed lookup is no pattern). */
export const NXDOMAIN_MIN_PER_MINUTE = 2;

/** When the current run of NXDOMAIN answers began; null when unknown or all hour. */
export function nxdomainSince(ev: Evidence): string | null {
  const m = ev.metrics;
  const pts = (m?.nxdomain ?? []).filter(([, v]) => Number.isFinite(v));
  if (!m || !pts.length) return null;
  // The newest points lag the clock: the run is counted back from the newest point > 0.
  let end = pts.length - 1;
  while (end >= 0 && !(pts[end]![1] > 0)) end--;
  const times = pts.slice(0, end + 1).map(([t]) => t);
  const values = new Map(pts);
  const t = runFrom(times, (x) => (values.get(x) ?? 0) > 0, Date.parse(m.from) / 1000, m.step);
  return t === null ? null : iso(t);
}

export const dnsNxdomain: Rule = {
  code: 'dns_nxdomain',
  platforms: ['kubernetes', 'docker'],
  applies: (f) => ['pod', 'workload', 'container', 'compose_service'].includes(f.kind),
  match(ev: Evidence): Match | null {
    if (ev.map.mode !== 'flows' || ev.gone) return null;
    const d = dnsTotals(ev);
    const perMinute = Math.round(d.nxdomain * 60);
    if (
      perMinute < NXDOMAIN_MIN_PER_MINUTE ||
      d.nxdomain / Math.max(d.lookups, d.nxdomain) < DNS_ERROR_RATIO
    )
      return null;
    const object = focusObject(ev.focus, ev.platform)!;
    const since = nxdomainSince(ev);
    // A version change of the subject shortly before the failures began.
    const change = since
      ? versionChanges(ev).find(
          (m) =>
            Date.parse(m.ts) <= Date.parse(since) + SAME_MS &&
            Date.parse(m.ts) >= Date.parse(since) - ROLLOUT_PODS_MS,
        )
      : undefined;
    const name = shortName(ev);
    const step: Step = {
      object,
      source: 'dns',
      code: 'nxdomain',
      facts: { perMinute },
      at: null,
      since,
      next: change ? 'after' : null,
    };
    return {
      code: 'dns_nxdomain',
      facts: { name, perMinute },
      since: change?.ts ?? since,
      chain: change ? [step, changeStep(ev, change)] : [step],
      complete: true,
      headline: change
        ? { code: 'dns_nxdomain_change', facts: { name, perMinute } }
        : { code: 'dns_nxdomain', facts: { name, perMinute } },
      explains: change ? ['dns', 'changes'] : ['dns'],
    };
  },
  explains: ['dns'],
};
