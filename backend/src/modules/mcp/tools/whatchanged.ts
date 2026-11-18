// SPDX-License-Identifier: AGPL-3.0-only
// What changed over MCP (ADR-202): get_what_changed, what left its usual range in a
// Kubernetes cluster or a Docker fleet, around an alert or in a window of at most 24 hours.
// Read-only, read through the public GET /what-changed in-process as the token, so it never
// shows more than the API: the org, the Pro gate and the demo's limits all apply. At most
// 30 rows and 16 KB. Workload, container, host and Compose names are cluster data in their
// own fields, cleaned and capped by the output layer, never in WatchLog's sentences (ADR-129).
// Only Cloud and the live demo register it (whatChangedExists): Community's list is unchanged.
import { Type } from 'typebox';
import type { ObjectView, RowView } from '../../anomaly/read.js';
import { WHAT_CHANGED_MAX_RANGE_S } from '../../anomaly/read.js';
import { clusterField, resolveCluster } from '../clusters.js';
import { name, text, ToolError } from '../output.js';
import { ApiReadError } from '../reader.js';
import { likelyField, type ApiLikelyCause } from './causes.js';
import { ClusterArg, defineTool, describe, notFound, round, summary } from './common.js';

/** get_what_changed: at most this many rows (ADR-202; the API gives 50). */
export const MCP_WHAT_CHANGED_ROWS = 30;

/** The tool's refusal for an org without Pro (the route's 403 `pro-feature`). */
export const PRO_REFUSAL = 'What changed is part of WatchLog Pro; this organization is on Free.';

interface ApiWhatChanged {
  cluster: { id: string; name: string; kind: 'kubernetes' | 'server' };
  window: { from: string; to: string; alert: { id: string; startedAt: string } | null };
  sort: 'first' | 'furthest';
  chart: { counts: number[] };
  rows: RowView[];
  total: number;
  truncated: boolean;
  learning: {
    learning: boolean;
    since: string | null;
    until: string | null;
    day: number | null;
    hoursLearned: number;
    hoursTotal: number;
    series: { total: number | null; learning: number; readyAt: string | null };
  };
  cause: { subject: string | null; likely: ApiLikelyCause | null };
}

/** What a row is about, in its platform's words; every value a cleaned name (data). */
function objectOut(o: ObjectView) {
  switch (o.kind) {
    case 'workload':
      return {
        kind: o.kind,
        namespace: name(o.namespace),
        workloadKind: text(o.workloadKind, 64),
        name: name(o.name),
      };
    case 'container':
      return {
        kind: o.kind,
        ...(o.host ? { host: name(o.host) } : {}),
        name: name(o.name),
        ...(o.composeProject ? { composeProject: name(o.composeProject) } : {}),
        ...(o.composeService ? { composeService: name(o.composeService) } : {}),
      };
    case 'service':
      return { kind: o.kind, name: name(o.name), ...(o.id ? { id: text(o.id, 64) } : {}) };
    default:
      // A Kubernetes node or a Docker host.
      return { kind: o.kind, name: name(o.name) };
  }
}

const rowOut = (r: RowView) => ({
  object: objectOut(r.object),
  key: text(r.key, 128),
  unit: text(r.unit, 32),
  ...(r.peer ? { peer: name(r.peer) } : {}),
  since: r.since,
  until: r.until,
  ...(r.until === null ? { ongoing: true } : {}),
  usual: { low: round(r.usualLow), high: round(r.usualHigh) },
  value: round(r.value),
  peakScore: round(r.peakScore),
  peakAt: r.peakAt,
});

const at = (s: number) => new Date(s * 1000).toISOString();

