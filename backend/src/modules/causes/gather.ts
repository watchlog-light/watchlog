// SPDX-License-Identifier: AGPL-3.0-only
// Gathers an evidence snapshot (evidence.ts) through the API reader: the object, its events,
// the changes around it, the nodes or hosts under it and its place on the service map. Each
// part is optional: a part that can't be read leaves its slot empty and the checks say
// "couldn't check", never a failed answer.
import { ApiReadError } from '../mcp/reader.js';
import {
  emptyMap,
  MAX_EVENT_CONTAINERS,
  MAX_NODES,
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
} from './evidence.js';
import type { Platform } from './types.js';

/** A reader that asks each path once per answer: resolving and gathering share reads. */
export function memoReader(inner: Reader): Reader {
  const seen = new Map<string, Promise<unknown>>();
  return {
    get<T>(path: string, query: Record<string, string | number | boolean | undefined | null> = {}) {
      const key = `${path}?${JSON.stringify(Object.entries(query).sort())}`;
      let p = seen.get(key);
      if (!p) {
        p = inner.get<T>(path, query);
        seen.set(key, p);
      }
      return p as Promise<T>;
    },
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
      [ev.changes, ev.nodes, ev.map] = await Promise.all([
        markers(focus.namespace),
        nodes(pod.node ? [pod.node] : []),
        serviceMap(reader, clusterId, ids, focus.namespace),
      ]);
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
      ev.pods = pods;
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
      [ev.changes, ev.nodes, ev.map] = await Promise.all([
        markers(focus.namespace),
        nodes(under),
        serviceMap(reader, clusterId, [`w:${w.namespace}/${w.kind}/${w.name}`], focus.namespace),
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
      const [events, hosts, changes, map] = await Promise.all([
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
      ]);
      ev.events = events.flat().filter(inWindow).sort(byNewest);
      ev.hosts = hosts.filter((h) => hostNames.includes(h.name));
      ev.changes = changes;
      for (const c of mine) ev.ownTargets.push(`Container/${c.host}/${c.name}`);
      for (const c of mine)
        if (c.composeProject) ev.ownTargets.push(`Compose/${c.host}/${c.composeProject}`);
      ev.ownTargets = [...new Set(ev.ownTargets)];
      ev.map = map;
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
