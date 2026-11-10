// SPDX-License-Identifier: AGPL-3.0-only
// Gathers an evidence snapshot (evidence.ts) through the API reader: the object, its events,
// the changes around it, the nodes or hosts under it and its place on the service map. Each
// part is optional: a part that can't be read leaves its slot empty and the checks say
// "couldn't check", never a failed answer.
import { ApiReadError } from '../mcp/reader.js';
import { increase, sumCounts, type Point } from './counts.js';
import {
  COUNT_MS,
  emptyMap,
  MAX_EVENT_CONTAINERS,
  MAX_NODES,
  MAX_POD_DETAILS,
  type EvCount,
  type EvMetrics,
  type EvAlert,
  type EvApplication,
  type EvContainer,
  type EvEdge,
  type EvEvent,
  type EvHost,
  type EvMap,
  type EvMarker,
  type EvNode,
  type EvPod,
  type EvPodContainer,
  type EvWorkload,
  type Evidence,
  type Focus,
  type Reader,
  type Via,
} from './evidence.js';
import type { Platform } from './types.js';

/** A reader that asks each path once per answer: resolving and gathering share reads. */
export function memoReader(inner: Reader): Reader {
  const seen = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, read: () => Promise<T>) => {
    let p = seen.get(key);
    if (!p) {
      p = read();
      seen.set(key, p);
    }
    return p as Promise<T>;
  };
  const post = inner.post?.bind(inner);
  return {
    get<T>(path: string, query: Record<string, string | number | boolean | undefined | null> = {}) {
      return once(`GET ${path}?${JSON.stringify(Object.entries(query).sort())}`, () =>
        inner.get<T>(path, query),
      );
    },
    ...(post
      ? {
          post<T>(path: string, body: object) {
            return once(`POST ${path} ${JSON.stringify(body)}`, () => post<T>(path, body));
          },
        }
      : {}),
  };
}

/** A read that may fail: its fallback instead (the part stays empty). */
export async function soft<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

export const notFound = (err: unknown) => err instanceof ApiReadError && err.status === 404;

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export interface GatherInput {
  clusterId: string;
  platform: Platform;
  focus: Focus;
  window: { from: string; to: string };
  symptomAt: string | null;
  alert?: EvAlert | null;
  edge?: EvEdge | null;
  now?: number;
  /** The far end of an edge the walk follows: the edge, and what the caller sees. */
  via?: Via | null;
}

interface PodDetail {
  pod: EvPod;
  containers: EvPodContainer[];
  events: EvEvent[];
}

const byNewest = (a: EvEvent, b: EvEvent) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen);

