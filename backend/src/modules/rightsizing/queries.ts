// SPDX-License-Identifier: AGPL-3.0-only
// What containers used over the right-sizing window (ADR-168), from VictoriaMetrics: p95 of
// the 5-minute CPU rate, the peak and p95 of the working set, p95 of the throttled share, and
// how many 5-minute samples of history there are. Kubernetes per workload container (its
// busiest pod), Docker per container. Fixed templates; cluster_id is enforced by
// VictoriaMetrics (extra_label), as for every query.
import type { QuerySeries } from '../../lib/victoria.js';
import type { Usage } from './hints.js';

/** Workload kinds that get hints: Jobs and CronJobs are short runs (ADR-168). */
export const HINT_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet'] as const;

const KUBE_BY = 'namespace, workload_kind, workload, container';
const DOCKER_BY = 'host, container';
const KUBE_SEL = `{pod!="",container!="",workload_kind=~"${HINT_KINDS.join('|')}"}`;
const DOCKER_SEL = '{container!="",pod=""}';

const sel = (s: string, metric: string) => `${metric}${s}`;

/** The use expressions, in the order of `Usage`'s fields; `w` is the window ("168h"). */
export function usageExprs(platform: 'kubernetes' | 'server', w: string): Record<string, string> {
  const by = platform === 'kubernetes' ? KUBE_BY : DOCKER_BY;
  const s = platform === 'kubernetes' ? KUBE_SEL : DOCKER_SEL;
  const cpu = sel(s, 'watchlog_container_cpu_seconds_total');
  const ws = sel(s, 'watchlog_container_memory_working_set_bytes');
  const thr = sel(s, 'watchlog_container_cpu_throttled_seconds_total');
  const out: Record<string, string> = {
    cpuP95: `max by (${by}) (quantile_over_time(0.95, rate(${cpu}[5m])[${w}:5m]))`,
    memoryPeak: `max by (${by}) (max_over_time(${ws}[${w}]))`,
    memoryP95: `max by (${by}) (quantile_over_time(0.95, ${ws}[${w}:5m]))`,
    throttledP95: `max by (${by}) (quantile_over_time(0.95, clamp_max(rate(${thr}[5m]), 1)[${w}:5m]))`,
    samples: `count_over_time((max by (${by}) (${ws}))[${w}:5m])`,
    from: `min by (${by}) (tfirst_over_time(${ws}[${w}]))`,
  };
  if (platform === 'server') {
    const last = (m: string) => `max by (${by}) (last_over_time(${sel(s, m)}[1h]))`;
    Object.assign(out, {
      oomKills: `max by (${by}) (increase(${sel(s, 'watchlog_container_oom_events_total')}[${w}]))`,
      memoryLimit: last('watchlog_container_memory_limit_bytes'),
      cpuLimit: last('watchlog_container_cpu_limit_cores'),
      memoryReservation: last('watchlog_container_memory_reservation_bytes'),
      // The containers that ran in the last hour, with their Compose labels and image.
      present: `max by (host, container, compose_project, compose_service, image) (last_over_time(${ws}[1h]))`,
      hostMemory: `max by (host) (last_over_time(watchlog_node_memory_bytes{state="total"}[1h]))`,
    });
    // Servers' systemd services with a MemoryMax or CPUQuota (ADR-208): as containers' limits.
    const u = 'host, unit';
    const ucpu = 'watchlog_service_cpu_seconds_total';
    const uws = 'watchlog_service_memory_working_set_bytes';
    Object.assign(out, {
      unitCpuP95: `max by (${u}) (quantile_over_time(0.95, rate(${ucpu}[5m])[${w}:5m]))`,
      unitMemoryPeak: `max by (${u}) (max_over_time(${uws}[${w}]))`,
      unitMemoryP95: `max by (${u}) (quantile_over_time(0.95, ${uws}[${w}:5m]))`,
      unitThrottledP95: `max by (${u}) (quantile_over_time(0.95, clamp_max(rate(watchlog_service_cpu_throttled_seconds_total[5m]), 1)[${w}:5m]))`,
      unitSamples: `count_over_time((max by (${u}) (${uws}))[${w}:5m])`,
      unitFrom: `min by (${u}) (tfirst_over_time(${uws}[${w}]))`,
      unitOomKills: `max by (${u}) (increase(watchlog_service_oom_kills_total[${w}]) or increase(watchlog_service_oom_events_total[${w}]))`,
      unitMemoryLimit: `max by (${u}) (last_over_time(watchlog_service_memory_limit_bytes[1h]))`,
      unitCpuLimit: `max by (${u}) (last_over_time(watchlog_service_cpu_limit_cores[1h]))`,
    });
  }
  return out;
}

/** A server's service: host/unit. */
export const unitKey = (l: Record<string, string>) => `${l.host}/${l.unit}`;

/** Each service's use, from the unit* answers of `usageExprs`. */
export function unitUsage(series: Series): Map<string, Usage> {
  const m = (k: string) =>
    new Map((series[k] ?? []).map((s) => [unitKey(s.labels), value(s)] as const));
  const [cpu, peak, p95, thr, samples, from, oom] = [
    'unitCpuP95',
    'unitMemoryPeak',
    'unitMemoryP95',
    'unitThrottledP95',
    'unitSamples',
    'unitFrom',
    'unitOomKills',
  ].map(m);
  const out = new Map<string, Usage>();
  for (const key of samples!.keys()) {
    out.set(key, {
      cpuP95: cpu!.get(key) ?? null,
      memoryPeak: peak!.get(key) ?? null,
      memoryP95: p95!.get(key) ?? null,
      throttledP95: thr!.get(key) ?? null,
      samples: samples!.get(key) ?? 0,
      from: from!.get(key) ?? null,
      oomKills: Math.round(oom!.get(key) ?? 0),
    });
  }
  return out;
}

export type Series = Record<string, QuerySeries[]>;

const value = (s: QuerySeries) => s.points[0]?.[1] ?? null;

/** A key per series: namespace/kind/workload/container, or host/container. */
export function keyOf(platform: 'kubernetes' | 'server', l: Record<string, string>): string {
  return platform === 'kubernetes'
    ? `${l.namespace}/${l.workload_kind}/${l.workload}/${l.container}`
    : `${l.host}/${l.container}`;
}

export function byKey(platform: 'kubernetes' | 'server', series: QuerySeries[] = []) {
  const out = new Map<string, number | null>();
  for (const s of series) out.set(keyOf(platform, s.labels), value(s));
  return out;
}

/** Usage per key from the answers of `usageExprs` (OOM kills on Kubernetes come from pods). */
export function usageByKey(platform: 'kubernetes' | 'server', series: Series): Map<string, Usage> {
  const m = Object.fromEntries(
    Object.entries(series).map(([k, v]) => [k, byKey(platform, v)]),
  ) as Record<string, Map<string, number | null>>;
  const out = new Map<string, Usage>();
  for (const key of m.samples!.keys()) {
    out.set(key, {
      cpuP95: m.cpuP95!.get(key) ?? null,
      memoryPeak: m.memoryPeak!.get(key) ?? null,
      memoryP95: m.memoryP95!.get(key) ?? null,
      throttledP95: m.throttledP95!.get(key) ?? null,
      samples: m.samples!.get(key) ?? 0,
      from: m.from!.get(key) ?? null,
      oomKills: Math.round(m.oomKills?.get(key) ?? 0),
    });
  }
  return out;
}
