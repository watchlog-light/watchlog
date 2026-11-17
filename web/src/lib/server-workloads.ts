// SPDX-License-Identifier: AGPL-3.0-only
import type { ServerList } from '@watchlog/api-types';

// The fleet's Workloads page as the Kubernetes one (ADR-124's parity): by server, services
// with their process groups under them, pm2's and supervisord's apps under their manager,
// containers under their Compose project; the OS's and WatchLog's own hidden by default.
export type FleetWorkload = NonNullable<ServerList['workloads']>[number];
export type Source = 'service' | 'process' | 'container';

/** A row: a workload, or a Compose project made from its containers. */
export interface TreeRow {
  id: string;
  kind: Source | 'compose';
  w: FleetWorkload;
  depth: number;
  /** Rows nested under it that are shown. */
  children: number;
}

export interface ServerGroup {
  server: string;
  rows: TreeRow[];
  /** Workloads on it that need attention (any problem). */
  attention: number;
}

export interface Filters {
  /** Show the OS's own and WatchLog's own (off by default). */
  showSystem: boolean;
  /** One source only, or every one. */
  source: Source | 'all';
  /** Only failing (critical) workloads. */
  failing: boolean;
  term: string;
}

export interface Tree {
  servers: ServerGroup[];
  /** Workloads "Hide system" left out. */
  hiddenSystem: number;
  /** Counts for the chips, after "Hide system". */
  counts: { service: number; process: number; container: number; failing: number };
}

const SEVERITY = { critical: 0, warning: 1 } as const;
const rank = (w: FleetWorkload) => (w.problem ? SEVERITY[w.problem.severity] : 2);

/** Problems first, then the busiest, then by name: as the Kubernetes list. */
export function byProblemThenCpu(a: FleetWorkload, b: FleetWorkload): number {
  return rank(a) - rank(b) || (b.cpuCores ?? 0) - (a.cpuCores ?? 0) || a.name.localeCompare(b.name);
}

/** A Compose project's row: its containers summed; its worst problem. */
function composeRow(server: string, project: string, members: FleetWorkload[]): FleetWorkload {
  const sum = (f: (w: FleetWorkload) => number | null) =>
    members.some((m) => f(m) !== null) ? members.reduce((s, m) => s + (f(m) ?? 0), 0) : null;
  const worst = [...members].sort(byProblemThenCpu)[0]!;
  const running = members.filter((m) => m.state.startsWith('running')).length;
  return {
    ...worst,
    id: `compose:${project}`,
    source: 'container',
    name: project,
    unit: null,
    note: 'compose',
    state: `${running}/${members.length}`,
    problem: worst.problem,
    cpuCores: sum((m) => m.cpuCores),
    memoryBytes: sum((m) => m.memoryBytes),
    memoryLimitBytes: null,
    cpuLimitCores: null,
    instances: running,
    expected: members.length,
    ports: [],
    restarts24h: sum((m) => m.restarts24h) ?? 0,
    lastExitCode: null,
    system: members.every((m) => m.system),
    runs: null,
    changedAt: null,
    parent: null,
    server,
    cpuSeries: [],
  };
}

export function buildTree(all: FleetWorkload[], f: Filters): Tree {
  const term = f.term.trim().toLowerCase();
  const servers = [...new Set(all.map((w) => w.server))].sort();
  const counts = { service: 0, process: 0, container: 0, failing: 0 };
  let hiddenSystem = 0;
  const out: ServerGroup[] = [];
  for (const server of servers) {
    const mine = all.filter((w) => w.server === server);
    // Compose projects become rows of their own, their containers nested.
    const projects = new Map<string, FleetWorkload[]>();
    for (const w of mine)
      if (w.parent?.startsWith('compose:')) {
        const p = w.parent.slice('compose:'.length);
        projects.set(p, [...(projects.get(p) ?? []), w]);
      }
    const items: FleetWorkload[] = [
      ...mine,
      ...[...projects].map(([p, ms]) => composeRow(server, p, ms)),
    ];
    const byId = new Map(items.map((w) => [w.id, w]));
    const kindOf = (w: FleetWorkload): TreeRow['kind'] =>
      w.id.startsWith('compose:') ? 'compose' : w.source;

    // What "Hide system" and the chips leave; a name match keeps its ancestors too.
    const shown = new Set<string>();
    for (const w of items) {
      if (!f.showSystem && w.system) {
        if (!w.id.startsWith('compose:')) hiddenSystem++;
        continue;
      }
      if (!w.id.startsWith('compose:')) {
        counts[w.source]++;
        if (w.problem?.severity === 'critical') counts.failing++;
      }
      const k = kindOf(w);
      if (f.source !== 'all' && (k === 'compose' ? 'container' : k) !== f.source) continue;
      if (f.failing && w.problem?.severity !== 'critical') continue;
      if (term && !w.name.toLowerCase().includes(term)) continue;
      shown.add(w.id);
    }
    if (term)
      for (const id of [...shown]) {
        let p = byId.get(id)?.parent;
        while (p && byId.has(p) && !shown.has(p)) {
          const pw = byId.get(p)!;
          if (!f.showSystem && pw.system) break;
          shown.add(p);
          p = pw.parent;
        }
      }
    // Each shown row under its nearest shown ancestor; the rest at the top.
    const parentOf = (w: FleetWorkload): string | null => {
      let p = w.parent;
      while (p) {
        if (shown.has(p)) return p;
        p = byId.get(p)?.parent ?? null;
      }
      return null;
    };
    const kids = new Map<string | null, FleetWorkload[]>();
    for (const id of shown) {
      const w = byId.get(id)!;
      const p = parentOf(w);
      kids.set(p, [...(kids.get(p) ?? []), w]);
    }
    // A row ranks by the worst problem under it too: pm2 with a crash-looping app leads.
    const worst = new Map<string, number>();
    const rankOf = (w: FleetWorkload): number => {
      const known = worst.get(w.id);
      if (known !== undefined) return known;
      const r = Math.min(rank(w), ...(kids.get(w.id) ?? []).map(rankOf));
      worst.set(w.id, r);
      return r;
    };
    const order = (a: FleetWorkload, b: FleetWorkload) =>
      rankOf(a) - rankOf(b) || byProblemThenCpu(a, b);
    const rows: TreeRow[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const w of (kids.get(parent) ?? []).sort(order)) {
        rows.push({ id: w.id, kind: kindOf(w), w, depth, children: kids.get(w.id)?.length ?? 0 });
        walk(w.id, depth + 1);
      }
    };
    walk(null, 0);
    if (!rows.length) continue;
    out.push({
      server,
      rows,
      attention: mine.filter((w) => w.problem && (f.showSystem || !w.system)).length,
    });
  }
  // Servers that need attention first, then by name.
  out.sort(
    (a, b) => Number(b.attention > 0) - Number(a.attention > 0) || a.server.localeCompare(b.server),
  );
  return { servers: out, hiddenSystem, counts };
}
