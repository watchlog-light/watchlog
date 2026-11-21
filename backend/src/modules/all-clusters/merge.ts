// SPDX-License-Identifier: AGPL-3.0-only
// The same problem in two places is one row (ADR-226): "Needs attention, everywhere" merges
// open problems of different clusters and fleets when, and only when,
//   - they come from the same alert rule (its default key, or the same rule),
//   - about the same workload name: Kubernetes, the workload (the namespace may differ);
//     Server fleets, the same systemd unit, process group or container (its Compose service
//     when it has one, else its name),
//   - both are open, and they started within 30 minutes of each other.
// Nothing fuzzier: no similar names, no "same symptom", no merging inside one cluster (its
// own Overview already merged that), and a problem without a workload (a node, a silent
// server) is never merged.

export const MERGE_WINDOW_MS = 30 * 60_000;

export type ClusterKind = 'kubernetes' | 'server';

export interface PlacedProblem {
  clusterId: string;
  clusterKind: ClusterKind;
  /** The alert rule's default key (`k8s.pod.crashloop`), null for a custom rule. */
  ruleKey: string | null;
  /** The rule's id: the identity of a custom rule (an org-wide rule has one id everywhere). */
  ruleId: string | null;
  /** The firing alert's labels. */
  labels: Record<string, string>;
  /** When it started (ISO), null when unknown (never merged). */
  since: string | null;
}

/**
 * What the problem is about, in its kind's words, or null when it names no workload. The
 * prefix keeps a Kubernetes workload and a server unit of the same name apart.
 */
export function workloadOf(kind: ClusterKind, labels: Record<string, string>): string | null {
  if (kind === 'kubernetes') return labels.workload ? `workload:${labels.workload}` : null;
  if (labels.unit) return `unit:${labels.unit}`;
  if (labels.group) return `group:${labels.group}`;
  if (labels.compose_service) return `container:${labels.compose_service}`;
  if (labels.container) return `container:${labels.container}`;
  return null;
}

/** The rule's identity: its default key, else the rule itself. */
export function ruleOf(p: Pick<PlacedProblem, 'ruleKey' | 'ruleId'>): string | null {
  return p.ruleKey ? `key:${p.ruleKey}` : p.ruleId ? `rule:${p.ruleId}` : null;
}

/**
 * Groups problems into rows: each inner array is one row, its members in different clusters
 * and fleets, oldest first. Rows keep the input's order of their first member.
 */
export function mergeProblems<T extends PlacedProblem>(items: T[]): T[][] {
  const rows: { members: T[]; identity: string | null; first: number; last: number }[] = [];
  // Oldest first, so a row's window is measured from its first member.
  const order = items
    .map((p, i) => ({ p, i, t: p.since ? Date.parse(p.since) : NaN }))
    .sort((a, b) => (a.t || 0) - (b.t || 0) || a.i - b.i);
  const rowOf = new Map<number, number>();
  for (const { p, i, t } of order) {
    const rule = ruleOf(p);
    const workload = workloadOf(p.clusterKind, p.labels);
    const identity = rule && workload && Number.isFinite(t) ? `${rule}\u0000${workload}` : null;
    const at = identity
      ? rows.findIndex(
          (r) =>
            r.identity === identity &&
            t - r.first <= MERGE_WINDOW_MS &&
            r.last - t <= MERGE_WINDOW_MS &&
            !r.members.some((m) => m.clusterId === p.clusterId),
        )
      : -1;
    if (at >= 0) {
      const r = rows[at]!;
      r.members.push(p);
      r.first = Math.min(r.first, t);
      r.last = Math.max(r.last, t);
      rowOf.set(i, at);
    } else {
      rows.push({ members: [p], identity, first: t, last: t });
      rowOf.set(i, rows.length - 1);
    }
  }
  // Back to the input's order of each row's first-listed member.
  const seen = new Set<number>();
  const out: T[][] = [];
  items.forEach((_, i) => {
    const r = rowOf.get(i)!;
    if (seen.has(r)) return;
    seen.add(r);
    out.push(rows[r]!.members);
  });
  return out;
}
