// SPDX-License-Identifier: AGPL-3.0-only
// What a cause is asked for (ADR-146, ADR-148): `<kind>:<ref>`, in the ids and names the
// other APIs and MCP already use, so a user can type them:
//   alert:<id>                                   an alert (any cluster kind)
//   pod:<namespace>/<pod>                        Kubernetes
//   workload:<namespace>/<Kind>/<name>           Kubernetes; `<namespace>/<name>` when one
//                                                kind has that name
//   container:<host>/<name>                      Docker; `<name>` when one reporting host has it
//   compose_service:<project>/<service>          Docker; `<service>` when one project has it
//   edge:<source>><target>:<port>                the service map's edge id (port may be empty)
//   application:<id>  or  application:<name>     a monitored service, as the Applications page names it
// Pure: parsing and the canonical form only; resolve.ts finds the object.
import { WORKLOAD_KINDS } from '../kubernetes/views.js';

export const SUBJECT_KINDS = [
  'alert',
  'workload',
  'pod',
  'container',
  'compose_service',
  'edge',
  'application',
] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export type Subject =
  | { kind: 'alert'; id: string }
  | { kind: 'pod'; namespace: string; name: string }
  | { kind: 'workload'; namespace: string; workloadKind: string | null; name: string }
  | { kind: 'container'; host: string | null; name: string }
  | { kind: 'compose_service'; project: string | null; service: string }
  | { kind: 'edge'; source: string; target: string; port: number | null }
  | { kind: 'application'; ref: string };

export const SUBJECT_MAX = 700;

/** What the 400 says: the forms, for a reader who typed one wrong. */
export const SUBJECT_FORMS =
  'subject is <kind>:<ref>: alert:<id>, pod:<namespace>/<pod>, workload:<namespace>/<Kind>/<name> (or <namespace>/<name>), container:<host>/<name> (or <name>), compose_service:<project>/<service> (or <service>), edge:<source>><target>:<port> (the service map edge id), application:<id or name>';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Kubernetes: namespaces are DNS labels; pods and workloads DNS subdomains.
const K8S_NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const K8S_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
// Docker: container names [a-zA-Z0-9][a-zA-Z0-9_.-]+; hosts are host names; Compose
// project names are lower case.
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/;
// A service-map node id (servicemap/graph.ts): w:, c:, s:, n:, x:, or internet.
const SOURCE_NODE = /^(w:[a-z0-9-]+\/[A-Za-z]+\/[a-z0-9.-]+|c:[A-Za-z0-9][A-Za-z0-9_.-]*)$/;
const TARGET_NODE = /^(w:[a-z0-9-]*\/[A-Za-z]*\/[a-z0-9.-]*|[csnx]:[^\s>]{1,400}|internet)$/;

export class SubjectError extends Error {}

const fail = (detail: string): never => {
  throw new SubjectError(detail);
};

function workloadKindOf(raw: string): string {
  const kind = WORKLOAD_KINDS.find((k) => k.toLowerCase() === raw.toLowerCase());
  return kind ?? fail(`unknown workload kind ${raw}: one of ${WORKLOAD_KINDS.join(', ')}`);
}

