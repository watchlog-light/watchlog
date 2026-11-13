// SPDX-License-Identifier: AGPL-3.0-only
// Right-sizing answers (ADR-168): the use over the window is read from VictoriaMetrics once
// an hour per cluster and kept; the requests and limits are read on every request (a changed
// request shows at once), and the hints are worked out from both.
import type { Database } from '../../db/index.js';
import type { VictoriaQueryClient } from '../../lib/victoria.js';
import { AnswerCache } from '../causes/cache.js';
import type { ContainerStatus, ObjectRow, PodSpec, PodStatus } from '../kubernetes/views.js';
import { parseQuantity, podIsActive } from '../kubernetes/views.js';
import { watchlogComponents } from '../servicemap/graph.js';
import { systemNamespaces, type SettingsService } from '../settings/service.js';
import {
  basedOn,
  dockerHints,
  enoughHistory,
  kubeHints,
  sortHints,
  summarize,
  type Hint,
  type HintObject,
  type NotEnoughHistory,
  type Summary,
  type Usage,
} from './hints.js';
import { byKey, HINT_KINDS, keyOf, usageByKey, usageExprs, type Series } from './queries.js';

export const RIGHT_SIZING_CACHE_MS = 60 * 60_000;

export interface RightSizingOptions {
  windowHours: number;
  minHistoryHours: number;
}

export interface Filters {
  namespace?: string;
  kind?: string;
  workload?: string;
  host?: string;
  container?: string;
  project?: string;
  service?: string;
  /** System namespaces and WatchLog's own containers too (ADR-111). */
  system?: boolean;
}

export interface Answer {
  window: { hours: number; minHistoryHours: number };
  computedAt: string;
  hints: Hint[];
  notEnoughHistory: NotEnoughHistory[];
  summary: Summary;
}

interface Measured {
  at: number;
  series: Series;
  /** How long the queries took, ms (logged; ADR-168 asks for it to be measured). */
  tookMs: number;
}

export class RightSizingService {
  private readonly cache: AnswerCache<Measured>;

  constructor(
    private readonly db: Database,
    private readonly victoria: VictoriaQueryClient | undefined,
    private readonly settings: SettingsService,
    readonly options: RightSizingOptions,
    private readonly log?: { info: (o: object, msg: string) => void },
    ttlMs = RIGHT_SIZING_CACHE_MS,
  ) {
    this.cache = new AnswerCache<Measured>(ttlMs);
  }

  get configured(): boolean {
    return this.victoria !== undefined;
  }

  /** The use over the window, kept an hour per cluster. */
  measure(clusterId: string, platform: 'kubernetes' | 'docker'): Promise<Measured> {
    return this.cache.get(`${clusterId}/${platform}`, async () => {
      const started = Date.now();
      const at = Math.floor(started / 1000);
      const exprs = usageExprs(platform, `${this.options.windowHours}h`);
      const victoria = this.victoria;
      const entries = await Promise.all(
        Object.entries(exprs).map(
          async ([k, e]) =>
            [k, victoria ? await victoria.query({ clusterId }, e, at) : []] as const,
        ),
      );
      const tookMs = Date.now() - started;
      this.log?.info({ clusterId, platform, tookMs }, 'right-sizing use measured');
      return { at, series: Object.fromEntries(entries), tookMs };
    });
  }

  async answer(
    cluster: { id: string; kind: 'kubernetes' | 'docker' },
    f: Filters,
  ): Promise<Answer> {
    const m = await this.measure(cluster.id, cluster.kind);
    const usage = usageByKey(cluster.kind, m.series);
    const { hints, short } =
      cluster.kind === 'kubernetes'
        ? await this.kube(cluster.id, f, usage, m)
        : this.docker(f, usage, m);
    const sorted = sortHints(hints);
    return {
      window: { hours: this.options.windowHours, minHistoryHours: this.options.minHistoryHours },
      computedAt: new Date(m.at * 1000).toISOString(),
      hints: sorted,
      notEnoughHistory: short.sort((a, b) => b.hours - a.hours),
      summary: summarize(sorted),
    };
  }

  private judge(
    usage: Usage | undefined,
    object: HintObject,
    container: string | null,
    at: number,
    short: NotEnoughHistory[],
  ): Usage | null {
    const min = this.options.minHistoryHours;
    if (!usage || !enoughHistory(usage, min)) {
      short.push({
        object,
        container,
        hours: basedOn(usage ?? empty, this.options.windowHours, at).hours,
        needed: min,
      });
      return null;
    }
    return usage;
  }

