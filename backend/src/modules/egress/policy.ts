// SPDX-License-Identifier: AGPL-3.0-only
// The egress policy suggestion (ADR-190, ADR-191): for one Kubernetes workload, a policy
// that allows the egress it was seen using, as YAML text to copy. WatchLog never applies it.
//   - In-cluster destinations come from the flow series (the service map's), so they reach
//     back as far as the metrics retention, at most 30 days.
//   - External names and networks come from the egress inventory (90 days kept), last seen in
//     the last 30 days, plus the expectations that cover the workload.
//   - Two flavours: a standard networking.k8s.io/v1 NetworkPolicy (addresses only: a name
//     becomes "any public address on its port", said in a comment) and a CiliumNetworkPolicy
//     with toFQDNs. Both allow DNS to kube-dns. The detected flavour comes first.
// Every name in the YAML is data from the cluster or from DNS answers: it is validated (DNS
// names, CIDRs, Kubernetes names and labels) and written as a quoted YAML scalar; anything
// that doesn't validate is left out and only counted, never echoed.
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import type { ClusterScope, QuerySeries, VictoriaQueryClient } from '../../lib/victoria.js';
import { escapeLabelValue } from '../query/catalog.js';
import { loadExpectations, parsePattern, type ParsedExpectation } from './expected.js';
import type { SourceIdentity } from './inventory.js';

export const POLICY_WINDOW_S = 30 * 86_400;
export type PolicyFlavour = 'kubernetes' | 'cilium';
export const POLICY_FLAVOURS: readonly PolicyFlavour[] = ['kubernetes', 'cilium'];
export const POLICY_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'] as const;

/** The private, shared, loopback and link-local ranges the standard flavour's public block leaves out. */
const PRIVATE_V4 = [
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
];
const PRIVATE_V6 = ['fc00::/7', 'fe80::/10', '::1/128'];

/** Pod labels that differ between a workload's pods or revisions: never a selector. */
const VOLATILE_LABELS = new Set([
  'pod-template-hash',
  'controller-revision-hash',
  'pod-template-generation',
  'statefulset.kubernetes.io/pod-name',
  'apps.kubernetes.io/pod-index',
  'controller-uid',
  'batch.kubernetes.io/controller-uid',
  'job-name',
  'batch.kubernetes.io/job-name',
  'batch.kubernetes.io/job-completion-index',
]);

// ------------------------------------------------------------------ validation (names are data)

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const LABEL_NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE = /^(([A-Za-z0-9][-A-Za-z0-9_.]{0,61})?[A-Za-z0-9])?$/;

export const validNamespace = (s: string) => DNS_LABEL.test(s);
export const validObjectName = (s: string) =>
  s.length <= 253 && DNS_SUBDOMAIN.test(s) && s.split('.').every((l) => l.length > 0);

/** A Kubernetes label key: an optional DNS-subdomain prefix and a name of at most 63. */
export function validLabelKey(k: string): boolean {
  const slash = k.indexOf('/');
  if (slash < 0) return LABEL_NAME.test(k);
  const prefix = k.slice(0, slash);
  return prefix.length <= 253 && validObjectName(prefix) && LABEL_NAME.test(k.slice(slash + 1));
}
export const validLabelValue = (v: string) => typeof v === 'string' && LABEL_VALUE.test(v);