/** The subject in a `subject` parameter, or a SubjectError saying what is wrong. */
export function parseSubject(raw: string): Subject {
  const value = raw.trim();
  if (!value || value.length > SUBJECT_MAX) fail(SUBJECT_FORMS);
  const colon = value.indexOf(':');
  if (colon < 1) fail(SUBJECT_FORMS);
  const kind = value.slice(0, colon) as SubjectKind;
  const ref = value.slice(colon + 1);
  if (!SUBJECT_KINDS.includes(kind)) fail(`unknown subject kind ${kind}. ${SUBJECT_FORMS}`);
  if (!ref) fail(`${kind} needs a ref. ${SUBJECT_FORMS}`);
  const parts = ref.split('/');
  switch (kind) {
    case 'alert':
      if (!UUID.test(ref)) fail('alert:<id> takes the alert id (a UUID)');
      return { kind, id: ref.toLowerCase() };
    case 'pod': {
      const [ns, name] = parts;
      if (parts.length !== 2 || !K8S_NAMESPACE.test(ns!) || !K8S_NAME.test(name!))
        fail('pod:<namespace>/<pod>');
      return { kind, namespace: ns!, name: name! };
    }
    case 'workload': {
      if (parts.length === 2) {
        const [ns, name] = parts;
        if (!K8S_NAMESPACE.test(ns!) || !K8S_NAME.test(name!))
          fail('workload:<namespace>/<Kind>/<name>');
        return { kind, namespace: ns!, workloadKind: null, name: name! };
      }
      const [ns, k, name] = parts;
      if (parts.length !== 3 || !K8S_NAMESPACE.test(ns!) || !K8S_NAME.test(name!))
        fail('workload:<namespace>/<Kind>/<name>');
      return { kind, namespace: ns!, workloadKind: workloadKindOf(k!), name: name! };
    }
    case 'container': {
      if (parts.length === 1) {
        if (!DOCKER_NAME.test(ref)) fail('container:<host>/<name>');
        return { kind, host: null, name: ref };
      }
      const [host, name] = parts;
      if (parts.length !== 2 || !HOST.test(host!) || !DOCKER_NAME.test(name!))
        fail('container:<host>/<name>');
      return { kind, host: host!, name: name! };
    }
    case 'compose_service': {
      if (parts.length === 1) {
        if (!DOCKER_NAME.test(ref)) fail('compose_service:<project>/<service>');
        return { kind, project: null, service: ref };
      }
      const [project, service] = parts;
      if (parts.length !== 2 || !DOCKER_NAME.test(project!) || !DOCKER_NAME.test(service!))
        fail('compose_service:<project>/<service>');
      return { kind, project: project!, service: service! };
    }
    case 'edge':
      return parseEdge(ref);
    case 'application':
      if (ref.length > 253 || /[^\x21-\x7e]/.test(ref)) fail('application:<id or name>');
      return { kind, ref: UUID.test(ref) ? ref.toLowerCase() : ref };
  }
}

/** `<source>><target>:<port>`: the port is after the last colon, and may be empty. */
function parseEdge(ref: string): Subject {
  const form = 'edge:<source>><target>:<port>, as the service map names its edges';
  const gt = ref.indexOf('>');
  if (gt < 1) fail(form);
  const source = ref.slice(0, gt);
  const rest = ref.slice(gt + 1);
  const last = rest.lastIndexOf(':');
  // "internet" has no colon of its own; every other target id has one before the port.
  if (last < 1) fail(form);
  const target = rest.slice(0, last);
  const port = rest.slice(last + 1);
  if (!SOURCE_NODE.test(source) || !TARGET_NODE.test(target)) fail(form);
  if (port !== '' && !/^\d{1,5}$/.test(port)) fail(form);
  const n = port === '' ? null : Number(port);
  if (n !== null && (n < 1 || n > 65535)) fail(form);
  return { kind: 'edge', source, target, port: n };
}

/** The canonical form of a subject: what the answer's `subject.ref` says. */
export function formatSubject(s: Subject): string {
  switch (s.kind) {
    case 'alert':
      return `alert:${s.id}`;
    case 'pod':
      return `pod:${s.namespace}/${s.name}`;
    case 'workload':
      return `workload:${s.namespace}/${s.workloadKind ? `${s.workloadKind}/` : ''}${s.name}`;
    case 'container':
      return `container:${s.host ? `${s.host}/` : ''}${s.name}`;
    case 'compose_service':
      return `compose_service:${s.project ? `${s.project}/` : ''}${s.service}`;
    case 'edge':
      return `edge:${edgeId(s.source, s.target, s.port)}`;
    case 'application':
      return `application:${s.ref}`;
  }
}

/** The service map's edge id (servicemap/graph.ts). */
export const edgeId = (source: string, target: string, port: number | null) =>
  `${source}>${target}:${port ?? ''}`;

/** Which platform a subject kind belongs to; null for both. */
export function platformOf(kind: SubjectKind): 'kubernetes' | 'docker' | null {
  if (kind === 'pod' || kind === 'workload') return 'kubernetes';
  if (kind === 'container' || kind === 'compose_service') return 'docker';
  return null;
}