  private async kube(clusterId: string, f: Filters, usage: Map<string, Usage>, m: Measured) {
    let q = this.db
      .selectFrom('objects')
      .select(['kind', 'namespace', 'name', 'node', 'spec_summary', 'status_summary'])
      .where('cluster_id', '=', clusterId)
      .where('source', '=', 'kubernetes')
      .where('kind', 'in', [...HINT_KINDS, 'Pod'])
      .where('deleted_at', 'is', null);
    if (f.namespace) q = q.where('namespace', '=', f.namespace);
    const rows = (await q.execute()) as ObjectRow[];
    const workloads = rows.filter((r) => r.kind !== 'Pod');
    const system = f.system ? new Set<string>() : await this.systemNs(workloads);
    // Active pods per workload, and their containers' OOM kills in the window.
    const since = (m.at - this.options.windowHours * 3600) * 1000;
    const pods = new Map<string, number>();
    const ooms = new Map<string, { n: number; last: string | null }>();
    for (const p of rows) {
      if (p.kind !== 'Pod') continue;
      const spec = p.spec_summary as PodSpec;
      const st = p.status_summary as PodStatus;
      if (!spec.workload || !podIsActive(st)) continue;
      const wk = `${p.namespace}/${spec.workload.kind}/${spec.workload.name}`;
      pods.set(wk, (pods.get(wk) ?? 0) + 1);
      for (const c of st.containers ?? []) {
        const at = oomAt(c);
        if (at === null || Date.parse(at) < since) continue;
        const o = ooms.get(`${wk}/${c.name}`) ?? { n: 0, last: null };
        o.n++;
        if (!o.last || at > o.last) o.last = at;
        ooms.set(`${wk}/${c.name}`, o);
      }
    }
    const hints: Hint[] = [];
    const short: NotEnoughHistory[] = [];
    for (const w of workloads) {
      if (system.has(w.namespace)) continue;
      if (f.kind && w.kind !== f.kind) continue;
      if (f.workload && w.name !== f.workload) continue;
      const wk = `${w.namespace}/${w.kind}/${w.name}`;
      const replicas = pods.get(wk) ?? 0;
      if (replicas === 0) continue; // scaled to zero: nothing runs to size
      const object: HintObject = { kind: w.kind, namespace: w.namespace, name: w.name };
      const containers =
        (w.spec_summary as { containers?: PodSpec['containers'] }).containers ?? [];
      for (const c of containers) {
        if (f.container && c.name !== f.container) continue;
        const key = keyOf('kubernetes', {
          namespace: w.namespace,
          workload_kind: w.kind,
          workload: w.name,
          container: c.name,
        });
        const u = this.judge(usage.get(key), object, c.name, m.at, short);
        if (!u) continue;
        const oom = ooms.get(`${wk}/${c.name}`);
        const withOom: Usage = { ...u, oomKills: oom?.n ?? 0, lastOomAt: oom?.last ?? null };
        hints.push(
          ...kubeHints(
            object,
            c.name,
            {
              cpuRequest: parseQuantity(c.requests?.cpu),
              cpuLimit: parseQuantity(c.limits?.cpu),
              memoryRequest: parseQuantity(c.requests?.memory),
              memoryLimit: parseQuantity(c.limits?.memory),
            },
            withOom,
            basedOn(withOom, this.options.windowHours, m.at),
            replicas,
          ),
        );
      }
    }
    return { hints, short };
  }

  private docker(f: Filters, usage: Map<string, Usage>, m: Measured) {
    const s = m.series;
    const memoryLimit = byKey('docker', s.memoryLimit);
    const cpuLimit = byKey('docker', s.cpuLimit);
    const reservation = byKey('docker', s.memoryReservation);
    const hostMemory = new Map((s.hostMemory ?? []).map((x) => [x.labels.host, x.points[0]?.[1]]));
    const present = new Map<string, Record<string, string>>();
    for (const x of s.present ?? []) present.set(keyOf('docker', x.labels), x.labels);
    const own = f.system
      ? new Set<string>()
      : watchlogComponents(
          [...present.entries()].map(([id, l]) => ({
            id,
            group: l.compose_project ?? l.host ?? '',
            name: l.container ?? '',
            images: [l.image ?? ''],
          })),
        );
    const hints: Hint[] = [];
    const short: NotEnoughHistory[] = [];
    for (const [key, l] of [...present.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (own.has(key)) continue;
      if (f.host && l.host !== f.host) continue;
      if (f.container && l.container !== f.container) continue;
      if (f.project && l.compose_project !== f.project) continue;
      if (f.service && l.compose_service !== f.service) continue;
      const object: HintObject = {
        kind: 'container',
        host: l.host!,
        name: l.container!,
        ...(l.compose_project ? { composeProject: l.compose_project } : {}),
        ...(l.compose_service ? { composeService: l.compose_service } : {}),
      };
      const u = this.judge(usage.get(key), object, null, m.at, short);
      if (!u) continue;
      hints.push(
        ...dockerHints(
          object,
          {
            memoryLimit: memoryLimit.get(key) ?? null,
            cpuLimit: cpuLimit.get(key) ?? null,
            memoryReservation: reservation.get(key) ?? null,
            hostMemory: hostMemory.get(l.host!) ?? null,
          },
          u,
          basedOn(u, this.options.windowHours, m.at),
        ),
      );
    }
    return { hints, short };
  }

  private async systemNs(workloads: ObjectRow[]): Promise<Set<string>> {
    const own = watchlogComponents(
      workloads.map((w) => ({
        id: `${w.namespace}/${w.kind}/${w.name}`,
        group: w.namespace,
        name: w.name,
        images: ((w.spec_summary as { containers?: { image?: string }[] }).containers ?? []).map(
          (c) => c.image ?? '',
        ),
      })),
    );
    return systemNamespaces(
      await this.settings.namespaces(),
      [...own].map((id) => id.split('/')[0]!),
    );
  }
}

const empty: Usage = {
  cpuP95: null,
  memoryPeak: null,
  memoryP95: null,
  throttledP95: null,
  samples: 0,
  from: null,
  oomKills: 0,
};

/** When a container was last OOM-killed, from its pod's status (now or its last run). */
export function oomAt(c: ContainerStatus): string | null {
  if (c.state === 'terminated' && c.reason === 'OOMKilled') {
    return c.last_termination?.finished_at ?? new Date().toISOString();
  }
  const t = c.last_termination;
  return t?.reason === 'OOMKilled' && t.finished_at ? t.finished_at : null;
}
