// SPDX-License-Identifier: AGPL-3.0-only
// get_events and get_recent_changes (ADR-128): what happened, grouped and bounded.
import { Type } from 'typebox';
import { clusterField, resolveCluster } from '../clusters.js';
import { message, name, text, ToolError } from '../output.js';
import {
  ClusterArg,
  defineTool,
  describe,
  minutesAgo,
  NamespaceArg,
  summary,
  type ApiEvent,
} from './common.js';

const MAX_GROUPS = 30;
const MAX_CHANGES = 30;
const MAX_MINUTES = 24 * 60;

const SinceArg = (dflt: number) =>
  Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_MINUTES,
      description: `How far back, in minutes (default ${dflt}, at most ${MAX_MINUTES}: 24 hours).`,
    }),
  );

// ─── get_events ────────────────────────────────────────────────────────────────

export const getEventsTool = defineTool({
  name: 'get_events',
  title: 'Get events',
  description: describe(
    'Kubernetes events (BackOff, FailedScheduling, Unhealthy, Killing, OOMKilling…) or Docker events (container died, OOM, health status, restarts), grouped by reason and object so repeats count once.',
    `Filter by \`namespace\` (Kubernetes), \`host\` (Docker), \`object\` (a pod, workload, node or container name) and \`type\` (Warning by default, or all). Covers the last \`since\` minutes (60 by default, at most 24 hours). Returns up to ${MAX_GROUPS} groups, newest first: reason, object, how many times, first and last seen, and the latest message.`,
    'Example question: "What warnings did the payments namespace have in the last hour?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      namespace: NamespaceArg('Kubernetes: only this namespace.'),
      host: Type.Optional(
        Type.String({ minLength: 1, maxLength: 253, description: 'Docker: only this host.' }),
      ),
      object: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 253,
          description: 'Only events about the object with this exact name.',
        }),
      ),
      type: Type.Optional(
        Type.Union([Type.Literal('Warning'), Type.Literal('all')], {
          description: 'Warning (default) or all, Normal events included.',
        }),
      ),
      since: SinceArg(60),
    },
    { additionalProperties: false },
  ),
  summarize: (a) =>
    summary(a.cluster, a.namespace ?? a.host, a.object, a.type, a.since && `${a.since} min`),
  async run(args, { api }) {
    const cluster = await resolveCluster(api, args.cluster);
    if (cluster.kind === 'docker' && args.namespace) {
      throw new ToolError(
        'Namespaces are a Kubernetes notion; this cluster is a Docker fleet.',
        'Pass `host` instead, or leave both out.',
        { cluster: clusterField(cluster) },
      );
    }
    if (cluster.kind === 'kubernetes' && args.host) {
      throw new ToolError(
        'Hosts are a Docker notion; this cluster is Kubernetes.',
        'Pass `namespace` instead, or leave both out.',
        { cluster: clusterField(cluster) },
      );
    }
    const minutes = args.since ?? 60;
    const { events } = await api.get<{ events: ApiEvent[] }>(`/clusters/${cluster.id}/events`, {
      namespaces: args.namespace,
      hosts: args.host,
      name: args.object,
      type: args.type === 'all' ? undefined : 'Warning',
      from: minutesAgo(minutes),
      limit: 500,
    });
    const groups = new Map<
      string,
      { first: ApiEvent; count: number; firstSeen: string; lastSeen: string; latest: ApiEvent }
    >();
    for (const e of events) {
      const key = JSON.stringify([e.reason, e.involvedKind, e.namespace ?? e.host, e.involvedName]);
      const g = groups.get(key);
      const first = e.firstSeen ?? e.lastSeen;
      if (!g) {
        groups.set(key, {
          first: e,
          count: e.count,
          firstSeen: first,
          lastSeen: e.lastSeen,
          latest: e,
        });
        continue;
      }
      g.count += e.count;
      if (Date.parse(first) < Date.parse(g.firstSeen)) g.firstSeen = first;
      if (Date.parse(e.lastSeen) > Date.parse(g.lastSeen)) {
        g.lastSeen = e.lastSeen;
        g.latest = e;
      }
    }
    const sorted = [...groups.values()].sort(
      (a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen),
    );
    return {
      body: {
        cluster: clusterField(cluster),
        type: args.type ?? 'Warning',
        sinceMinutes: minutes,
        ...(events.length === 500 ? { note: 'Only the newest 500 events were grouped.' } : {}),
      },
      list: {
        key: 'groups',
        items: sorted.slice(0, MAX_GROUPS).map((g) => ({
          type: g.latest.type,
          reason: text(g.latest.reason, 128),
          object: {
            kind: text(g.latest.involvedKind, 64),
            ...(cluster.kind === 'docker'
              ? { host: name(g.latest.host) }
              : { namespace: name(g.latest.namespace) }),
            name: name(g.latest.involvedName),
          },
          count: g.count,
          firstSeen: g.firstSeen,
          lastSeen: g.lastSeen,
          message: message(g.latest.message),
        })),
        total: sorted.length,
        noun: 'event groups',
        narrow:
          cluster.kind === 'kubernetes'
            ? 'Pass `namespace`, `object` or a shorter `since` to narrow them.'
            : 'Pass `host`, `object` or a shorter `since` to narrow them.',
      },
    };
  },
});

