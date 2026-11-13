// SPDX-License-Identifier: AGPL-3.0-only
// From a parsed subject to what the engine looks at: the object (an alert's or an edge's is
// the object it is about), the focus whose evidence is gathered, and when the symptom began
// (the alert's start, else the start of the object's problem in Needs attention, else
// unknown). Unknown objects are NotFound (404); names that fit several are Ambiguous (400).
import { WORKLOAD_KINDS } from '../kubernetes/views.js';
import { edgeMatchers, sourceNode, targetNode } from '../servicemap/graph.js';
import type {
  EvAlert,
  EvContainer,
  EvEdge,
  EvMapNode,
  EvPod,
  EvWorkload,
  Focus,
  Reader,
} from './evidence.js';
import { notFound, soft } from './gather.js';
import { edgeId, type Subject } from './subject.js';
import type { ObjectRef, Platform } from './types.js';

export class NotFoundError extends Error {}
export class AmbiguousError extends Error {}

export interface ClusterRef {
  id: string;
  name: string;
  kind: Platform;
}

export interface Target {
  /** The subject as asked, in its canonical form (a workload with its kind, a container with its host). */
  subject: Subject;
  /** The subject as an object (an alert, an edge, a pod…). */
  self: ObjectRef;
  /** What an alert or an edge is about; the subject itself otherwise; null for none. */
  object: ObjectRef | null;
  focus: Focus;
  alert: EvAlert | null;
  edge: EvEdge | null;
  symptomAt: string | null;
  resolvedAt: string | null;
}

interface OverviewProblem {
  since: string | null;
  alertId: string | null;
  object: { kind: string; namespace: string | null; name: string } | null;
}

const workloadKindOf = (k: string | undefined) =>
  WORKLOAD_KINDS.find((x) => x.toLowerCase() === (k ?? '').toLowerCase());

export const podObject = (namespace: string, name: string): ObjectRef => ({
  kind: 'pod',
  ref: `${namespace}/${name}`,
  name,
  platform: 'kubernetes',
});
export const workloadObject = (namespace: string, kind: string, name: string): ObjectRef => ({
  kind: 'workload',
  ref: `${namespace}/${kind}/${name}`,
  name: `${namespace}/${name}`,
  platform: 'kubernetes',
  workloadKind: kind,
});
export const containerObject = (host: string, name: string): ObjectRef => ({
  kind: 'container',
  ref: `${host}/${name}`,
  name,
  platform: 'docker',
  host,
});
export const composeObject = (project: string, service: string, host?: string): ObjectRef => ({
  kind: 'compose_service',
  ref: `${project}/${service}`,
  name: `${project}/${service}`,
  platform: 'docker',
  ...(host ? { host } : {}),
});
export const nodeObject = (name: string, platform: Platform): ObjectRef => ({
  kind: platform === 'docker' ? 'host' : 'node',
  ref: name,
  name,
  platform,
});

/** The object of the focus, as a step or the answer names it. */
export function focusObject(f: Focus, platform: Platform): ObjectRef | null {
  switch (f.kind) {
    case 'pod':
      return podObject(f.namespace, f.name);
    case 'workload':
      return workloadObject(f.namespace, f.workloadKind, f.name);
    case 'container':
      return containerObject(f.host, f.name);
    case 'compose_service':
      return composeObject(f.project, f.service);
    case 'node':
    case 'host':
      return nodeObject(f.name, platform);
    case 'application':
      return { kind: 'application', ref: f.id, name: f.id, platform };
    case 'none':
      return null;
  }
}

/** The problem start of an object: Needs attention's `since`, or its alert's. */
async function problemSince(
  reader: Reader,
  cluster: ClusterRef,
  matches: (p: {
    object: OverviewProblem['object'];
    labels: Record<string, string> | null;
  }) => boolean,
): Promise<string | null> {
  const [overview, firing] = await Promise.all([
    soft(
      reader.get<{ problems: { items: OverviewProblem[] } }>(`/clusters/${cluster.id}/overview`),
      { problems: { items: [] } },
    ),
    soft(
      reader.get<{ alerts: EvAlert[] }>('/alerts', {
        view: 'firing',
        clusterId: cluster.id,
        limit: 200,
      }),
      { alerts: [] as EvAlert[] },
    ),
  ]);
  const labelsOf = new Map(firing.alerts.map((a) => [a.id, a.labels]));
  const since = overview.problems.items
    .filter((p) =>
      matches({ object: p.object, labels: p.alertId ? (labelsOf.get(p.alertId) ?? null) : null }),
    )
    .map((p) => p.since)
    .filter((s): s is string => !!s)
    .sort();
  return since[0] ?? null;
}

