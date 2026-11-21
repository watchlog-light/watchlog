// SPDX-License-Identifier: AGPL-3.0-only
// get_all_clusters (ADR-226): "is anything wrong anywhere?" in one call. The same summary as
// the All clusters and fleets page (GET /overview/all), without the sparklines. Pro: Cloud
// and the live demo register it; Community doesn't (as get_what_changed, ADR-202).
import { Type } from 'typebox';
import { ApiReadError } from '../reader.js';
import { name, text, ToolError } from '../output.js';
import { likelyField, type ApiLikelyCause } from './causes.js';
import { defineTool, describe, round, summary } from './common.js';

/** Problems the tool returns at most. */
export const MCP_ALL_PROBLEMS = 30;

export const ALL_CLUSTERS_REFUSAL =
  'All clusters and fleets is part of WatchLog Pro; this organization is on Free.';

interface Ref {
  id: string;
  name: string;
  kind: 'kubernetes' | 'server';
}
interface ApiAll {
  range: number;
  counts: { all: number; kubernetes: number; server: number };
  hosts: { nodes: number; servers: number; notReporting: number };
  clusters: (Ref & {
    status: string;
    version: string | null;
    hosts: number;
    reporting: { live: number; total: number };
    cpu: { now: number | null };
    memory: number | null;
    problems: { critical: number; warning: number };
    whatChanged: number | null;
    alerts: number;
  })[];
  problems: {
    severity: string;
    title: string;
    why: string | null;
    since: string | null;
    alertId: string | null;
    likelyCause?: ApiLikelyCause;
    places: { cluster: Ref; alertId: string | null }[];
  }[];
  whatChanged: { total: number; learning: Ref[] };
  housekeeping: {
    latestVersion: string;
    oldAgents: { cluster: Ref; count: number; versions: string[] }[];
    failingChannels: { name: string; type: string; since: string }[];
    noChannel: Ref[];
    ebpfOff: { cluster: Ref; count: number }[];
  };
}

const ref = (r: Ref) => ({ id: r.id, name: name(r.name), kind: r.kind });

/** The page's status sentence, in words an assistant can repeat. */
export function statusSentence(a: Pick<ApiAll, 'counts' | 'clusters'>): string {
  const bad = a.clusters.filter((c) => c.status === 'critical' || c.status === 'warning');
  const n = a.counts.all;
  if (n === 0) return 'This organization has no Kubernetes cluster or Server fleet yet.';
  if (bad.length === 0)
    return n === 1
      ? 'The one cluster or fleet is healthy.'
      : `All ${n} clusters and fleets are healthy.`;
  return bad.length === 1
    ? `1 of ${n} clusters and fleets needs attention: ${bad[0]!.name}.`
    : `${bad.length} of ${n} clusters and fleets need attention: ${bad.map((c) => c.name).join(', ')}.`;
}

export const getAllClustersTool = defineTool({
  name: 'get_all_clusters',
  title: 'All clusters and fleets',
  description: describe(
    'Every Kubernetes cluster and Server fleet of the organization at once: use it first for "is anything wrong anywhere?", "which cluster needs attention?" or "what is broken across prod and staging?". Returns `status` (one sentence), the counts, `problems` (every open problem, critical first, then the most recent: severity, title, why, since, the likely cause when known, and `places`, the clusters and fleets it is open in; the same alert rule on the same workload name in several places, started within 30 minutes of each other, is one problem with several places), `clusters` (one row each: status critical, warning, healthy or waiting for its first agent; agents reporting of total; CPU now and memory as ratios; open problems; What changed in the last 24 hours, null while learning; alerts sent in the range) and `housekeeping` (agents older than the server, failing alert channels, clusters with no channel, eBPF off).',
    `\`kind\`: all (default), kubernetes or server. \`range\`: 1h, 6h, 24h (default), 7d or 30d, for CPU and alerts. At most ${MCP_ALL_PROBLEMS} problems; \`truncated\` says when cut. For one problem's evidence use explain_problem or explain_alert with its place's cluster; for one cluster, get_problems. Part of WatchLog Pro: on Free the tool says so.`,
    'Example question: "Is anything wrong in any of our clusters?"',
  ),
  input: Type.Object(
    {
      kind: Type.Optional(
        Type.Union([Type.Literal('all'), Type.Literal('kubernetes'), Type.Literal('server')], {
          description: 'Which kind to show (default all).',
        }),
      ),
      range: Type.Optional(
        Type.Union(
          [
            Type.Literal('1h'),
            Type.Literal('6h'),
            Type.Literal('24h'),
            Type.Literal('7d'),
            Type.Literal('30d'),
          ],
          { description: 'The range for CPU and alerts sent (default 24h).' },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  summarize: (a) => summary(a.kind, a.range),
  async run(args, { api }) {
    const seconds = { '1h': 3600, '6h': 21_600, '24h': 86_400, '7d': 604_800, '30d': 2_592_000 }[
      args.range ?? '24h'
    ];
    let a: ApiAll;
    try {
      a = await api.get<ApiAll>('/overview/all', { range: seconds, kind: args.kind ?? 'all' });
    } catch (err) {
      if (err instanceof ApiReadError && err.status === 403) {
        throw new ToolError(
          ALL_CLUSTERS_REFUSAL,
          'An Owner or Admin can upgrade in WatchLog under Settings → Plan & billing. list_clusters and get_problems work on Free.',
        );
      }
      if (err instanceof ApiReadError && err.status === 400) {
        throw new ToolError(
          "That range is beyond this organization's retention.",
          'Pass a shorter `range`, such as 24h.',
          { apiError: text(err.detail, 200) },
        );
      }
      throw err;
    }
    const problems = a.problems.slice(0, MCP_ALL_PROBLEMS);
    return {
      body: {
        status: statusSentence(a),
        counts: {
          clusters: a.counts.kubernetes,
          fleets: a.counts.server,
          nodes: a.hosts.nodes,
          servers: a.hosts.servers,
          notReporting: a.hosts.notReporting,
        },
        problems: problems.map((p) => ({
          severity: p.severity,
          title: text(p.title, 300),
          why: text(p.why, 512),
          since: p.since,
          ...(p.likelyCause ? { likelyCause: likelyField(p.likelyCause) } : {}),
          places: p.places.map((pl) => ({ cluster: ref(pl.cluster), alertId: pl.alertId })),
        })),
        clusters: a.clusters.map((c) => ({
          ...ref(c),
          status: c.status,
          ...(c.version ? { kubernetes: c.version } : {}),
          reporting: `${c.reporting.live}/${c.reporting.total}`,
          cpu: round(c.cpu.now),
          memory: round(c.memory),
          problems: c.problems,
          whatChanged: c.whatChanged,
          alerts: c.alerts,
        })),
        learning: a.whatChanged.learning.map(ref),
        housekeeping: {
          latestAgent: a.housekeeping.latestVersion,
          oldAgents: a.housekeeping.oldAgents.map((o) => ({
            cluster: ref(o.cluster),
            count: o.count,
            versions: o.versions,
          })),
          failingChannels: a.housekeeping.failingChannels.map((ch) => ({
            name: name(ch.name),
            type: ch.type,
            since: ch.since,
          })),
          noChannel: a.housekeeping.noChannel.map(ref),
          ebpfOff: a.housekeeping.ebpfOff.map((o) => ({ cluster: ref(o.cluster), count: o.count })),
        },
        ...(a.problems.length > problems.length
          ? {
              truncated: true,
              hint: `${a.problems.length - problems.length} more problems: pass kind, or use get_problems per cluster.`,
            }
          : {}),
      },
    };
  },
});
