// SPDX-License-Identifier: AGPL-3.0-only
// What WatchLog sees about a service (ADR-137): its health first, then each member that
// can't be reached, the privileges it lacks, and the integration's own findings. Every
// reason is a code with facts; the web and the MCP tools write the words.
import type { Health } from '../service.js';
import type { Reason, Severity } from './types.js';

const SEVERITY: Record<Health, Severity> = {
  ok: 'ok',
  warning: 'warning',
  critical: 'critical',
  unknown: 'info',
};

const ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2, ok: 3 };

interface Details {
  members?: { name: string; up: boolean; error?: string }[];
  permissions?: { tab: string; missing: string }[];
}

/** The reasons that come from the collector's reports, for any service type. */
export function statusReasons(
  health: Health,
  reason: { code: string; facts: Record<string, string | number | null> },
  details: unknown,
  target: { kind: string; namespace?: string; workload_kind?: string; workload?: string },
): Reason[] {
  const out: Reason[] = [{ severity: SEVERITY[health], code: reason.code, facts: reason.facts }];
  // Member details only mean something while the collector reports.
  if (reason.code !== 'connected' && reason.code !== 'unreachable') return out;
  const d = (details ?? {}) as Details;
  const members = d.members ?? [];
  const down = members.filter((m) => !m.up);
  // One member of several: say which; all of them is the unreachable reason already.
  if (down.length > 0 && down.length < members.length) {
    for (const m of down.slice(0, 5)) {
      out.push({
        severity: 'warning',
        code: 'member_down',
        facts: { member: m.name, error: m.error ?? null },
        links:
          target.kind === 'workload'
            ? [
                {
                  kind: 'workload',
                  id: `${target.namespace}/${target.workload_kind}/${target.workload}`,
                  name: m.name,
                },
              ]
            : [{ kind: 'container', id: m.name, name: m.name }],
      });
    }
  }
  for (const p of d.permissions ?? []) {
    out.push({
      severity: 'info',
      code: 'needs_permission',
      facts: { tab: p.tab, missing: p.missing },
    });
  }
  return out;
}

/** Most severe first; equal ones keep their order. */
export function sortReasons(reasons: Reason[]): Reason[] {
  return reasons
    .map((r, i) => [r, i] as const)
    .sort(([a, i], [b, j]) => ORDER[a.severity] - ORDER[b.severity] || i - j)
    .map(([r]) => r);
}
