// SPDX-License-Identifier: AGPL-3.0-only
// The Workloads page's rules (ADR-111): grouping by
// namespace with problems first, the system-namespace filter, short image names, pod
// squares, CronJob schedules in words and the row filters.
import type { KubePod, KubeWorkload } from '@watchlog/api-types';

export type Severity = 'critical' | 'warning';

export interface Group<T> {
  namespace: string;
  rows: T[];
  /** Rows that need attention. */
  problems: number;
}

/** A row with its problem: a workload, a Docker container. */
export type ProblemRow = { problem: { severity: Severity } | null };
export type Row = (ProblemRow | KubePod) & { namespace: string; name: string };

/** A row's problem severity; a pod's (failing is critical, pending a warning), else null. */
export function severityOf(row: ProblemRow | KubePod): Severity | null {
  if ('problem' in row) return row.problem?.severity ?? null;
  return row.failing ? 'critical' : row.phase === 'Pending' ? 'warning' : null;
}
const RANK: Record<string, number> = { critical: 0, warning: 1, none: 2 };
const rankOf = (r: ProblemRow | KubePod) => RANK[severityOf(r) ?? 'none']!;

/**
 * Rows grouped by namespace (Docker: Compose project): the most problems first, then by name;
 * within one, problem rows first (critical before warning), then by name.
 */
export function groupByNamespace<T extends Row>(rows: T[]): Group<T>[] {
  const by = new Map<string, T[]>();
  for (const r of rows) {
    const list = by.get(r.namespace);
    if (list) list.push(r);
    else by.set(r.namespace, [r]);
  }
  return [...by]
    .map(([namespace, list]) => ({
      namespace,
      rows: list.sort((a, b) => rankOf(a) - rankOf(b) || a.name.localeCompare(b.name)),
      problems: list.filter((r) => severityOf(r)).length,
    }))
    .sort((a, b) => b.problems - a.problems || a.namespace.localeCompare(b.namespace));
}

/** The image as name:tag, without registry and path; a digest shortened to 7 characters. */
export function shortImage(ref: string): string {
  const [path = ref, digest] = ref.split('@');
  const name = path.split('/').pop() ?? path;
  return digest ? `${name}@${digest.replace(/^sha256:/, '').slice(0, 7)}` : name;
}

export type Square = 'ready' | 'starting' | 'failing' | 'missing';

/** One square per pod, padded with "missing" up to the desired count. */
export function squares(states: KubeWorkload['podStates'], desired: number | null): Square[] {
  const out: Square[] = [...states];
  for (let i = out.length; i < (desired ?? 0); i++) out.push('missing');
  return out;
}

type T = (key: string, values?: Record<string, unknown>) => string;

/** A cron schedule in words for the common forms, else the schedule itself. */
export function cronText(schedule: string, t: T): string {
  const f = schedule.trim().split(/\s+/);
  if (f.length !== 5) return schedule;
  const [min, hour, dom, mon, dow] = f;
  const rest = dom === '*' && mon === '*' && dow === '*';
  if (rest && min === '*' && hour === '*') return t('kube.cron.everyMinute');
  const step = /^\*\/(\d+)$/.exec(min!);
  if (rest && step && hour === '*') return t('kube.cron.everyMinutes', { n: Number(step[1]) });
  if (rest && /^\d+$/.test(min!) && hour === '*')
    return t('kube.cron.hourly', { m: min!.padStart(2, '0') });
  if (rest && /^\d+$/.test(min!) && /^\d+$/.test(hour!))
    return t('kube.cron.daily', { time: `${hour!.padStart(2, '0')}:${min!.padStart(2, '0')}` });
  return schedule;
}

/** Restarts in the range that deserve a ▲: more than 3 per 10 minutes on average, or 20. */
export function restartsHigh(n: number | null, rangeSeconds: number): boolean {
  if (n === null) return false;
  return n >= Math.min(20, Math.max(5, (rangeSeconds / 600) * 3));
}

export interface WorkloadFilter {
  kinds: string[];
  failing: boolean;
  hideSystem: boolean;
  system: Set<string>;
  terms: string[];
}

const matches = (fields: (string | null | undefined)[], terms: string[]) => {
  const text = fields.filter(Boolean).join(' ').toLowerCase();
  return terms.every((t) => text.includes(t));
};

/** Workloads left after the system, kind, failing and search filters. */
export function filterWorkloads(rows: KubeWorkload[], f: WorkloadFilter): KubeWorkload[] {
  return rows.filter(
    (w) =>
      (!f.hideSystem || !f.system.has(w.namespace)) &&
      (!f.kinds.length || f.kinds.includes(w.kind)) &&
      (!f.failing || !!w.problem) &&
      matches([w.name, w.namespace, w.kind, ...w.images], f.terms),
  );
}

/** Pods left after the system, failing, owner and search filters. */
export function filterPods(
  rows: KubePod[],
  f: Omit<WorkloadFilter, 'kinds'> & {
    owner: { kind: string; name: string; namespace: string } | null;
  },
): KubePod[] {
  return rows.filter(
    (p) =>
      (!f.hideSystem || !f.system.has(p.namespace)) &&
      (!f.failing || !!severityOf(p)) &&
      (!f.owner ||
        (p.workloadKind === f.owner.kind &&
          p.workload === f.owner.name &&
          p.namespace === f.owner.namespace)) &&
      matches([p.name, p.namespace, p.node, p.workload, p.status], f.terms),
  );
}