/** Keeps only valid labels; null when none are left. */
export function cleanLabels(labels: Record<string, unknown> | null | undefined) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels ?? {})) {
    if (typeof v === 'string' && validLabelKey(k) && validLabelValue(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** The labels every one of the pods carries with the same value, minus the volatile ones. */
export function sharedLabels(pods: Record<string, unknown>[]): Record<string, string> | null {
  if (!pods.length) return null;
  let shared: Record<string, string> | null = null;
  for (const p of pods) {
    const l = cleanLabels(p) ?? {};
    if (!shared) {
      shared = { ...l };
      continue;
    }
    for (const k of Object.keys(shared)) if (shared[k] !== l[k]) delete shared[k];
  }
  for (const k of Object.keys(shared ?? {})) if (VOLATILE_LABELS.has(k)) delete shared![k];
  return shared && Object.keys(shared).length ? shared : null;
}

/** `ns/Kind/name`, validated, or a reason. */
export function parseWorkload(
  text: string,
): { ok: true; namespace: string; kind: string; name: string } | { ok: false; reason: string } {
  const parts = text.split('/');
  if (parts.length !== 3) return { ok: false, reason: 'workload is namespace/Kind/name' };
  const [namespace, kind, name] = parts as [string, string, string];
  if (!validNamespace(namespace)) return { ok: false, reason: 'Not a valid namespace' };
  if (!(POLICY_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: `The kind is one of ${POLICY_KINDS.join(', ')}` };
  }
  if (!validObjectName(name)) return { ok: false, reason: 'Not a valid workload name' };
  return { ok: true, namespace, kind, name };
}

// ------------------------------------------------------------------ the policy's inputs

export interface PodPeer {
  namespace: string;
  labels: Record<string, string>;
  /** What it is, for the comment: `ns/name` of a workload or Service (validated). */
  what: string;
  /** The pod ports; null when the traffic went through a Service (its port, not the pod's). */
  ports: number[] | null;
  /** The Service ports seen, when `ports` is null. */
  servicePorts: number[];
}

export interface ExternalName {
  name: string;
  ports: number[];
}

export interface ExternalNetwork {
  cidr: string;
  ports: number[];
  private: boolean;
}

export interface PolicyInput {
  workload: { namespace: string; kind: string; name: string };
  selector: Record<string, string>;
  dns: { namespace: string; labels: Record<string, string> };
  peers: PodPeer[];
  /** Node addresses reached (hostNetwork pods, the API server), by port. */
  nodePorts: number[];
  names: ExternalName[];
  networks: ExternalNetwork[];
  /** Expectations that cover the workload: `*.` patterns and names not seen, CIDRs. */
  patterns: { pattern: string; port: number | null }[];
  expectedNames: { name: string; port: number | null }[];
  expectedNetworks: { cidr: string; port: number | null }[];
  /** Local (single-label) names: no address WatchLog knows, so not in the standard flavour. */
  localNames: ExternalName[];
  /** Destinations beyond the agent's 50 per source: not named, not allowed. */
  unnamed: boolean;
  /** Names or objects left out because they don't validate (counted, never echoed). */
  skipped: number;
  /** In-cluster destinations whose pods' labels WatchLog doesn't know. */
  unresolved: number;
  window: { to: Date; inClusterFrom: Date | null; externalFrom: Date };
  cilium: boolean | null;
}

// ------------------------------------------------------------------ YAML (hand-written, quoted)

/** A YAML double-quoted scalar: JSON strings are valid YAML 1.2 double-quoted scalars. */
const q = (s: string) => JSON.stringify(s);
const day = (d: Date) => d.toISOString().slice(0, 10);
const uniq = (ports: number[]) => [...new Set(ports)].sort((a, b) => a - b);

function policyName(name: string): string {
  const base = `${name}-egress`;
  return base.length <= 253 ? base : `${name.slice(0, 246).replace(/[-.]+$/, '')}-egress`;
}

function labelMap(indent: string, labels: Record<string, string>): string[] {
  return Object.keys(labels)
    .sort()
    .map((k) => `${indent}${q(k)}: ${q(labels[k]!)}`);
}

function header(p: PolicyInput, flavour: PolicyFlavour): string[] {
  const w = p.workload;
  const out = [
    `# Suggested by WatchLog for ${w.namespace}/${w.kind}/${w.name} (${flavour === 'cilium' ? 'CiliumNetworkPolicy' : 'standard NetworkPolicy'}).`,
    '# WatchLog never applies it: review it, and try it in staging first.',
    `# Window: in-cluster destinations from the flow series, ${
      p.window.inClusterFrom
        ? `${day(p.window.inClusterFrom)} to ${day(p.window.to)}`
        : `none retained up to ${day(p.window.to)}`
    } (30 days, or the metrics retention if shorter);`,
    `# external destinations from the egress inventory, ${day(p.window.externalFrom)} to ${day(p.window.to)}, plus expected destinations.`,
  ];
  if (p.unnamed) {
    out.push(
      '# Some destinations went past the agent\'s 50 per source ("Internet"): they have no name and are not allowed here.',
    );
  }
  if (p.unresolved) {
    out.push(
      `# ${p.unresolved} in-cluster destination(s) left out: WatchLog doesn't know their pods' labels (no running pods).`,
    );
  }
  if (p.skipped) {
    out.push(`# ${p.skipped} destination(s) left out: not a valid name, network or label.`);
  }
  return out;
}

function peerComment(indent: string, peer: PodPeer): string[] {
  const out = [`${indent}# ${peer.what}`];
  if (peer.ports === null) {
    out.push(
      `${indent}# reached through a Service on port ${peer.servicePorts.join(', ')}: policies match the pod's port, which WatchLog doesn't keep, so every port of these pods is allowed.`,
    );
  }
  return out;
}

/** The standard flavour: networking.k8s.io/v1 NetworkPolicy. */
export function renderKubernetes(p: PolicyInput): string {
  const w = p.workload;
  const L: string[] = [
    ...header(p, 'kubernetes'),
    '# Standard NetworkPolicy matches addresses, not DNS names, and WatchLog keeps no address behind',
    '# a name: each name below is allowed as any public address on its port.',
  ];
  const namePorts = new Map<number, string[]>();
  for (const n of p.names)
    for (const port of n.ports) namePorts.set(port, [...(namePorts.get(port) ?? []), n.name]);
  for (const e of p.expectedNames) {
    if (e.port !== null) namePorts.set(e.port, [...(namePorts.get(e.port) ?? []), e.name]);
  }
  for (const port of uniq([...namePorts.keys()])) {
    L.push(`#   port ${port}: ${[...new Set(namePorts.get(port))].sort().join(', ')}`);
  }
  const anyPortNames = [
    ...p.expectedNames.filter((e) => e.port === null).map((e) => e.name),
    ...p.patterns.filter((e) => e.port === null).map((e) => e.pattern),
  ];
  if (p.localNames.length) {
    L.push(
      `# Local names are not allowed (no address WatchLog knows): ${p.localNames.map((n) => `${n.name}:${n.ports.join('/')}`).join(', ')}.`,
    );
  }
  L.push(
    'apiVersion: networking.k8s.io/v1',
    'kind: NetworkPolicy',
    'metadata:',
    `  name: ${q(policyName(w.name))}`,
    `  namespace: ${q(w.namespace)}`,
    '  labels:',
    '    "app.kubernetes.io/managed-by": "watchlog-suggestion"',
    'spec:',
    '  podSelector:',
    '    matchLabels:',
    ...labelMap('      ', p.selector),
    '  policyTypes:',
    '    - Egress',
    '  egress:',
    '    # DNS to kube-dns',
    '    - to:',
    '        - namespaceSelector:',
    '            matchLabels:',
    `              "kubernetes.io/metadata.name": ${q(p.dns.namespace)}`,
    '          podSelector:',
    '            matchLabels:',
    ...labelMap('              ', p.dns.labels),
    '      ports:',
    '        - port: 53',
    '          protocol: UDP',
    '        - port: 53',
    '          protocol: TCP',
  );
  for (const peer of p.peers) {
    L.push(
      ...peerComment('    ', peer),
      '    - to:',
      '        - namespaceSelector:',
      '            matchLabels:',
      `              "kubernetes.io/metadata.name": ${q(peer.namespace)}`,
      '          podSelector:',
      '            matchLabels:',
      ...labelMap('              ', peer.labels),
    );
    if (peer.ports) L.push('      ports:', ...portLines('        ', peer.ports));
  }
  if (p.nodePorts.length) {
    L.push(
      `    # Node addresses were reached on port ${p.nodePorts.join(', ')}: add an ipBlock with your nodes' addresses for them.`,
    );
  }
  const publicPorts = uniq([
    ...namePorts.keys(),
    ...p.patterns.filter((e) => e.port !== null).map((e) => e.port!),
  ]);
  const publicBlock = (ports: number[] | null, why: string) => {
    L.push(
      `    # ${why}`,
      '    - to:',
      '        - ipBlock:',
      '            cidr: "0.0.0.0/0"',
      '            except:',
      ...PRIVATE_V4.map((c) => `              - ${q(c)}`),
      '        - ipBlock:',
      '            cidr: "::/0"',
      '            except:',
      ...PRIVATE_V6.map((c) => `              - ${q(c)}`),
    );
    if (ports) L.push('      ports:', ...portLines('        ', ports));
  };
  if (publicPorts.length) {
    publicBlock(
      publicPorts,
      'Names (and expected name patterns): any public address on their ports',
    );
  }
  if (anyPortNames.length) {
    publicBlock(null, 'Expected for any port: any public address on any port');
    L.push(`    #   ${[...new Set(anyPortNames)].sort().join(', ')}`);
  }
  const nets = new Map<string, { ports: Set<number>; any: boolean; why: string }>();
  const addNet = (cidr: string, port: number | null, why: string) => {
    const n = nets.get(cidr) ?? { ports: new Set<number>(), any: false, why };
    if (port === null) n.any = true;
    else n.ports.add(port);
    nets.set(cidr, n);
  };
  for (const n of p.networks)
    for (const port of n.ports)
      addNet(n.cidr, port, n.private ? 'Private network seen' : 'Raw public network seen');
  for (const e of p.expectedNetworks) addNet(e.cidr, e.port, 'Expected network');
  for (const [cidr, n] of [...nets].sort(([a], [b]) => a.localeCompare(b))) {
    L.push(`    # ${n.why}`, '    - to:', '        - ipBlock:', `            cidr: ${q(cidr)}`);
    if (!n.any) L.push('      ports:', ...portLines('        ', [...n.ports]));
  }
  return `${L.join('\n')}\n`;
}

function portLines(indent: string, ports: number[]): string[] {
  return uniq(ports).flatMap((port) => [`${indent}- port: ${port}`, `${indent}  protocol: TCP`]);
}

function ciliumPorts(indent: string, ports: number[]): string[] {
  return [
    `${indent}toPorts:`,
    `${indent}  - ports:`,
    ...uniq(ports).flatMap((port) => [
      `${indent}      - port: ${q(String(port))}`,
      `${indent}        protocol: TCP`,
    ]),
  ];
}

/** The Cilium flavour: CiliumNetworkPolicy with toFQDNs (ADR-190). */
export function renderCilium(p: PolicyInput): string {
  const w = p.workload;
  const L: string[] = [...header(p, 'cilium')];
  if (p.cilium === false) {
    L.push('# Cilium was not detected on this cluster: this flavour needs Cilium.');
  } else if (p.cilium === null) {
    L.push("# WatchLog doesn't know whether Cilium is installed on this cluster.");
  }
  L.push(
    "# toFQDNs needs Cilium's DNS proxy: the DNS rule below sends this workload's lookups through it.",
    'apiVersion: cilium.io/v2',
    'kind: CiliumNetworkPolicy',
    'metadata:',
    `  name: ${q(policyName(w.name))}`,
    `  namespace: ${q(w.namespace)}`,
    '  labels:',
    '    "app.kubernetes.io/managed-by": "watchlog-suggestion"',
    'spec:',
    '  endpointSelector:',
    '    matchLabels:',
    ...labelMap('      ', p.selector),
    '  egress:',
    '    # DNS to kube-dns, through the DNS proxy',
    '    - toEndpoints:',
    '        - matchLabels:',
    `            "k8s:io.kubernetes.pod.namespace": ${q(p.dns.namespace)}`,
    ...labelMap(
      '            ',
      Object.fromEntries(Object.entries(p.dns.labels).map(([k, v]) => [`k8s:${k}`, v])),
    ),
    '      toPorts:',
    '        - ports:',
    '            - port: "53"',
    '              protocol: ANY',
    '          rules:',
    '            dns:',
    '              - matchPattern: "*"',
  );
  for (const peer of p.peers) {
    L.push(
      ...peerComment('    ', peer),
      '    - toEndpoints:',
      '        - matchLabels:',
      `            "k8s:io.kubernetes.pod.namespace": ${q(peer.namespace)}`,
      ...labelMap('            ', peer.labels),
    );
    if (peer.ports) L.push(...ciliumPorts('      ', peer.ports));
  }
  if (p.nodePorts.length) {
    L.push('    # Node addresses', '    - toEntities:', '        - host', '        - remote-node');
    L.push(...ciliumPorts('      ', p.nodePorts));
  }
  // Names by port: one rule per port, with every name used on it.
  type Fqdn = { name?: string; pattern?: string };
  const byPort = new Map<number | null, Fqdn[]>();
  const add = (port: number | null, f: Fqdn) => byPort.set(port, [...(byPort.get(port) ?? []), f]);
  for (const n of [...p.names, ...p.localNames])
    for (const port of n.ports) add(port, { name: n.name });
  for (const e of p.expectedNames) add(e.port, { name: e.name });
  for (const e of p.patterns) add(e.port, { pattern: e.pattern });
  const keys = [...byPort.keys()].sort((a, b) => (a ?? -1) - (b ?? -1));
  if (p.patterns.length) {
    L.push(
      '    # "*." matches one label in Cilium; Cilium 1.17 and later also accept "**." for any depth.',
    );
  }
  for (const port of keys) {
    const list = byPort.get(port)!;
    const seen = new Set<string>();
    L.push(port === null ? '    # Expected for any port' : `    # Port ${port}`, '    - toFQDNs:');
    for (const f of list.sort((a, b) =>
      (a.name ?? a.pattern!).localeCompare(b.name ?? b.pattern!),
    )) {
      const line = f.name
        ? `        - matchName: ${q(f.name)}`
        : `        - matchPattern: ${q(f.pattern!)}`;
      if (seen.has(line)) continue;
      seen.add(line);
      L.push(line);
    }
    if (port !== null) L.push(...ciliumPorts('      ', [port]));
  }
  const nets = new Map<string, { ports: Set<number>; any: boolean; why: string }>();
  const addNet = (cidr: string, port: number | null, why: string) => {
    const n = nets.get(cidr) ?? { ports: new Set<number>(), any: false, why };
    if (port === null) n.any = true;
    else n.ports.add(port);
    nets.set(cidr, n);
  };
  for (const n of p.networks)
    for (const port of n.ports)
      addNet(n.cidr, port, n.private ? 'Private network seen' : 'Raw public network seen');
  for (const e of p.expectedNetworks) addNet(e.cidr, e.port, 'Expected network');
  for (const [cidr, n] of [...nets].sort(([a], [b]) => a.localeCompare(b))) {
    L.push(`    # ${n.why}`, '    - toCIDR:', `        - ${q(cidr)}`);
    if (!n.any) L.push(...ciliumPorts('      ', [...n.ports]));
  }
  return `${L.join('\n')}\n`;
}

/** The flavours in the order the page shows them: the detected one first (ADR-190, ADR-191). */
export const flavourOrder = (cilium: boolean | null): PolicyFlavour[] =>
  cilium === true ? ['cilium', 'kubernetes'] : ['kubernetes', 'cilium'];

export function notesOf(p: PolicyInput, flavour: PolicyFlavour): string[] {
  const notes: string[] = [];
  if (flavour === 'kubernetes') {
    notes.push(
      'Standard NetworkPolicy matches addresses, not DNS names: each name is allowed as any public address on its port.',
    );
    if (p.nodePorts.length) notes.push("Node addresses were reached: add your nodes' addresses.");
  } else {
    notes.push(
      "toFQDNs needs Cilium's DNS proxy; the policy's DNS rule turns it on for this workload.",
    );
    if (p.cilium === false) notes.push('Cilium was not detected on this cluster.');
    if (p.cilium === null) notes.push("WatchLog doesn't know whether Cilium is installed.");
  }
  if (p.peers.some((x) => x.ports === null)) {
    notes.push(
      "Destinations reached through a Service allow every port of their pods: WatchLog keeps the Service's port, not the pod's.",
    );
  }
  if (p.unnamed)
    notes.push('Destinations beyond the 50 per source have no name and are not allowed.');
  return notes;
}

// ------------------------------------------------------------------ gathering the inputs

type Json = Record<string, unknown>;
const asJson = (v: unknown): Json =>
  (typeof v === 'string' ? (JSON.parse(v) as Json) : ((v ?? {}) as Json)) ?? {};

/** Shared labels of each workload's live pods, by `ns/Kind/name`. */
async function podLabels(db: Database, orgId: string, clusterId: string, namespaces: string[]) {
  const out = new Map<string, Record<string, string> | null>();
  if (!namespaces.length) return out;
  const rows = await db
    .selectFrom('objects')
    .select(['namespace', 'spec_summary', 'status_summary'])
    .where('org_id', '=', orgId)
    .where('cluster_id', '=', clusterId)
    .where('source', '=', 'kubernetes')
    .where('kind', '=', 'Pod')
    .where('deleted_at', 'is', null)
    .where('namespace', 'in', [...new Set(namespaces)])
    .execute();
  const groups = new Map<string, Json[]>();
  for (const r of rows) {
    const spec = asJson(r.spec_summary);
    const st = asJson(r.status_summary);
    const wl = spec.workload as { kind?: string; name?: string } | undefined;
    if (!wl?.kind || !wl.name) continue;
    if (st.phase === 'Succeeded' || st.phase === 'Failed') continue;
    const k = `${r.namespace}/${wl.kind}/${wl.name}`;
    groups.set(k, [...(groups.get(k) ?? []), (spec.labels ?? {}) as Json]);
  }
  for (const [k, pods] of groups) out.set(k, sharedLabels(pods));
  return out;
}

/** Services' selectors by `ns/name`. */
async function serviceSelectors(
  db: Database,
  orgId: string,
  clusterId: string,
  namespaces: string[],
) {
  const out = new Map<string, Record<string, string> | null>();
  if (!namespaces.length) return out;
  const rows = await db
    .selectFrom('objects')
    .select(['namespace', 'name', 'spec_summary'])
    .where('org_id', '=', orgId)
    .where('cluster_id', '=', clusterId)
    .where('source', '=', 'kubernetes')
    .where('kind', '=', 'Service')
    .where('deleted_at', 'is', null)
    .where('namespace', 'in', [...new Set(namespaces)])
    .execute();
  for (const r of rows) {
    out.set(`${r.namespace}/${r.name}`, cleanLabels(asJson(r.spec_summary).selector as Json));
  }
  return out;
}

const isDnsPeer = (l: Record<string, string>) =>
  l.dst_namespace === 'kube-system' &&
  (l.dst_service === 'kube-dns' || l.dst_port === '53' || /dns/.test(l.dst_workload ?? ''));

export interface GatherOptions {
  db: Database;
  victoria: Pick<VictoriaQueryClient, 'query'> | null;
  orgId: string;
  cluster: { id: string; scope: ClusterScope };
  workload: { namespace: string; kind: string; name: string };
  nowMs: number;
}

export type Gathered =
  { ok: true; input: PolicyInput } | { ok: false; status: 404 | 409; reason: string };

/** Everything the suggestion needs, read inside the org (RLS in Cloud: ADR-192). */
export async function gatherPolicy(o: GatherOptions): Promise<Gathered> {
  const { db, orgId, cluster, workload: w, nowMs } = o;
  const to = new Date(nowMs);
  const externalFrom = new Date(nowMs - POLICY_WINDOW_S * 1000);
  const source: SourceIdentity = {
    namespace: w.namespace,
    workload_kind: w.kind,
    workload: w.name,
  };

  const [own, workloadRow, rows, expectations, agent, system] = await Promise.all([
    podLabels(db, orgId, cluster.id, [w.namespace]),
    db
      .selectFrom('objects')
      .select('id')
      .where('org_id', '=', orgId)
      .where('cluster_id', '=', cluster.id)
      .where('source', '=', 'kubernetes')
      .where('kind', '=', w.kind)
      .where('namespace', '=', w.namespace)
      .where('name', '=', w.name)
      .where('deleted_at', 'is', null)
      .executeTakeFirst(),
    db
      .selectFrom('egress_destinations')
      .select(['destination', 'port', 'destination_class'])
      .where('org_id', '=', orgId)
      .where('cluster_id', '=', cluster.id)
      .where(sql<boolean>`source = ${JSON.stringify(source)}::jsonb`)
      .where('last_seen', '>=', externalFrom)
      .execute(),
    loadExpectations(db, orgId, cluster.id),
    db
      .selectFrom('agent_instances')
      .select('capabilities')
      .where('org_id', '=', orgId)
      .where('cluster_id', '=', cluster.id)
      .where('mode', '=', 'cluster')
      .orderBy('last_seen_at', 'desc')
      .executeTakeFirst(),
    serviceSelectors(db, orgId, cluster.id, ['kube-system']),
  ]);
  // kube-dns's own selector when the cluster has the Service, else the usual label.
  const dnsLabels = system.get('kube-system/kube-dns') ?? null;
  const selector = own.get(`${w.namespace}/${w.kind}/${w.name}`) ?? null;
  if (!workloadRow && !selector && !rows.length) {
    return { ok: false, status: 404, reason: 'No such workload in this cluster' };
  }
  if (!selector) {
    return {
      ok: false,
      status: 409,
      reason:
        "No running pod of this workload: the policy selects its pods by the labels they share, and WatchLog doesn't know them yet",
    };
  }
  const cil = asJson(agent?.capabilities).cilium;
  const cilium = typeof cil === 'boolean' ? cil : null;

  let skipped = 0;
  let unnamed = false;
  const names = new Map<string, Set<number>>();
  const localNames = new Map<string, Set<number>>();
  const networks = new Map<string, { ports: Set<number>; private: boolean }>();
  for (const r of rows) {
    const port = Number(r.port);
    if (r.destination_class === 'internet') {
      unnamed = true;
      continue;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      skipped++;
      continue;
    }
    const parsed = parsePattern(r.destination);
    if (r.destination_class === 'name' || r.destination_class === 'local_name') {
      if (!parsed.ok || parsed.pattern.kind !== 'name' || parsed.pattern.text !== r.destination) {
        skipped++;
        continue;
      }
      const into = r.destination_class === 'name' ? names : localNames;
      into.set(r.destination, (into.get(r.destination) ?? new Set()).add(port));
    } else {
      if (!parsed.ok || parsed.pattern.kind !== 'cidr') {
        skipped++;
        continue;
      }
      const n = networks.get(parsed.pattern.text) ?? {
        ports: new Set<number>(),
        private: r.destination_class === 'private_network',
      };
      n.ports.add(port);
      networks.set(parsed.pattern.text, n);
    }
  }
  const covering = expectations.filter(
    (e: ParsedExpectation) =>
      !e.source ||
      (e.source.namespace === w.namespace &&
        e.source.workload_kind === w.kind &&
        e.source.workload === w.name),
  );
  const patterns: PolicyInput['patterns'] = [];
  const expectedNames: PolicyInput['expectedNames'] = [];
  const expectedNetworks: PolicyInput['expectedNetworks'] = [];
  for (const e of covering) {
    const p = e.parsed;
    if (p.kind === 'suffix') patterns.push({ pattern: p.text, port: e.port });
    else if (p.kind === 'cidr') expectedNetworks.push({ cidr: p.text, port: e.port });
    else if (!(e.port !== null && names.get(p.text)?.has(e.port))) {
      expectedNames.push({ name: p.text, port: e.port });
    }
  }

  // In-cluster destinations from the flow series: the workload's edges to workloads, Services
  // and nodes in the window (or the retention, if shorter).
  let inClusterFrom: Date | null = null;
  const peers: PodPeer[] = [];
  const nodePorts = new Set<number>();
  let unresolved = 0;
  if (o.victoria) {
    const sel = [
      `namespace="${escapeLabelValue(w.namespace)}"`,
      `workload_kind="${escapeLabelValue(w.kind)}"`,
      `workload="${escapeLabelValue(w.name)}"`,
      'dst_kind=~"workload|service|node"',
    ].join(', ');
    const by =
      'dst_kind, dst_namespace, dst_workload_kind, dst_workload, dst_service, dst, dst_port';
    const win = `[${POLICY_WINDOW_S}s]`;
    const at = nowMs / 1000;
    const [edges, first] = await Promise.all([
      o.victoria.query(
        cluster.scope,
        `(sum by (${by}) (increase(watchlog_flow_connections_total{${sel}}${win})) > 0) or (sum by (${by}) (increase(watchlog_flow_bytes_total{${sel}}${win})) > 0)`,
        at,
      ),
      o.victoria.query(
        cluster.scope,
        `min(tfirst_over_time(watchlog_flow_connections_total{${sel.replace(', dst_kind=~"workload|service|node"', '')}}${win}))`,
        at,
      ),
    ]);
    const t = first[0]?.points[0]?.[1];
    if (typeof t === 'number' && t > 0) {
      inClusterFrom = new Date(Math.max(Math.min(t * 1000, nowMs), nowMs - POLICY_WINDOW_S * 1000));
    }
    const live = edges.filter((s: QuerySeries) => (s.points[0]?.[1] ?? 0) > 0);
    const nss = live.map((s) => s.labels.dst_namespace ?? '').filter(validNamespace);
    const [pods, services] = await Promise.all([
      podLabels(db, orgId, cluster.id, nss),
      serviceSelectors(db, orgId, cluster.id, nss),
    ]);
    const byPeer = new Map<string, PodPeer>();
    for (const s of live) {
      const l = s.labels;
      const port = Number(l.dst_port);
      const hasPort = Number.isInteger(port) && port > 0 && port <= 65535;
      if (l.dst_kind === 'node') {
        if (hasPort) nodePorts.add(port);
        continue;
      }
      if (isDnsPeer(l)) continue;
      const ns = l.dst_namespace ?? '';
      if (!validNamespace(ns)) {
        skipped++;
        continue;
      }
      let labels: Record<string, string> | null;
      let what: string;
      const viaService = !!l.dst_service;
      if (viaService) {
        if (!validObjectName(l.dst_service!)) {
          skipped++;
          continue;
        }
        labels = services.get(`${ns}/${l.dst_service}`) ?? null;
        what = `Service ${ns}/${l.dst_service}`;
        if (l.dst_kind === 'workload' && validObjectName(l.dst_workload ?? '')) {
          what += ` (${l.dst_workload_kind ?? ''} ${l.dst_workload})`;
          labels ??= pods.get(`${ns}/${l.dst_workload_kind}/${l.dst_workload}`) ?? null;
        }
      } else {
        if (
          !validObjectName(l.dst_workload ?? '') ||
          !(POLICY_KINDS as readonly string[]).concat('Pod').includes(l.dst_workload_kind ?? '')
        ) {
          skipped++;
          continue;
        }
        labels = pods.get(`${ns}/${l.dst_workload_kind}/${l.dst_workload}`) ?? null;
        what = `${l.dst_workload_kind} ${ns}/${l.dst_workload}`;
      }
      if (!labels) {
        unresolved++;
        continue;
      }
      const key = `${ns}\u0000${JSON.stringify(Object.entries(labels).sort())}\u0000${viaService}`;
      const peer = byPeer.get(key) ?? {
        namespace: ns,
        labels,
        what,
        ports: viaService ? null : [],
        servicePorts: [],
      };
      if (hasPort) (viaService ? peer.servicePorts : peer.ports!).push(port);
      byPeer.set(key, peer);
    }
    // A direct edge and a Service edge to the same pods: the Service's "every port" wins.
    for (const peer of byPeer.values()) {
      peer.servicePorts = uniq(peer.servicePorts);
      if (peer.ports) peer.ports = uniq(peer.ports);
      peers.push(peer);
    }
    peers.sort((a, b) => a.what.localeCompare(b.what));
  }
  const input: PolicyInput = {
    workload: w,
    selector,
    dns: { namespace: 'kube-system', labels: dnsLabels ?? { 'k8s-app': 'kube-dns' } },
    peers,
    nodePorts: uniq([...nodePorts]),
    names: [...names]
      .map(([name, ports]) => ({ name, ports: uniq([...ports]) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    networks: [...networks].map(([cidr, n]) => ({
      cidr,
      ports: uniq([...n.ports]),
      private: n.private,
    })),
    patterns,
    expectedNames,
    expectedNetworks,
    localNames: [...localNames].map(([name, ports]) => ({ name, ports: uniq([...ports]) })),
    unnamed,
    skipped,
    unresolved,
    window: { to, inClusterFrom, externalFrom },
    cilium,
  };
  return { ok: true, input };
}