// ─── get_recent_changes ────────────────────────────────────────────────────────

export interface ApiMarker {
  kind: string;
  target: string;
  namespace: string | null;
  details: Record<string, unknown>;
  ts: string;
}

/** A change as tools show it: its target split into kind, namespace or host, and name. */
export function changeField(m: ApiMarker) {
  const parts = m.target.split('/');
  const objectKind = parts[0] ?? '';
  const docker = objectKind === 'Container' || objectKind === 'Compose';
  const object =
    parts.length >= 3
      ? {
          kind: text(objectKind, 64),
          [docker ? 'host' : 'namespace']: name(parts[1]),
          name: name(parts.slice(2).join('/')),
        }
      : { kind: text(objectKind, 64), name: name(parts.slice(1).join('/')) };
  return {
    time: m.ts,
    change: m.kind,
    object,
    detail: Object.fromEntries(
      Object.entries(m.details ?? {})
        .slice(0, 6)
        .map(([k, v]) => [
          text(k, 32),
          typeof v === 'number' || typeof v === 'boolean' || v === null
            ? v
            : text(JSON.stringify(v).replace(/^"|"$/g, ''), 253),
        ]),
    ),
  };
}

export const getRecentChangesTool = defineTool({
  name: 'get_recent_changes',
  title: 'Get recent changes',
  description: describe(
    'What changed lately, to connect a problem with a deploy: on Kubernetes rollouts, image changes, scaling, nodes added or removed and new namespaces; on Docker re-created containers, image changes and Compose project changes.',
    `Covers the last \`since\` minutes (360 by default, at most 24 hours); \`namespace\` narrows it on Kubernetes. Returns up to ${MAX_CHANGES} changes, newest first: time, change (rollout, image, scale, node, namespace, recreate, compose), object, and detail (e.g. the image before and after).`,
    'Example question: "Was anything deployed right before the errors started?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      namespace: NamespaceArg('Kubernetes: only this namespace.'),
      since: SinceArg(360),
    },
    { additionalProperties: false },
  ),
  summarize: (a) => summary(a.cluster, a.namespace, a.since && `${a.since} min`),
  async run(args, { api }) {
    const cluster = await resolveCluster(api, args.cluster);
    if (cluster.kind === 'docker' && args.namespace) {
      throw new ToolError(
        'Namespaces are a Kubernetes notion; this cluster is a Docker fleet.',
        'Leave `namespace` out.',
        { cluster: clusterField(cluster) },
      );
    }
    const minutes = args.since ?? 360;
    const res = await api.get<{ markers: ApiMarker[]; truncated: boolean }>(
      `/clusters/${cluster.id}/change-markers`,
      // A minute past now: a change stamped within this second must not fall outside.
      {
        from: minutesAgo(minutes),
        to: Math.floor(Date.now() / 1000) + 60,
        namespaces: args.namespace,
      },
    );
    const sorted = [...res.markers].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return {
      body: { cluster: clusterField(cluster), sinceMinutes: minutes },
      list: {
        key: 'changes',
        items: sorted.slice(0, MAX_CHANGES).map(changeField),
        total: sorted.length,
        noun: 'changes',
        narrow:
          cluster.kind === 'kubernetes'
            ? 'Pass `namespace` or a shorter `since` to narrow them.'
            : 'Pass a shorter `since` to narrow them.',
      },
    };
  },
});
