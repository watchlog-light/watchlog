// SPDX-License-Identifier: AGPL-3.0-only
// list_alerts and explain_alert (ADR-128).
import { Type } from 'typebox';
import { clusterField, resolveCluster, type ClusterRef } from '../clusters.js';
import { labels, message, name, text, ToolError } from '../output.js';
import type { ApiReader } from '../reader.js';
import { defineTool, describe, eventField, notFound, summary, type ApiEvent } from './common.js';
import { causesField, CAUSES_READING, readCauses, type ApiCauses } from './causes.js';
import { changeField, type ApiMarker } from './events.js';
import { containerEvents, containerField, findContainer, podFacts } from './pods.js';
import { composeServiceFacts, workloadFacts } from './workloads.js';

const MAX_ALERTS = 30;
const MAX_EVENTS = 20;
const MAX_CHANGES = 10;
/** Changes are looked for in this window before the alert started. */
const CHANGES_BEFORE_S = 3600;

export interface ApiAlert {
  id: string;
  state: string;
  severity: string;
  why: string | null;
  rule: { id: string; key: string; name: string };
  cluster: { id: string; name: string; kind: 'kubernetes' | 'docker' };
  labels: Record<string, string>;
  startedAt: string;
  firedAt: string | null;
  resolvedAt: string | null;
  silenced: boolean;
  flapping?: boolean;
}

/** An alert as tools show it: no rendered title, which puts names inside a sentence (ADR-129). */
const alertField = (a: ApiAlert) => ({
  id: a.id,
  state: a.state,
  severity: a.severity,
  rule: { key: a.rule.key, name: text(a.rule.name, 120) },
  cluster: { name: name(a.cluster.name), kind: a.cluster.kind },
  object: labels(a.labels),
  detail: message(a.why),
  startedAt: a.startedAt,
  firedAt: a.firedAt,
  resolvedAt: a.resolvedAt,
  silenced: a.silenced,
});

export const listAlertsTool = defineTool({
  name: 'list_alerts',
  title: 'List alerts',
  description: describe(
    'WatchLog alerts: firing now (the default), or recent ones (`state: "recent"`: fired or resolved lately), on every cluster or on one.',
    `Returns counts and up to ${MAX_ALERTS} alerts, newest first. Each has id, state, severity, rule (key and name), cluster (name and kind), object (the labels the alert is about: namespace, workload, pod, container, node or host), detail (why it fired, e.g. the value against the threshold), startedAt, firedAt, resolvedAt and silenced. Pass \`cluster\` or \`severity\` to narrow the list.`,
    'Next step: explain_alert with an alert id.',
    'Example question: "Which alerts fired overnight?"',
  ),
  input: Type.Object(
    {
      state: Type.Optional(
        Type.Union([Type.Literal('firing'), Type.Literal('recent')], {
          description: 'firing (default): firing now; recent: fired or resolved lately.',
        }),
      ),
      cluster: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 253,
          description: 'Only this cluster (name or id). Leave it out for every cluster.',
        }),
      ),
      severity: Type.Optional(
        Type.Union([Type.Literal('critical'), Type.Literal('warning')], {
          description: 'Only this severity.',
        }),
      ),
    },
    { additionalProperties: false },
  ),
  summarize: (a) => summary(a.state ?? 'firing', a.cluster, a.severity),
  async run(args, { api }) {
    const cluster = args.cluster ? await resolveCluster(api, args.cluster) : undefined;
    const res = await api.get<{ alerts: ApiAlert[]; counts: Record<string, number> }>('/alerts', {
      view: args.state === 'recent' ? 'history' : 'firing',
      clusterId: cluster?.id,
      severity: args.severity,
      limit: 200,
    });
    return {
      body: {
        ...(cluster ? { cluster: clusterField(cluster) } : {}),
        state: args.state ?? 'firing',
        counts: res.counts,
      },
      list: {
        key: 'alerts',
        items: res.alerts.slice(0, MAX_ALERTS).map(alertField),
        total: res.alerts.length,
        noun: 'alerts',
        narrow: 'Pass `cluster` or `severity` to narrow the list.',
      },
    };
  },
});

interface AlertDetail {
  alert: ApiAlert;
  history: ApiAlert[];
}

