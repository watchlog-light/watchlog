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

/** What a search tried, for the page to say so (1.0.3). */
export interface Tried {
  /** The ports asked for /metrics, in order. */
  ports: number[];
  /** Listening or declared ports left out because they never serve metrics (SSH, databases). */
  skipped: number[];
  /** Ports left out because they are scraped already. */
  scraped: number;
  /** Kubernetes: the workloads whose ports were tried. */
  workloads: number;
}

interface Probe {
  id: string;
  clusterId: string;
  at: number;
  candidates: Candidate[];
  /** The collectors (by host) that answered. */
  answered: Set<string>;
  found: Found[];
  tried: Tried;
}

/** How long a test waits for the collector: its 10 seconds for the address, and the way back. */
export const TEST_WAIT_MS = 15_000;

/**
 * Why an address gives no metrics, in the collector's word (agent/internal/integrations/
 * ownmetrics/fetch.go, Why); `silent` when the collector didn't answer the test at all (it is
 * older than 1.0.3, or not running).
 */
export type TestReason =
  | 'refused'
  | 'no_host'
  | 'slow'
  | 'big'
  | 'auth'
  | 'status'
  | 'html'
  | 'not_metrics'
  | 'redirect'
  | 'tls'
  | 'address'
  | 'other'
  | 'silent';

/** "Test" on the Add a source page (1.0.3): one address read once by its collector. */
export interface AddressTest {
  id: string;
  clusterId: string;
  at: number;
  /** The server whose collector reads it ('' on Kubernetes). */
  host: string;
  url: string;
  /** The address as the page shows it. */
  shown: string;
  result: { ok: boolean; series: number; names: string[]; reason: string; detail: string } | null;
}

interface PodSpec {
  workload?: { kind?: string; name?: string };
  containers?: { ports?: { port?: number }[] }[];
}

export class Probes {
  private readonly byCluster = new Map<string, Probe>();
  private readonly tests = new Map<string, AddressTest>();

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
    const ports = new Set<number>();
    const skipped = new Set<number>();
    const workloads = new Set<string>();
    let already = 0;
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
        if (!host || !Number.isInteger(port)) continue;
        if (SKIP_PORTS.has(port)) {
          skipped.add(port);
          continue;
        }
        const address = `localhost:${port}/metrics`;
        const url = `http://${address}`;
        if (scraped.has(url)) {
          already++;
          continue;
        }
        if (candidates.some((c) => c.host === host && c.url === url)) continue;
        ports.add(port);
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
          if (!port.port) continue;
          if (SKIP_PORTS.has(port.port)) {
            skipped.add(port.port);
            continue;
          }
          const key = `${p.namespace}|${workloadKind}|${workload}|${port.port}`;
          const url = `http://${ip}:${port.port}/metrics`;
          if (seen.has(key)) continue;
          if (scraped.has(url)) {
            already++;
            continue;
          }
          seen.add(key);
          ports.add(port.port);
          workloads.add(`${p.namespace}|${workloadKind}|${workload}`);
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
      tried: {
        ports: [...ports].sort((a, b) => a - b),
        skipped: [...skipped].sort((a, b) => a - b),
        scraped: already,
        workloads: workloads.size,
      },
    };
    this.byCluster.set(clusterId, probe);
    return probe;
  }

  /** Starts a test of one address; a newer test of the same cluster replaces an older one. */
  startTest(clusterId: string, t: { host: string; url: string; shown: string }): AddressTest {
    const test: AddressTest = { id: newId(), clusterId, at: this.now(), ...t, result: null };
    this.tests.set(clusterId, test);
    return test;
  }

  /** The cluster's test, while the page may still ask about it. */
  currentTest(clusterId: string): AddressTest | null {
    const t = this.tests.get(clusterId);
    if (!t) return null;
    if (this.now() - t.at > TTL_MS) {
      this.tests.delete(clusterId);
      return null;
    }
    return t;
  }

  /** The test its collector still has to answer, for the collector's configuration. */
  pendingTest(clusterId: string, host: string): AddressTest | null {
    const t = this.currentTest(clusterId);
    return t && !t.result && t.host === host && this.now() - t.at <= TEST_WAIT_MS ? t : null;
  }

  /** Whether the test has its answer, or waited long enough to say the collector is silent. */
  testDone(t: AddressTest): boolean {
    return t.result !== null || this.now() - t.at > TEST_WAIT_MS;
  }

  /** A collector's answer. */
  answer(
    clusterId: string,
    id: string,
    host: string,
    results: {
      id: string;
      ok: boolean;
      series: number;
      names?: string[];
      reason?: string;
      detail?: string;
    }[],
  ): void {
    const t = this.currentTest(clusterId);
    if (t && t.id === id && t.host === host) {
      const r = results[0];
      if (r && !t.result) {
        t.result = {
          ok: r.ok,
          series: r.series,
          names: (r.names ?? []).slice(0, 5),
          // A collector older than 1.0.3 answers a probe without saying why.
          reason: r.ok ? '' : r.reason || 'other',
          detail: r.detail ?? '',
        };
      }
      return;
    }
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