/** The evidence about one focus. */
export async function gather(reader: Reader, input: GatherInput): Promise<Evidence> {
  const { clusterId, focus, window } = input;
  const base = `/clusters/${clusterId}`;
  const ev: Evidence = {
    platform: input.platform,
    clusterId,
    focus,
    now: input.now ?? Date.now(),
    window,
    symptomAt: input.symptomAt,
    pods: [],
    workload: null,
    containers: [],
    events: [],
    changes: [],
    ownTargets: [],
    nodes: [],
    hosts: [],
    map: emptyMap(),
    application: null,
    edge: input.edge ?? null,
    alert: input.alert ?? null,
    gone: false,
    metrics: null,
    via: input.via ?? null,
  };
  const inWindow = (e: EvEvent) => Date.parse(e.lastSeen) >= Date.parse(window.from);
  const markers = (namespaces?: string) =>
    soft(
      reader
        .get<{ markers: EvMarker[] }>(`${base}/change-markers`, {
          from: sec(window.from),
          to: Math.max(sec(window.to), sec(window.from) + 1),
          namespaces,
        })
        .then((r) => r.markers),
      [] as EvMarker[],
    );
  const nodes = (names: string[]) =>
    Promise.all(
      names.slice(0, MAX_NODES).map((n) =>
        soft(
          reader
            .get<{ node: EvNode }>(`${base}/nodes/${encodeURIComponent(n)}`)
            .then((r) => r.node as EvNode | null),
          null,
        ),
      ),
    ).then((list) => list.filter((n): n is EvNode => !!n));

  switch (focus.kind) {
    case 'pod': {
      const detail = await reader
        .get<PodDetail>(
          `${base}/pods/${encodeURIComponent(focus.namespace)}/${encodeURIComponent(focus.name)}`,
        )
        .catch((err: unknown) => {
          if (notFound(err)) return null;
          throw err;
        });
      if (!detail) {
        ev.gone = true;
        ev.changes = await markers(focus.namespace);
        return ev;
      }
      const pod = { ...detail.pod, containers: detail.containers };
      ev.pods = [pod];
      ev.events = detail.events.filter(inWindow).sort(byNewest);
      if (pod.workload && pod.workloadKind)
        ev.ownTargets.push(`${pod.workloadKind}/${pod.namespace}/${pod.workload}`);
      if (pod.node) ev.ownTargets.push(`Node/${pod.node}`);
      const ids =
        pod.workload && pod.workloadKind
          ? [`w:${pod.namespace}/${pod.workloadKind}/${pod.workload}`]
          : [];
      [ev.changes, ev.nodes, ev.map, ev.metrics] = await Promise.all([
        markers(focus.namespace),
        nodes(pod.node ? [pod.node] : []),
        serviceMap(reader, clusterId, ids, focus.namespace),
        kubeMetrics(reader, clusterId, window.to, { namespace: pod.namespace, pod: pod.name }, [
          pod,
        ]),
      ]);
      if (pod.workload && pod.workloadKind)
        await nxdomainSeries(reader, ev, {
          namespace: pod.namespace,
          workload: pod.workload,
          workloadKind: pod.workloadKind,
        });
      return ev;
    }
    case 'workload': {
      const { workloads } = await reader.get<{ workloads: EvWorkload[] }>(`${base}/workloads`, {
        namespaces: focus.namespace,
        range: 3600,
      });
      const w = workloads.find((x) => x.kind === focus.workloadKind && x.name === focus.name);
      if (!w) {
        ev.gone = true;
        ev.changes = await markers(focus.namespace);
        return ev;
      }
      ev.workload = w;
      const [{ pods }, { events }] = await Promise.all([
        reader.get<{ pods: EvPod[] }>(`${base}/pods`, {
          namespaces: focus.namespace,
          workload: w.name,
          workloadKind: w.kind,
        }),
        soft(
          reader.get<{ events: EvEvent[] }>(`${base}/events`, {
            namespaces: focus.namespace,
            q: w.name,
            from: sec(window.from),
            limit: 100,
          }),
          { events: [] as EvEvent[] },
        ),
      ]);
      // The failing pods' detail: their containers' limits, waiting messages, terminations.
      const failing = pods
        .filter((p) => p.failing || p.phase === 'Failed')
        .slice(0, MAX_POD_DETAILS);
      const details = await Promise.all(
        failing.map((p) =>
          soft(
            reader
              .get<PodDetail>(
                `${base}/pods/${encodeURIComponent(p.namespace)}/${encodeURIComponent(p.name)}`,
              )
              .then((d) => d.containers),
            null,
          ),
        ),
      );
      ev.pods = pods.map((p) => {
        const i = failing.indexOf(p);
        return i >= 0 && details[i] ? { ...p, containers: details[i] } : p;
      });
      // The workload's own events and its pods' and ReplicaSets' (named after it).
      ev.events = events
        .filter((e) => e.involvedName === w.name || e.involvedName.startsWith(`${w.name}-`))
        .filter(inWindow)
        .sort(byNewest);
      // The nodes under it, those of failing pods first.
      const under = [
        ...new Set(
          [...pods]
            .sort((a, b) => Number(!!b.failing) - Number(!!a.failing))
            .map((p) => p.node)
            .filter((n): n is string => !!n),
        ),
      ];
      ev.ownTargets.push(`${w.kind}/${w.namespace}/${w.name}`, ...under.map((n) => `Node/${n}`));
      [ev.changes, ev.nodes, ev.map, ev.metrics] = await Promise.all([
        markers(focus.namespace),
        nodes(under),
        serviceMap(reader, clusterId, [`w:${w.namespace}/${w.kind}/${w.name}`], focus.namespace),
        kubeMetrics(
          reader,
          clusterId,
          window.to,
          { namespace: w.namespace, workload: w.name, workloadKind: w.kind },
          pods,
        ),
      ]);
      await Promise.all([
        nxdomainSeries(reader, ev, {
          namespace: w.namespace,
          workload: w.name,
          workloadKind: w.kind,
        }),
        input.via ? farApplication(reader, ev) : null,
      ]);
      return ev;
    }
    case 'container':
    case 'compose_service': {
      const { containers } = await reader.get<{ containers: EvContainer[] }>(
        `${base}/docker/containers`,
      );
      const mine =
        focus.kind === 'container'
          ? containers.filter((c) => c.name === focus.name && c.host === focus.host)
          : containers.filter(
              (c) => c.composeProject === focus.project && c.composeService === focus.service,
            );
      if (!mine.length) {
        ev.gone = true;
        ev.changes = await markers();
        return ev;
      }
      ev.containers = mine;
      const withProblems = [...mine].sort((a, b) => Number(!!b.problem) - Number(!!a.problem));
      const hostNames = [...new Set(mine.map((c) => c.host))];
      const [events, hosts, changes, map, metrics] = await Promise.all([
        Promise.all(
          withProblems.slice(0, MAX_EVENT_CONTAINERS).map((c) =>
            soft(
              reader
                .get<{ events: EvEvent[] }>(`${base}/events`, {
                  hosts: c.host,
                  name: c.name,
                  from: sec(window.from),
                  limit: 50,
                })
                .then((r) => r.events),
              [] as EvEvent[],
            ),
          ),
        ),
        soft(
          reader.get<{ hosts: EvHost[] }>(`${base}/docker/hosts`).then((r) => r.hosts),
          [] as EvHost[],
        ),
        markers(),
        serviceMap(
          reader,
          clusterId,
          mine.map((c) => `c:${c.name}`),
        ),
        dockerMetrics(
          reader,
          clusterId,
          window.to,
          focus.kind === 'container'
            ? { host: focus.host, container: focus.name }
            : { composeProject: focus.project },
          mine,
        ),
      ]);
      ev.metrics = metrics;
      ev.events = events.flat().filter(inWindow).sort(byNewest);
      ev.hosts = hosts.filter((h) => hostNames.includes(h.name));
      ev.changes = changes;
      for (const c of mine) ev.ownTargets.push(`Container/${c.host}/${c.name}`);
      for (const c of mine)
        if (c.composeProject) ev.ownTargets.push(`Compose/${c.host}/${c.composeProject}`);
      ev.ownTargets = [...new Set(ev.ownTargets)];
      ev.map = map;
      const looking = mine.find((c) =>
        map.dns.some((d) => d.node === `c:${c.name}` && d.nxdomainPerSecond > 0),
      );
      await Promise.all([
        looking
          ? nxdomainSeries(reader, ev, { host: looking.host, container: looking.name })
          : null,
        input.via ? farApplication(reader, ev) : null,
      ]);
      return ev;
    }
    case 'node': {
      const d = await soft(
        reader.get<{ node: EvNode; events: EvEvent[] }>(
          `${base}/nodes/${encodeURIComponent(focus.name)}`,
        ),
        null,
      );
      ev.nodes = d ? [d.node] : [];
      ev.events = (d?.events ?? []).filter(inWindow).sort(byNewest);
      ev.gone = !d;
      ev.ownTargets.push(`Node/${focus.name}`);
      ev.changes = await markers();
      return ev;
    }
    case 'host': {
      const hosts = await soft(
        reader.get<{ hosts: EvHost[] }>(`${base}/docker/hosts`).then((r) => r.hosts),
        [] as EvHost[],
      );
      ev.hosts = hosts.filter((h) => h.name === focus.name);
      ev.gone = ev.hosts.length === 0;
      ev.changes = await markers();
      return ev;
    }
    case 'application': {
      const d = await reader.get<{
        application: Omit<EvApplication, 'reasons'>;
        reasons: EvApplication['reasons'];
      }>(`/applications/${focus.id}`);
      ev.application = { ...d.application, reasons: d.reasons };
      const t = d.application.target as { kind?: string; namespace?: string };
      ev.changes = await markers(t.kind === 'workload' ? t.namespace : undefined);
      return ev;
    }
    case 'none': {
      ev.changes = await markers();
      return ev;
    }
  }
}

