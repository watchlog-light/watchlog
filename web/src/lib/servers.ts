// SPDX-License-Identifier: AGPL-3.0-only
// Server fleets (ADR-207): grouping a server's workloads by unit, their words and links.
import type { RouteLocationRaw } from 'vue-router';
import type { ServerWorkload } from '@watchlog/api-types';

export type Source = ServerWorkload['source'];
export type Problem = NonNullable<ServerWorkload['problem']>;

/** A row of the server's workloads table: a workload, indented when inside a unit. */
export interface WorkloadRow {
  w: ServerWorkload;
  /** A process group shown under the service it runs in (pm2's apps under pm2-app.service). */
  child: boolean;
}

/**
 * The workloads table's rows (the canvas: grouped by unit): each service followed by the
 * process groups inside it; groups without a unit and containers after, problems first.
 * System services are left out unless `system` is set.
 */
export function groupByUnit(list: ServerWorkload[], system = false): WorkloadRow[] {
  const visible = list.filter((w) => system || !w.system);
  const byUnit = new Map<string, ServerWorkload[]>();
  for (const w of visible) {
    if (w.source === 'process' && w.unit) {
      const l = byUnit.get(w.unit) ?? [];
      l.push(w);
      byUnit.set(w.unit, l);
    }
  }
  const services = new Set(visible.filter((w) => w.source === 'service').map((w) => w.name));
  const rows: WorkloadRow[] = [];
  for (const w of visible) {
    if (w.source === 'process' && w.unit && services.has(w.unit)) continue; // under its unit
    rows.push({ w, child: false });
    if (w.source === 'service') {
      for (const c of byUnit.get(w.name) ?? []) rows.push({ w: c, child: true });
    }
  }
  return rows;
}

/** The i18n key of a problem's short words ("crash-looping", "failed"…). */
export const problemKey = (p: Problem) => `servers.problem.${p.kind}`;

export const tone = (p: Problem | null | undefined): 'critical' | 'warning' | 'ok' =>
  p ? p.severity : 'ok';

/** The page of a workload: containers keep their own page (logs, health, diagnosis). */
export function workloadLink(
  server: string,
  w: Pick<ServerWorkload, 'id' | 'source' | 'name'>,
): RouteLocationRaw {
  if (w.source === 'container') {
    return { name: 'docker-container', params: { host: server, name: w.name } };
  }
  return { name: 'server-workload', params: { server, workload: w.id } };
}

/** Ports as the table shows them: ":80 :443", at most four, then "+N". */
export function portsText(ports: number[]): string {
  const shown = ports.slice(0, 4).map((p) => `:${p}`);
  if (ports.length > 4) shown.push(`+${ports.length - 4}`);
  return shown.join(' ');
}

/** Days a server has been up, from its boot time (Unix seconds). */
export function upDays(bootTime: number | null | undefined, now = Date.now()): number | null {
  if (!bootTime) return null;
  return Math.max(0, Math.floor((now / 1000 - bootTime) / 86400));
}

/** The OS's short name for the header chip ("Debian GNU/Linux 12 (bookworm)" → "Debian 12"). */
export function shortOs(os: string | null | undefined): string | null {
  if (!os) return null;
  const m = /^(\w+)(?:\s+GNU\/Linux)?\s+([\d.]+)/.exec(os);
  if (m) return `${m[1]} ${m[2]}`;
  return os.replace(/\s*\(.*\)$/, '');
}

/** The kernel's major.minor for the header chip ("6.1.0-53-cloud-arm64" → "6.1"). */
export function shortKernel(k: string | null | undefined): string | null {
  if (!k) return null;
  return /^(\d+\.\d+)/.exec(k)?.[1] ?? k;
}

/**
 * The exits timeline's bars: one per minute, its height the failed exits and kills (or the
 * restarts where no exit was seen), scaled to the busiest minute.
 */
export function timelineBars(
  points: number[][],
): { t: number; crashes: number; restarts: number; oom: number; h: number }[] {
  const rows = points.map((p) => ({
    t: p[0] ?? 0,
    crashes: (p[1] ?? 0) + (p[2] ?? 0),
    restarts: p[3] ?? 0,
    oom: p[4] ?? 0,
  }));
  const max = Math.max(1, ...rows.map((r) => Math.max(r.crashes, r.restarts)));
  return rows.map((r) => ({ ...r, h: Math.max(r.crashes, r.restarts) / max }));
}
