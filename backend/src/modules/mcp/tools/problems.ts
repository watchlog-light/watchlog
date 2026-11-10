// SPDX-License-Identifier: AGPL-3.0-only
// get_problems (ADR-128): the dashboard's "Needs attention" list for one cluster.
import { Type } from 'typebox';
import { clusterField, resolveCluster, type ClusterRef } from '../clusters.js';
import { labels, message, name, text, ToolError } from '../output.js';
import type { ApiAlert } from './alerts.js';
import { problemSubject } from '../../causes/likely.js';
import { formatSubject } from '../../causes/subject.js';
import { likelyField, type ApiLikelyCause } from './causes.js';
import { ClusterArg, defineTool, describe, NamespaceArg, summary } from './common.js';

const MAX_PROBLEMS = 50;

interface OverviewProblem {
  severity: 'critical' | 'warning';
  type: 'crashloop' | 'oom' | 'connections' | 'nodes' | 'other';
  why: string | null;
  since: string | null;
  alertId: string | null;
  object: { kind: string; namespace: string | null; name: string } | null;
  related: number;
  likelyCause?: ApiLikelyCause;
}

interface Overview {
  health: string;
  problems: { items: OverviewProblem[]; critical: number; warning: number; silenced: number };
}

/** WatchLog's explanation of a problem type, without any name in it (ADR-129). */
function reason(type: OverviewProblem['type'], kind: ClusterRef['kind']): string {
  switch (type) {
    case 'crashloop':
      return kind === 'docker'
        ? 'Restarting repeatedly: the container keeps exiting.'
        : 'Restarting repeatedly (CrashLoopBackOff): a container keeps exiting.';
    case 'oom':
      return 'Killed for using more memory than its limit (OOMKilled).';
    case 'connections':
      return 'Connections to it are failing.';
    case 'nodes':
      return kind === 'docker'
        ? 'A Docker host is not reporting or is short of resources.'
        : 'A node is not ready or is under pressure.';
    case 'other':
      return 'An alert rule is firing; see `rule`.';
  }
}

/** What a problem is about, as data: Kubernetes namespace and name, or Docker host and name. */
function objectField(
  kind: ClusterRef['kind'],
  object: OverviewProblem['object'],
  alertLabels?: Record<string, string>,
) {
  if (object) {
    return kind === 'docker' && object.kind === 'Container'
      ? { kind: 'Container', host: name(object.namespace), name: name(object.name) }
      : { kind: object.kind, namespace: name(object.namespace), name: name(object.name) };
  }
  return alertLabels ? labels(alertLabels) : null;
}

export const getProblemsTool = defineTool({
  name: 'get_problems',
  title: 'Get problems',
  description: describe(
    'What needs attention in one cluster right now: the dashboard\'s "Needs attention" list. Start here for "what is wrong?".',
    'On Kubernetes: crash-looping or OOM-killed pods, nodes not ready, failing connections and firing alerts. On a Docker fleet: restarting, unhealthy or OOM-killed containers, silent hosts and firing alerts.',
    `Returns health (ok, warning or critical), counts, and up to ${MAX_PROBLEMS} problems, most severe first. Each has severity, type (crashloop, oom, connections, nodes, other), reason (WatchLog's explanation), object (kind, namespace and name on Kubernetes; host and container name on Docker), detail (the dashboard's line, e.g. the last exit code), since, alertId and rule when an alert covers it, subject (what explain_problem takes) and likelyCause when one cause likely explains it (from fixed rules over collected data, no score: rule, headline as a code with its facts, since). A problem without likelyCause has only possible causes, no clear one, or was not worked out in time: explain_problem tells which. When the list is cut, pass \`namespace\` (Kubernetes) to narrow it.`,
    "Next steps: explain_problem with a problem's subject for its probable cause and evidence; explain_alert for a problem with an alertId; get_pod for a pod or container; get_workload for a Deployment or a Compose service.",
    'Example question: "Why is my prod cluster red?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      namespace: NamespaceArg('Kubernetes only: problems in this namespace.'),
    },
    { additionalProperties: false },
  ),
  summarize: (a) => summary(a.cluster, a.namespace),
  async run(args, { api }) {
    const cluster = await resolveCluster(api, args.cluster);
    if (args.namespace && cluster.kind === 'docker') {
      throw new ToolError(
        'Namespaces are a Kubernetes notion; this cluster is a Docker fleet.',
        'Leave `namespace` out. Docker problems name their host and container.',
        { cluster: clusterField(cluster) },
      );
    }
    const [overview, alerts] = await Promise.all([
      api.get<Overview>(`/clusters/${cluster.id}/overview`, { namespaces: args.namespace }),
      api.get<{ alerts: ApiAlert[] }>('/alerts', {
        view: 'firing',
        clusterId: cluster.id,
        limit: 200,
      }),
    ]);
    const byId = new Map(alerts.alerts.map((a) => [a.id, a]));
    const subjectOf = (x: OverviewProblem) => {
      const s = problemSubject(x, cluster.kind);
      return s ? { subject: text(formatSubject(s), 700) } : {};
    };
    const p = overview.problems;
    const items = p.items.slice(0, MAX_PROBLEMS).map((x) => {
      const alert = x.alertId ? byId.get(x.alertId) : undefined;
      return {
        severity: x.severity,
        type: x.type,
        reason: reason(x.type, cluster.kind),
        object: objectField(cluster.kind, x.object, alert?.labels),
        detail: message(x.why),
        since: x.since,
        ...(x.alertId ? { alertId: x.alertId } : {}),
        ...(alert ? { rule: { key: alert.rule.key, name: text(alert.rule.name, 120) } } : {}),
        ...(x.related > 0 ? { alsoAffected: x.related } : {}),
        ...subjectOf(x),
        ...(x.likelyCause ? { likelyCause: likelyField(x.likelyCause) } : {}),
      };
    });
    return {
      body: {
        cluster: clusterField(cluster),
        health: overview.health,
        summary:
          p.items.length === 0
            ? 'No problems.'
            : `${p.critical} critical, ${p.warning} warning${p.silenced ? `, ${p.silenced} silenced` : ''}.`,
        counts: { critical: p.critical, warning: p.warning, silenced: p.silenced },
      },
      list: {
        key: 'problems',
        items,
        total: p.items.length,
        noun: 'problems',
        narrow:
          cluster.kind === 'kubernetes'
            ? 'Pass `namespace` to see one namespace.'
            : 'The most severe come first.',
      },
    };
  },
});
