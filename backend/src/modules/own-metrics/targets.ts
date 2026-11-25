// SPDX-License-Identifier: AGPL-3.0-only
// The endpoints a collector scrapes for own metrics (1.0.0, ADR-236), worked out here from what
// WatchLog already knows, so the collector needs no access to the Kubernetes API:
//
//   Kubernetes  every running pod annotated `watchlog.io/scrape: "true"`, at `watchlog.io/port`
//               (a number or a port's name; default: its first named port, else its first
//               port) and `watchlog.io/path` (default /metrics). With the cluster's setting on,
//               pods annotated `prometheus.io/scrape` too. One source per workload endpoint;
//               each pod's series carry its name in `pod`.
//   Servers     the addresses added in the panel for one server ("localhost:9400/metrics"),
//               scraped by that server's collector; their series carry `instance`.
//
// A target's id names its source; a report is taken only for an id this file handed out.
import type { Database } from '../../db/index.js';
import { NO_OWNER, type Owner, type SourceRef } from './service.js';

export const SCRAPE_INTERVAL_S = 30;
/** Endpoints one cluster or server may have scraped. */
export const MAX_TARGETS = 500;
const TTL_MS = 15_000;

export interface ScrapeTarget {
  id: string;
  url: string;
  source: SourceRef;
  /** Labels the server adds to each series of this endpoint. */
  extra: Record<string, string>;
  /** The server whose collector scrapes it ('' on Kubernetes). */
  host: string;
}

/** A workload's endpoint added from the panel. */
export interface PanelPod {
  by: string;
  namespace: string;
  workloadKind: string;
  workload: string;
  port: number;
  path: string;
}

/** The key of a workload endpoint's source, however it was asked for. */
export const podSourceKey = (c: Omit<PanelPod, 'by'>): string =>
  `pod:${c.namespace}/${c.workloadKind}/${c.workload}:${c.port}${c.path}`;

interface PodSpec {
  workload?: { kind?: string; name?: string };
  containers?: { ports?: { name?: string; port?: number }[] }[];
  scrape?: { by?: string; port?: number; port_name?: string; path?: string };
}

/** "localhost:9400/metrics" → "http://localhost:9400/metrics"; null when it isn't an address. */
export function normaliseAddress(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 300 || /\s/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
  // No credentials for now (the docs say so): an address with a user is refused.
  if (u.username || u.password) return null;
  if (u.pathname === '/' && !/\/$/.test(raw.replace(/[?#].*$/, ''))) u.pathname = '/metrics';
  u.hash = '';
  return u.toString();
}

/** The port a pod's scrape request means, or null when the pod declares none. */
export function scrapePort(spec: PodSpec): number | null {
  const s = spec.scrape ?? {};
  if (s.port) return s.port;
  const ports = (spec.containers ?? []).flatMap((c) => c.ports ?? []);
  if (s.port_name) return ports.find((p) => p.name === s.port_name)?.port ?? null;
  return (ports.find((p) => p.name) ?? ports[0])?.port ?? null;
}

export class Targets {
  private readonly cache = new Map<string, { at: number; targets: ScrapeTarget[] }>();

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  forget(clusterId: string): void {
    this.cache.delete(clusterId);
  }

  /** Every endpoint of a cluster or fleet. */
  async of(clusterId: string): Promise<ScrapeTarget[]> {
    const hit = this.cache.get(clusterId);
    if (hit && this.now() - hit.at < TTL_MS) return hit.targets;
    const { db } = this;
    const cluster = await db
      .selectFrom('clusters')
      .select(['kind', 'own_metrics_prometheus_annotations as prom'])
      .where('id', '=', clusterId)
      .executeTakeFirst();
    const targets: ScrapeTarget[] = [];
    // Endpoints added from the panel ("Find endpoints for me"): a workload's port and path,
    // scraped on every pod of it, with no annotation.
    const panel = (
      await db
        .selectFrom('own_sources')
        .select(['key', 'config'])
        .where('cluster_id', '=', clusterId)
        .where('kind', '=', 'scrape_pod')
        .execute()
    )
      .map((r) => r.config as unknown as PanelPod)
      .filter((c) => c.by === 'panel');
    if (cluster && cluster.kind !== 'server') {
      const pods = await db
        .selectFrom('objects')
        .select(['namespace', 'name', 'spec_summary', 'status_summary'])
        .where('cluster_id', '=', clusterId)
        .where('kind', '=', 'Pod')
        .where('deleted_at', 'is', null)
        .orderBy('namespace')
        .orderBy('name')
        .execute();
      for (const p of pods) {
        const spec = p.spec_summary as PodSpec;
        const status = p.status_summary as { phase?: string; pod_ip?: string };
        if (status.phase !== 'Running' || !status.pod_ip) continue;
        const wkind = spec.workload?.kind || 'Pod';
        const workload = spec.workload?.name || p.name;
        const annotated = spec.scrape?.by;
        const asked =
          annotated === 'watchlog' || (annotated === 'prometheus' && cluster.prom === true);
        const added = panel.filter(
          (c) => c.namespace === p.namespace && c.workloadKind === wkind && c.workload === workload,
        );
        const endpoints: { port: number; path: string; by: string }[] = [];
        if (asked) {
          const port = scrapePort(spec);
          if (port) endpoints.push({ port, path: spec.scrape?.path || '/metrics', by: annotated! });
        }
        for (const c of added)
          if (!endpoints.some((e) => e.port === c.port && e.path === c.path))
            endpoints.push({ port: c.port, path: c.path, by: 'panel' });
        for (const { port, path, by } of endpoints) {
          const owner: Owner = {
            kind: 'workload',
            namespace: p.namespace,
            workloadKind: wkind,
            name: workload,
          };
          const ip = status.pod_ip.includes(':') ? `[${status.pod_ip}]` : status.pod_ip;
          targets.push({
            id: `p|${p.namespace}|${wkind}|${workload}|${p.name}|${port}|${path}`,
            url: `http://${ip}:${port}${path}`,
            host: '',
            extra: { pod: p.name },
            source: {
              kind: 'scrape_pod',
              key: podSourceKey({
                namespace: p.namespace,
                workloadKind: wkind,
                workload,
                port,
                path,
              }),
              label: `${workload} :${port}${path}`,
              owner,
              config: { namespace: p.namespace, workloadKind: wkind, workload, port, path, by },
            },
          });
        }
        if (targets.length >= MAX_TARGETS) break;
      }
    }
    const added = await db
      .selectFrom('own_sources')
      .select(['id', 'key', 'label', 'config'])
      .where('cluster_id', '=', clusterId)
      .where('kind', '=', 'scrape_address')
      .orderBy('created_at')
      .limit(MAX_TARGETS)
      .execute();
    for (const s of added) {
      const cfg = s.config as { server?: string; url?: string; address?: string };
      if (!cfg.server || !cfg.url) continue;
      let instance = cfg.address ?? cfg.url;
      try {
        instance = new URL(cfg.url).host;
      } catch {
        // The address as it was typed.
      }
      targets.push({
        id: `a|${s.id}`,
        url: cfg.url,
        host: cfg.server,
        extra: { instance },
        source: {
          kind: 'scrape_address',
          key: s.key,
          label: s.label,
          owner: { ...NO_OWNER, kind: 'server', name: cfg.server },
        },
      });
    }
    this.cache.set(clusterId, { at: this.now(), targets });
    return targets;
  }

  /** What one collector scrapes: the cluster's pods, or one server's addresses. */
  async forCollector(clusterId: string, host: string): Promise<ScrapeTarget[]> {
    return (await this.of(clusterId)).filter((t) => t.host === host);
  }
}