interface ListedApplication {
  id: string;
  target: Record<string, unknown>;
  finding: { severity: string; code: string } | null;
}

/**
 * The application monitoring the far end of an edge, when it has a finding (ADR-146: the
 * active findings of any application the subject talks to): its detail, for
 * application_finding's caller form.
 */
async function farApplication(reader: Reader, ev: Evidence): Promise<void> {
  const list = await soft(
    reader
      .get<{ applications: ListedApplication[] }>('/applications', { cluster: ev.clusterId })
      .then((r) => r.applications),
    [] as ListedApplication[],
  );
  const f = ev.focus;
  const mine = list.find((a) => {
    const t = a.target as Record<string, string | number | undefined>;
    if (f.kind === 'workload')
      return (
        t.kind === 'workload' &&
        t.namespace === f.namespace &&
        t.workload === f.name &&
        (!t.workload_kind || t.workload_kind === f.workloadKind)
      );
    return ev.containers.some(
      (c) =>
        (t.kind === 'container' && t.container === c.name) ||
        (t.kind === 'compose' &&
          t.compose_project === c.composeProject &&
          t.compose_service === c.composeService &&
          (!t.host || t.host === c.host)),
    );
  });
  if (!mine?.finding) return;
  const d = await soft(
    reader.get<{
      application: Omit<EvApplication, 'reasons'>;
      reasons: EvApplication['reasons'];
    }>(`/applications/${mine.id}`),
    null,
  );
  if (d) ev.application = { ...d.application, reasons: d.reasons };
}