/** One container by name (and host): a reporting host's copy when stale ones exist. */
export async function findContainer(
  reader: Reader,
  cluster: ClusterRef,
  name: string,
  host: string | null,
): Promise<EvContainer> {
  const { containers } = await reader.get<{ containers: EvContainer[] }>(
    `/clusters/${cluster.id}/docker/containers`,
  );
  const matches = containers.filter((c) => c.name === name && (!host || c.host === host));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0)
    throw new NotFoundError(
      host ? 'No container with this name on this host' : 'No container with this name',
    );
  const { hosts } = await reader.get<{ hosts: { name: string; status: string }[] }>(
    `/clusters/${cluster.id}/docker/hosts`,
  );
  const live = new Set(hosts.filter((h) => h.status === 'active').map((h) => h.name));
  const current = matches.filter((c) => live.has(c.host));
  if (current.length === 1) return current[0]!;
  throw new AmbiguousError(
    'Containers with this name run on several hosts: say which as container:<host>/<name>',
  );
}

/** The workload's kind when the subject left it out. */
export async function findWorkload(
  reader: Reader,
  cluster: ClusterRef,
  namespace: string,
  name: string,
  kind: string | null,
): Promise<EvWorkload> {
  const { workloads } = await reader.get<{ workloads: EvWorkload[] }>(
    `/clusters/${cluster.id}/workloads`,
    { namespaces: namespace, range: 3600 },
  );
  const matches = workloads.filter(
    (w) => w.namespace === namespace && w.name === name && (!kind || w.kind === kind),
  );
  if (matches.length === 0) throw new NotFoundError('No workload with this name in this namespace');
  if (matches.length > 1)
    throw new AmbiguousError(
      `Several workloads have this name (${matches.map((w) => w.kind).join(', ')}): say which as workload:<namespace>/<Kind>/<name>`,
    );
  return matches[0]!;
}

/** What an alert is about, from its labels (the alert texts' own reading of them). */
export async function alertFocus(
  reader: Reader,
  cluster: ClusterRef,
  l: Record<string, string>,
): Promise<{ focus: Focus; edge: EvEdge | null }> {
  const none = { focus: { kind: 'none' } as Focus, edge: null };
  // A monitored application's alert (its curated metrics are by service and service_type):
  // the application, whose findings say why (application_finding, slice 3).
  if (l.service && l.service_type)
    return { focus: { kind: 'application', id: l.service }, edge: null };
  if (cluster.kind === 'kubernetes') {
    // A failed-connections alert is about an edge, without its port.
    if (l.dst_kind) return edgeFocus(reader, cluster, l);
    if (l.namespace && l.pod)
      return { focus: { kind: 'pod', namespace: l.namespace, name: l.pod }, edge: null };
    const kind = workloadKindOf(l.workload_kind);
    if (l.namespace && l.workload && kind)
      return {
        focus: { kind: 'workload', namespace: l.namespace, workloadKind: kind, name: l.workload },
        edge: null,
      };
    if (l.node) return { focus: { kind: 'node', name: l.node }, edge: null };
    return none;
  }
  if (l.dst_kind) return edgeFocus(reader, cluster, l);
  const host = l.node ?? l.host;
  if (l.container && host)
    return { focus: { kind: 'container', host, name: l.container }, edge: null };
  const service = l.compose_service ?? l.service;
  const project = l.compose_project ?? l.project;
  if (service && project)
    return { focus: { kind: 'compose_service', project, service }, edge: null };
  if (host) return { focus: { kind: 'host', name: host }, edge: null };
  return none;
}

/** The edge of a failed-connections alert: the map's edge with these labels, any port. */
async function edgeFocus(
  reader: Reader,
  cluster: ClusterRef,
  l: Record<string, string>,
): Promise<{ focus: Focus; edge: EvEdge | null }> {
  const src = sourceNode(l);
  const dst = targetNode(l);
  if (!src || !dst) return { focus: { kind: 'none' }, edge: null };
  const map = await soft(
    reader.get<{ edges: EvEdge[] }>(`/clusters/${cluster.id}/service-map`, { range: 3600 }),
    { edges: [] as EvEdge[] },
  );
  const edge =
    map.edges
      .filter((e) => e.source === src.id && e.target === dst.id)
      .sort((a, b) => b.failedPerSecond - a.failedPerSecond)[0] ?? null;
  return { focus: await sourceFocus(reader, cluster, src.id), edge };
}

/** The focus of a map node that starts edges: a workload, or a container. */
export async function sourceFocus(reader: Reader, cluster: ClusterRef, id: string): Promise<Focus> {
  if (id.startsWith('w:')) {
    const [ns, kind, ...name] = id.slice(2).split('/');
    const k = workloadKindOf(kind);
    return k && ns
      ? { kind: 'workload', namespace: ns, workloadKind: k, name: name.join('/') }
      : { kind: 'none' };
  }
  if (id.startsWith('c:')) {
    const c = await soft(findContainer(reader, cluster, id.slice(2), null), null);
    return c ? { kind: 'container', host: c.host, name: c.name } : { kind: 'none' };
  }
  return { kind: 'none' };
}

