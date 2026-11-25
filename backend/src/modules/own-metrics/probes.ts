// SPDX-License-Identifier: AGPL-3.0-only
// "Find endpoints for me" (1.0.0, ADR-236): the collectors try the pods' declared ports and the
// servers' listening ports for an answer on /metrics and say which ones expose metrics. A probe
// lives in memory for a few minutes: it is a question asked from the panel, not data.
import type { Database } from '../../db/index.js';
import { newId } from '../../lib/ids.js';
import { authorisedScope, type VictoriaQueryClient } from '../../lib/victoria.js';
import type { Targets } from './targets.js';

const TTL_MS = 5 * 60_000;
/** Candidates one probe asks about, over all its collectors. */
export const MAX_CANDIDATES = 300;
/** Ports that never serve metrics: SSH, DNS, mail, the databases' own protocols. */
const SKIP_PORTS = new Set([
  22, 25, 53, 110, 143, 443, 465, 587, 993, 995, 3306, 5432, 6379, 27017,
]);

export interface Candidate {
  id: string;
  url: string;
  /** The server whose collector tries it ('' on Kubernetes). */
  host: string;
  /** What one click adds. */
  add:
    | { kind: 'pod'; namespace: string; workloadKind: string; workload: string; port: number }
    | { kind: 'address'; server: string; address: string; workload: string };
}

export interface Found {
  candidate: Candidate;
  series: number;
  names: string[];
}

interface Probe {
  id: string;
  clusterId: string;
  at: number;
  candidates: Candidate[];
  /** The collectors (by host) that answered. */
  answered: Set<string>;
  found: Found[];
}

interface PodSpec {
  workload?: { kind?: string; name?: string };
  containers?: { ports?: { port?: number }[] }[];
}

export class Probes {
  private readonly byCluster = new Map<string, Probe>();

  constructor(
    private readonly db: Database,
    private readonly victoria: VictoriaQueryClient | null,
    private readonly targets: Targets,
    private readonly now: () => number = Date.now,
  ) {}

  /** The cluster's probe still waiting or just answered, if any. */
  current(clusterId: string): Probe | null {
    const p = this.byCluster.get(clusterId);
    if (!p) return null;
    if (this.now() - p.at > TTL_MS) {
      this.byCluster.delete(clusterId);
      return null;
    }
    return p;
  }

  /** Starts a probe over what isn't scraped yet. */
  async start(clusterId: string): Promise<Probe> {
    const scraped = new Set((await this.targets.of(clusterId)).map((t) => t.url));
    const cluster = await this.db
      .selectFrom('clusters')
      .select('kind')
      .where('id', '=', clusterId)
      .executeTakeFirst();
    const candidates: Candidate[] = [];
    if (cluster?.kind === 'server') {
      const rows = this.victoria
        ? await this.victoria
            .query(
              authorisedScope(clusterId),
              'max by (host, source, workload, port) (last_over_time(watchlog_listen_info[10m]))',
            )
            .catch(() => [])
        : [];
      for (const r of rows) {
        const port = Number(r.labels.port);
        const host = r.labels.host ?? '';
        if (!host || !Number.isInteger(port) || SKIP_PORTS.has(port)) continue;
        const address = `localhost:${port}/metrics`;
        const url = `http://${address}`;
        if (scraped.has(url) || candidates.some((c) => c.host === host && c.url === url)) continue;
        candidates.push({
          id: `${host}|${port}`,
          url,
          host,
          add: { kind: 'address', server: host, address, workload: r.labels.workload ?? '' },
        });
      }
    } else {
      const pods = await this.db
        .selectFrom('objects')
        .select(['namespace', 'name', 'spec_summary', 'status_summary'])
        .where('cluster_id', '=', clusterId)
        .where('kind', '=', 'Pod')
        .where('deleted_at', 'is', null)
        .orderBy('namespace')
        .orderBy('name')
        .execute();
      // One pod of each workload answers for all of them.
      const seen = new Set<string>();
      for (const p of pods) {
        const spec = p.spec_summary as PodSpec;
        const status = p.status_summary as { phase?: string; pod_ip?: string };
        if (status.phase !== 'Running' || !status.pod_ip) continue;
        const workloadKind = spec.workload?.kind || 'Pod';
        const workload = spec.workload?.name || p.name;
        const ip = status.pod_ip.includes(':') ? `[${status.pod_ip}]` : status.pod_ip;
        for (const port of (spec.containers ?? []).flatMap((c) => c.ports ?? [])) {
          if (!port.port || SKIP_PORTS.has(port.port)) continue;
          const key = `${p.namespace}|${workloadKind}|${workload}|${port.port}`;
          const url = `http://${ip}:${port.port}/metrics`;
          if (seen.has(key) || scraped.has(url)) continue;
          seen.add(key);
          candidates.push({
            id: key,
            url,
            host: '',
            add: { kind: 'pod', namespace: p.namespace, workloadKind, workload, port: port.port },
          });
        }
      }
    }
    const probe: Probe = {
      id: newId(),
      clusterId,
      at: this.now(),
      candidates: candidates.slice(0, MAX_CANDIDATES),
      answered: new Set(),
      found: [],
    };
    this.byCluster.set(clusterId, probe);
    return probe;
  }

  /** A collector's answer. */
  answer(
    clusterId: string,
    id: string,
    host: string,
    results: { id: string; ok: boolean; series: number; names?: string[] }[],
  ): void {
    const p = this.current(clusterId);
    if (!p || p.id !== id) return;
    p.answered.add(host);
    for (const r of results) {
      if (!r.ok) continue;
      const candidate = p.candidates.find((c) => c.id === r.id && c.host === host);
      if (candidate && !p.found.some((f) => f.candidate === candidate))
        p.found.push({ candidate, series: r.series, names: (r.names ?? []).slice(0, 5) });
    }
  }

  /** Whether every collector the probe asked has answered. */
  done(p: Probe): boolean {
    const hosts = new Set(p.candidates.map((c) => c.host));
    return [...hosts].every((h) => p.answered.has(h));
  }
}