/** The current state of what an alert is about, and that object's events, newest first. */
async function objectState(
  api: ApiReader,
  cluster: ClusterRef,
  l: Record<string, string>,
): Promise<{ state: Record<string, unknown> | null; events: ApiEvent[] }> {
  const gone = (what: string) => ({
    state: { [what]: null, note: 'It no longer exists.' },
    events: [],
  });
  try {
    if (cluster.kind === 'kubernetes') {
      if (l.namespace && l.pod) {
        const f = await podFacts(api, cluster, l.namespace, l.pod);
        return { state: { pod: f.pod, containers: f.containers }, events: f.events };
      }
      if (l.namespace && l.workload) {
        const f = await workloadFacts(api, cluster, l.namespace, l.workload, l.workload_kind);
        return {
          state: { workload: f.workload, pods: f.pods.slice(0, 10) },
          events: f.events,
        };
      }
      if (l.node) {
        const d = await api.get<{
          node: { name: string; status: string; conditions: unknown[] };
          events: ApiEvent[];
        }>(`/clusters/${cluster.id}/nodes/${encodeURIComponent(l.node)}`);
        return {
          state: { node: { name: name(d.node.name), status: d.node.status } },
          events: d.events,
        };
      }
      return { state: null, events: [] };
    }
    const host = l.node ?? l.host;
    if (l.container) {
      const c = await findContainer(api, cluster, l.container, host);
      return {
        state: { container: containerField(c) },
        events: await containerEvents(api, cluster, c, 30),
      };
    }
    if (l.compose_service ?? l.service) {
      const f = await composeServiceFacts(
        api,
        cluster,
        l.compose_project ?? l.project,
        (l.compose_service ?? l.service)!,
      );
      return { state: { service: f.service }, events: f.events };
    }
    return { state: null, events: [] };
  } catch (err) {
    if (err instanceof ToolError) return gone(l.pod ? 'pod' : l.container ? 'container' : 'object');
    throw err;
  }
}

export const explainAlertTool = defineTool({
  name: 'explain_alert',
  title: 'Explain an alert',
  description: describe(
    "Everything WatchLog knows about one alert, to explain why it fired: the alert and its rule, its ranked probable causes with their evidence, the current state of the object it is about (a pod and its containers, a workload, a node, or a Docker container or Compose service), that object's events, and the changes (rollouts, image changes, scaling, re-created containers) in the hour before it started.",
    `Pass \`alertId\` from get_problems or list_alerts. Returns alert (state, severity, rule, object labels, detail, times), occurrences (how often it fired before), causes (state, headline, causes, checks, flowsOff: the same as explain_problem; null when they could not be worked out), state, up to ${MAX_CHANGES} changes and up to ${MAX_EVENTS} events, newest first.`,
    `${CAUSES_READING} Check a cause against the termination reasons, exit codes, events and changes returned beside it.`,
    'Example question: "Why did the OOM alert on the cart pod fire?"',
  ),
  input: Type.Object(
    {
      alertId: Type.String({
        format: 'uuid',
        description: 'The alert id, from get_problems or list_alerts.',
      }),
    },
    { additionalProperties: false },
  ),
  summarize: (a) => summary(a.alertId),
  async run(args, { api }) {
    const d = await api.get<AlertDetail>(`/alerts/${args.alertId}`).catch((err: unknown) =>
      notFound(
        err,
        'No alert with this id.',
        'Take an alert id from get_problems or list_alerts.',
        {
          alertId: args.alertId,
        },
      ),
    );
    const a = d.alert;
    const cluster: ClusterRef = { id: a.cluster.id, name: a.cluster.name, kind: a.cluster.kind };
    const started = Math.floor(Date.parse(a.firedAt ?? a.startedAt) / 1000);
    const end = a.resolvedAt
      ? Math.floor(Date.parse(a.resolvedAt) / 1000) + 60
      : Math.floor(Date.now() / 1000) + 60;
    const [object, markers, causes] = await Promise.all([
      objectState(api, cluster, a.labels),
      api
        .get<{ markers: ApiMarker[] }>(`/clusters/${cluster.id}/change-markers`, {
          from: started - CHANGES_BEFORE_S,
          to: end,
          namespaces: cluster.kind === 'kubernetes' ? a.labels.namespace : undefined,
        })
        .then((r) => r.markers)
        .catch(() => [] as ApiMarker[]),
      // The probable cause is one more part: without it, the facts still come.
      readCauses(api, cluster.id, `alert:${a.id}`).catch(() => null as ApiCauses | null),
    ]);
    const changes = [...markers]
      .sort((x, y) => Date.parse(y.ts) - Date.parse(x.ts))
      .slice(0, MAX_CHANGES)
      .map(changeField);
    return {
      body: {
        cluster: clusterField(cluster),
        alert: alertField(a),
        occurrences: {
          before: d.history.length,
          lastResolvedAt: d.history.find((h) => h.resolvedAt)?.resolvedAt ?? null,
        },
        causes: causes ? causesField(causes) : null,
        state: object.state,
        changes,
      },
      list: {
        key: 'events',
        items: object.events.slice(0, MAX_EVENTS).map(eventField),
        total: object.events.length,
        noun: 'events',
        narrow: 'The newest come first; get_events shows more.',
      },
    };
  },
});