const PLATFORM_ONLY: Record<string, Platform> = {
  pod: 'kubernetes',
  workload: 'kubernetes',
  container: 'docker',
  compose_service: 'docker',
};

/** The target of a subject in a cluster. */
export async function resolveTarget(
  reader: Reader,
  cluster: ClusterRef,
  subject: Subject,
): Promise<Target> {
  const only = PLATFORM_ONLY[subject.kind];
  if (only && only !== cluster.kind)
    throw new AmbiguousError(
      cluster.kind === 'docker'
        ? `${subject.kind} is a Kubernetes subject; this cluster is a Docker fleet (use container or compose_service)`
        : `${subject.kind} is a Docker subject; this cluster is a Kubernetes cluster (use pod or workload)`,
    );
  const base = `/clusters/${cluster.id}`;
  switch (subject.kind) {
    case 'pod': {
      const { namespace, name } = subject;
      await reader
        .get<{ pod: EvPod }>(
          `${base}/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
        )
        .catch((err: unknown) => {
          if (notFound(err)) throw new NotFoundError('No pod with this name in this namespace');
          throw err;
        });
      const object = podObject(namespace, name);
      const since = await problemSince(
        reader,
        cluster,
        ({ object: o, labels: l }) =>
          (o?.kind === 'Pod' && o.namespace === namespace && o.name === name) ||
          (l?.namespace === namespace && l.pod === name),
      );
      return {
        subject,
        self: object,
        object,
        focus: { kind: 'pod', namespace, name },
        alert: null,
        edge: null,
        symptomAt: since,
        resolvedAt: null,
      };
    }
    case 'workload': {
      const w = await findWorkload(
        reader,
        cluster,
        subject.namespace,
        subject.name,
        subject.workloadKind,
      );
      const { pods } = await reader.get<{ pods: EvPod[] }>(`${base}/pods`, {
        namespaces: w.namespace,
        workload: w.name,
        workloadKind: w.kind,
      });
      const podNames = new Set(pods.map((p) => p.name));
      const since = await problemSince(
        reader,
        cluster,
        ({ object: o, labels: l }) =>
          (o?.kind === 'Pod' && o.namespace === w.namespace && podNames.has(o.name)) ||
          (l?.namespace === w.namespace && (l.workload === w.name || podNames.has(l.pod ?? ''))),
      );
      const object = workloadObject(w.namespace, w.kind, w.name);
      return {
        subject: { ...subject, workloadKind: w.kind },
        self: object,
        object,
        focus: { kind: 'workload', namespace: w.namespace, workloadKind: w.kind, name: w.name },
        alert: null,
        edge: null,
        symptomAt: since,
        resolvedAt: null,
      };
    }
    case 'container': {
      const c = await findContainer(reader, cluster, subject.name, subject.host);
      const since = await problemSince(
        reader,
        cluster,
        ({ object: o, labels: l }) =>
          (o?.kind === 'Container' && o.namespace === c.host && o.name === c.name) ||
          (l?.container === c.name && (l.node ?? l.host) === c.host),
      );
      const object = containerObject(c.host, c.name);
      return {
        subject: { kind: 'container', host: c.host, name: c.name },
        self: object,
        object,
        focus: { kind: 'container', host: c.host, name: c.name },
        alert: null,
        edge: null,
        symptomAt: since,
        resolvedAt: null,
      };
    }
    case 'compose_service': {
      const { containers } = await reader.get<{ containers: EvContainer[] }>(
        `${base}/docker/containers`,
      );
      const mine = containers.filter(
        (c) =>
          c.composeService === subject.service &&
          (!subject.project || c.composeProject === subject.project),
      );
      const projects = [...new Set(mine.map((c) => c.composeProject))];
      if (projects.length === 0) throw new NotFoundError('No Compose service with this name');
      if (projects.length > 1)
        throw new AmbiguousError(
          'Compose services with this name run in several projects: say which as compose_service:<project>/<service>',
        );
      const project = projects[0]!;
      const names = new Set(mine.map((c) => `${c.host}/${c.name}`));
      const since = await problemSince(
        reader,
        cluster,
        ({ object: o, labels: l }) =>
          (o?.kind === 'Container' && names.has(`${o.namespace}/${o.name}`)) ||
          (!!l?.container && names.has(`${l.node ?? l.host}/${l.container}`)),
      );
      const hosts = [...new Set(mine.map((c) => c.host))];
      const object = composeObject(
        project,
        subject.service,
        hosts.length === 1 ? hosts[0] : undefined,
      );
      return {
        subject: { kind: 'compose_service', project, service: subject.service },
        self: object,
        object,
        focus: { kind: 'compose_service', project, service: subject.service },
        alert: null,
        edge: null,
        symptomAt: since,
        resolvedAt: null,
      };
    }
    case 'alert': {
      const d = await reader
        .get<{ alert: EvAlert & { cluster: { id: string } } }>(`/alerts/${subject.id}`)
        .catch((err: unknown) => {
          if (notFound(err)) throw new NotFoundError('Alert not found');
          throw err;
        });
      const a = d.alert;
      if (a.cluster.id !== cluster.id) throw new NotFoundError('Alert not found in this cluster');
      const { focus, edge } = await alertFocus(reader, cluster, a.labels);
      const alert: EvAlert = {
        id: a.id,
        state: a.state,
        severity: a.severity,
        rule: a.rule,
        labels: a.labels,
        startedAt: a.startedAt,
        firedAt: a.firedAt,
        resolvedAt: a.resolvedAt,
      };
      const self: ObjectRef = {
        kind: 'alert',
        ref: a.id,
        name: a.rule.name,
        platform: cluster.kind,
      };
      return {
        subject,
        self,
        object: edge ? edgeObject(edge, [], cluster.kind) : focusObject(focus, cluster.kind),
        focus,
        alert,
        edge,
        symptomAt: a.firedAt ?? a.startedAt,
        resolvedAt: a.state === 'resolved' ? a.resolvedAt : null,
      };
    }
    case 'edge': {
      const ns = subject.source.startsWith('w:')
        ? subject.source.slice(2).split('/')[0]
        : undefined;
      const map = await reader
        .get<{ edges: EvEdge[]; nodes: EvMapNode[] }>(`${base}/service-map`, {
          namespaces: ns,
          range: 3600,
        })
        .catch(() => ({ edges: [] as EvEdge[], nodes: [] as EvMapNode[] }));
      const id = edgeId(subject.source, subject.target, subject.port);
      const edge =
        map.edges.find((e) => e.id === id) ??
        (subject.port === null
          ? map.edges.find((e) => e.source === subject.source && e.target === subject.target)
          : undefined);
      if (!edge) throw new NotFoundError('This edge is not on the service map (last hour)');
      const focus = await sourceFocus(reader, cluster, edge.source);
      const matchers = edgeMatchers(edge.source, edge.target, null) ?? {};
      const since = await problemSince(
        reader,
        cluster,
        ({ labels: l }) =>
          !!l?.dst_kind &&
          Object.entries(l).every(([k, v]) => k === 'dst_port' || matchers[k] === v),
      );
      const object = edgeObject(edge, map.nodes, cluster.kind);
      return {
        subject: { kind: 'edge', source: edge.source, target: edge.target, port: edge.port },
        self: object,
        object,
        focus,
        alert: null,
        edge,
        symptomAt: since,
        resolvedAt: null,
      };
    }
    case 'application': {
      const { applications } = await reader.get<{
        applications: { id: string; name: string; type: string; product?: string | null }[];
      }>('/applications', { cluster: cluster.id });
      const matches = applications.filter((a) => a.id === subject.ref || a.name === subject.ref);
      if (matches.length === 0)
        throw new NotFoundError('No monitored service with this id or name in this cluster');
      if (matches.length > 1)
        throw new AmbiguousError('Several monitored services have this name: pass its id');
      const a = matches[0]!;
      const object: ObjectRef = {
        kind: 'application',
        ref: a.id,
        name: a.name,
        platform: cluster.kind,
        type: a.type,
        ...(a.product ? { product: a.product } : {}),
      };
      return {
        subject: { kind: 'application', ref: a.id },
        self: object,
        object,
        focus: { kind: 'application', id: a.id },
        alert: null,
        edge: null,
        symptomAt: null,
        resolvedAt: null,
      };
    }
  }
}

/** A map node's name: a workload's namespace/name, a Docker container's name. */
function mapName(id: string, nodes: EvMapNode[]): string {
  const n = nodes.find((x) => x.id === id);
  if (id.startsWith('c:')) return id.slice(2);
  if (n?.namespace && n.kind === 'workload') return `${n.namespace}/${n.name}`;
  if (n) return n.name;
  if (id.startsWith('w:')) {
    const [ns, , ...name] = id.slice(2).split('/');
    return `${ns}/${name.join('/')}`;
  }
  return id.replace(/^[a-z]:/, '');
}

export function edgeObject(edge: EvEdge, nodes: EvMapNode[], platform: Platform): ObjectRef {
  return {
    kind: 'edge',
    ref: edge.id,
    name: `${mapName(edge.source, nodes)} → ${mapName(edge.target, nodes)}`,
    platform,
  };
}