/**
 * NXDOMAIN answers a second to the focus's lookups over the counted hour, when the map shows
 * some: when they began (dns_nxdomain's since).
 */
async function nxdomainSeries(
  reader: Reader,
  ev: Evidence,
  scope: Record<string, string>,
): Promise<void> {
  if (!ev.metrics || !ev.map.dns.some((d) => d.nxdomainPerSecond > 0)) return;
  const a = await range(
    reader,
    ev.clusterId,
    'dns.nxdomain.rate',
    scope,
    countedHour(ev.window.to),
  );
  if (!a) return;
  const f = ev.focus;
  const sum = new Map<number, number>();
  for (const s of a.series) {
    if (f.kind === 'compose_service' && s.labels.compose_service !== f.service) continue;
    for (const [t, v] of s.points)
      if (v !== null && Number.isFinite(v)) sum.set(t, (sum.get(t) ?? 0) + v);
  }
  const points = [...sum].sort((x, y) => x[0] - y[0]) as [number, number][];
  // Only beside the other metrics: an empty count would read as "no restarts".
  if (ev.metrics) ev.metrics = { ...ev.metrics, nxdomain: points };
}

interface RangeAnswer {
  step: number;
  series: { labels: Record<string, string>; points: Point[] }[];
}

/** The counted hour: the last 60 minutes of the window (evidence.ts, COUNT_MS). */
function countedHour(windowTo: string) {
  const to = sec(windowTo);
  return { from: to - COUNT_MS / 1000, to };
}

/** One curated metric over the counted hour, or null when it can't be read. */
async function range(
  reader: Reader,
  clusterId: string,
  metric: string,
  scope: Record<string, string>,
  hour: { from: number; to: number },
): Promise<RangeAnswer | null> {
  if (!reader.post) return null;
  return soft(
    reader.post<RangeAnswer>('/query/range', {
      clusterId,
      metric,
      scope,
      from: hour.from,
      to: hour.to,
      step: 15,
    }),
    null,
  );
}

const bytesPoints = (points: Point[]) =>
  points.filter((p): p is [number, number] => p[1] !== null && Number.isFinite(p[1]));