export const getWhatChangedTool = defineTool({
  name: 'get_what_changed',
  title: 'What changed',
  description: describe(
    'What left its usual range in a Kubernetes cluster or a Docker fleet: each series compared with its own usual range for that hour of the week (median and spread over the last weeks; statistics, no model). Use it for "what changed around this alert?", "what is unusual in prod right now?" or "what moved first before checkout got slow?". Pass `alert` (an alert id from list_alerts or get_problems) for the window around it: 60 minutes before it started to 15 minutes after, or now. Otherwise `from` and `to` (Unix seconds) give a window of at most 24 hours; the default is the last hour.',
    `Rows are in the platform's words. Kubernetes: object.kind workload (namespace, workloadKind, name) or node. Docker: container (host, name, composeProject, composeService) or host. A monitored service (PostgreSQL, Redis…) is kind service. Each row has key (the catalog key, or edge.* for a service map connection with \`peer\` as its destination), unit, since and until (null and \`ongoing\` while it lasts), usual (low and high at that hour), value (the latest while it lasts, the furthest once it ended) and peakScore (how far out it went, in spreads). \`sort\`: first (by when each left its usual range, the default) or furthest (by peakScore). At most ${MCP_WHAT_CHANGED_ROWS} rows; \`truncated\` with a hint when cut. \`cause\` is probable cause's likely cause for the alert or the first row it can explain (rule, headline, since; explain_problem with \`cause.subject\` gives the evidence), or null.`,
    'For 7 days from the upgrade to Pro, WatchLog learns each series and lists nothing: `learning.learning` is true, with `since` (when learning started), `until` (when the list turns on), `day` (1 to 7) and `hoursLearned` of `hoursTotal` (168 hours of the week, each seen once). Afterwards `seriesLearning` counts the series that joined later and are still inside their own 7 days, ready by `seriesReadyAt`. What changed is part of WatchLog Pro: on Free the tool says so.',
    'Example question: "What changed in prod-eu around the alert on checkout?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      alert: Type.Optional(
        Type.String({
          format: 'uuid',
          description:
            "An alert's id (list_alerts): the window around it. Leave out `from` and `to`.",
        }),
      ),
      from: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: 'Unix seconds: the window starts here (default: an hour before `to`).',
        }),
      ),
      to: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: 'Unix seconds: the window ends here (default: now). At most 24 hours.',
        }),
      ),
      sort: Type.Optional(
        Type.Union([Type.Literal('first'), Type.Literal('furthest')], {
          description:
            'first: by when each left its usual range (default); furthest: by peakScore.',
        }),
      ),
    },
    { additionalProperties: false },
  ),
  summarize: (a) =>
    summary(
      a.cluster,
      a.alert && `alert ${a.alert}`,
      a.from !== undefined || a.to !== undefined ? `${a.from ?? ''}-${a.to ?? ''}` : undefined,
      a.sort,
    ),
  async run(args, { api }) {
    if (args.alert && (args.from !== undefined || args.to !== undefined)) {
      throw new ToolError(
        'Pass `alert` or `from`/`to`, not both.',
        'Leave out `from` and `to` to see the window around the alert.',
      );
    }
    if (args.from !== undefined && args.to !== undefined) {
      if (args.from >= args.to) {
        throw new ToolError('`from` must be before `to`.', 'Pass a window of up to 24 hours.');
      }
      if (args.to - args.from > WHAT_CHANGED_MAX_RANGE_S) {
        throw new ToolError(
          'The window is at most 24 hours.',
          'Narrow `from` and `to` to 24 hours or less.',
          { from: at(args.from), to: at(args.to) },
        );
      }
    }
    const cluster = await resolveCluster(api, args.cluster);
    let a: ApiWhatChanged;
    try {
      a = await api.get<ApiWhatChanged>('/what-changed', {
        cluster: cluster.id,
        alert: args.alert,
        from: args.from,
        to: args.to,
        sort: args.sort,
      });
    } catch (err) {
      if (err instanceof ApiReadError && err.status === 403) {
        throw new ToolError(
          PRO_REFUSAL,
          'An Owner or Admin can upgrade in WatchLog under Settings → Plan & billing. The other tools work on Free.',
          { cluster: clusterField(cluster) },
        );
      }
      if (err instanceof ApiReadError && err.status === 400) {
        throw new ToolError(
          'WatchLog refused this window.',
          'Pass `from` before `to`, at most 24 hours apart and not in the future.',
          { apiError: text(err.detail, 200) },
        );
      }
      return notFound(
        err,
        args.alert ? 'No alert with this id in this cluster.' : 'No such cluster.',
        args.alert
          ? 'Pass an alert id from list_alerts for this cluster, or leave out `alert`.'
          : 'Pass a cluster name or id from list_clusters.',
        { cluster: clusterField(cluster), ...(args.alert ? { alert: args.alert } : {}) },
      );
    }
    const counts = a.chart.counts;
    return {
      body: {
        cluster: clusterField(cluster),
        window: { from: a.window.from, to: a.window.to, alert: a.window.alert },
        sort: a.sort,
        learning: {
          learning: a.learning.learning,
          since: a.learning.since,
          until: a.learning.until,
          day: a.learning.day,
          hoursLearned: a.learning.hoursLearned,
          hoursTotal: a.learning.hoursTotal,
          ...(a.learning.series.learning > 0
            ? {
                seriesLearning: a.learning.series.learning,
                seriesReadyAt: a.learning.series.readyAt,
              }
            : {}),
        },
        mostAtOnce: counts.length ? Math.max(...counts) : 0,
        cause: {
          subject: a.cause.subject ? text(a.cause.subject, 600) : null,
          likely: a.cause.likely ? likelyField(a.cause.likely) : null,
        },
      },
      list: {
        key: 'changes',
        items: a.rows.slice(0, MCP_WHAT_CHANGED_ROWS).map(rowOut),
        total: a.total,
        noun: 'changes',
        narrow:
          a.sort === 'furthest'
            ? 'Pass a shorter `from`/`to` window, or `alert` for the window around one alert.'
            : 'Pass `sort: "furthest"` for the furthest out first, a shorter `from`/`to` window, or `alert`.',
      },
    };
  },
});