/** Restarts and memory of a pod or a workload's pods over the counted hour. */
async function kubeMetrics(
  reader: Reader,
  clusterId: string,
  windowTo: string,
  scope: Record<string, string>,
  pods: EvPod[],
): Promise<EvMetrics | null> {
  const hour = countedHour(windowTo);
  const [restarts, memory] = await Promise.all([
    range(reader, clusterId, 'pod.restarts', scope, hour),
    range(reader, clusterId, 'pod.container.memory.working_set', scope, hour),
  ]);
  if (!restarts && !memory) return null;
  const born = new Map(
    pods.map((p) => [`${p.namespace}/${p.name}`, p.createdAt ? sec(p.createdAt) : null]),
  );
  const counts = new Map<string, EvCount[]>();
  for (const s of restarts?.series ?? []) {
    const key = `${s.labels.namespace}/${s.labels.pod}`;
    const c = increase(s.points, born.get(key) ?? null, restarts!.step);
    counts.set(key, [...(counts.get(key) ?? []), c]);
  }
  return {
    from: new Date(hour.from * 1000).toISOString(),
    to: new Date(hour.to * 1000).toISOString(),
    step: restarts?.step ?? memory?.step ?? 15,
    restarts: Object.fromEntries([...counts].map(([k, c]) => [k, sumCounts(c)])),
    oomKills: {},
    memory: Object.fromEntries(
      (memory?.series ?? []).map((s) => [
        `${s.labels.namespace}/${s.labels.pod}/${s.labels.container}`,
        bytesPoints(s.points),
      ]),
    ),
  };
}

/** Restarts, OOM kills and memory of a container or a Compose service's containers. */
async function dockerMetrics(
  reader: Reader,
  clusterId: string,
  windowTo: string,
  scope: Record<string, string>,
  containers: EvContainer[],
): Promise<EvMetrics | null> {
  const hour = countedHour(windowTo);
  const [restarts, kills, memory] = await Promise.all([
    range(reader, clusterId, 'container.restarts', scope, hour),
    range(reader, clusterId, 'container.oom_kills', scope, hour),
    range(reader, clusterId, 'container.memory.working_set', scope, hour),
  ]);
  if (!restarts && !kills && !memory) return null;
  const mine = new Map(containers.map((c) => [`${c.host}/${c.name}`, c]));
  const counted = (a: RangeAnswer | null) => {
    const out: Record<string, EvCount> = {};
    for (const s of a?.series ?? []) {
      const key = `${s.labels.host}/${s.labels.container}`;
      const c = mine.get(key);
      if (c) out[key] = increase(s.points, c.createdAt ?? null, a!.step);
    }
    return out;
  };
  return {
    from: new Date(hour.from * 1000).toISOString(),
    to: new Date(hour.to * 1000).toISOString(),
    step: restarts?.step ?? memory?.step ?? 15,
    restarts: counted(restarts),
    oomKills: counted(kills),
    memory: Object.fromEntries(
      (memory?.series ?? [])
        .map((s) => [`${s.labels.host}/${s.labels.container}`, bytesPoints(s.points)] as const)
        .filter(([k]) => mine.has(k)),
    ),
  };
}

interface ApiMap {
  mode: 'flows' | 'topology';
  agents: EvMap['agents'];
  nodes: EvMap['nodes'];
  edges: EvEdge[];
  dns: EvMap['dns'];
}

/** The focus's place on the service map, and which agents see network flows. */
export async function serviceMap(
  reader: Reader,
  clusterId: string,
  ids: string[],
  namespace?: string,
): Promise<EvMap> {
  let m: ApiMap;
  try {
    m = await reader.get<ApiMap>(`/clusters/${clusterId}/service-map`, {
      namespaces: namespace,
      range: 3600,
    });
  } catch {
    return emptyMap('unavailable');
  }
  const own = new Set(ids);
  return {
    mode: m.mode,
    agents: m.agents.map((a) => ({
      node: a.node,
      ebpf: a.ebpf,
      reason: a.reason ?? null,
      cause: a.cause ?? null,
    })),
    ids,
    nodes: m.nodes.filter(
      (n) => own.has(n.id) || m.edges.some((e) => own.has(e.source) && e.target === n.id),
    ),
    outgoing: m.edges.filter((e) => own.has(e.source)),
    incoming: m.edges.filter((e) => own.has(e.target)),
    dns: m.dns.filter((d) => own.has(d.node)),
  };
}
