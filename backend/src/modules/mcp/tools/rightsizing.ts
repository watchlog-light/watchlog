// SPDX-License-Identifier: AGPL-3.0-only
// get_right_sizing (ADR-168): CPU and memory requests and limits against the last 7 days of
// use, read through GET /clusters/:id/right-sizing. Codes and facts as the API gives them
// (ADR-147), no score; the description says what each code means.
import { Type } from 'typebox';
import { clusterField, resolveCluster } from '../clusters.js';
import { MAX_OUTPUT_BYTES, name, ToolError } from '../output.js';
import { ClusterArg, defineTool, describe, NamespaceArg, summary } from './common.js';

interface Hint {
  object: Record<string, string>;
  container: string | null;
  resource: 'cpu' | 'memory';
  code: string;
  facts: Record<string, string | number | boolean | null>;
  suggestion: number | null;
  giveBack: number;
  basedOn: { windowHours: number; from: string | null; to: string; hours: number };
}
interface Answer {
  window: { hours: number; minHistoryHours: number };
  computedAt: string;
  hints: Hint[];
  notEnoughHistory: { object: Record<string, string>; container: string | null; hours: number }[];
  summary: Record<string, unknown>;
}

export const MCP_MAX_HINTS = 40;

const CODES = [
  'memory_limit_oom: OOM-killed at its memory limit in the window (facts limitBytes, peakBytes, oomKills, lastOomAt); suggestion = a limit with room',
  'memory_limit_tight: its highest working set reached 90 % of the memory limit or more',
  'cpu_limit_throttled: throttled at its CPU limit at least 10 % of the time at p95 (throttledShare 0–1); raise or remove the limit',
  'memory_request_low / cpu_request_low: p95 of use above the request; under node memory pressure such a pod is evicted first, and the scheduler places it as if it needed less',
  'cpu_request_high / memory_request_high: the request is at least twice the use (CPU p95, memory peak) with 100m / 128 MiB or more to spare; giveBack counts all replicas',
  'memory_reservation_low / memory_reservation_high: the same for a Docker memory reservation',
  'cpu_no_request / memory_no_request / memory_no_limit: not set; the facts say what it used',
].join('; ');

export const getRightSizingTool = defineTool({
  name: 'get_right_sizing',
  title: 'Right-sizing hints',
  description: describe(
    'CPU and memory requests and limits compared with the last 7 days of real use, at 5-minute resolution: what asks for far more than it uses, what uses more than it asks for, and what is held back or at risk at its limit. Kubernetes: per workload container (Deployments, StatefulSets, DaemonSets; its busiest pod counts). Docker: per container (limits reserve nothing there, so only OOM risk, throttling, memory reservations and a missing limit on a container using over a quarter of its host).',
    `Codes (facts in cores and bytes): ${CODES}. Each hint has \`suggestion\` (cores for cpu, bytes for memory: CPU p95 × 1.25 rounded up to 10m, memory peak × 1.25 to 16 MiB) and \`basedOn\` (the window and the hours of history it had). Containers with less than 24 hours of history are listed apart. No scores: these are hints, not alerts. At most ${MCP_MAX_HINTS} hints, OOM risk first.`,
    'Example question: "Which workloads in shop ask for more CPU than they use?"',
  ),
  input: Type.Object(
    {
      cluster: ClusterArg,
      namespace: NamespaceArg('Kubernetes: only this namespace.'),
      workload: Type.Optional(
        Type.String({ minLength: 1, maxLength: 253, description: 'Kubernetes: one workload.' }),
      ),
      host: Type.Optional(
        Type.String({ minLength: 1, maxLength: 253, description: 'Docker: one host.' }),
      ),
      container: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 253,
          description: 'Docker: one container; Kubernetes: one container in the pods.',
        }),
      ),
      composeService: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 253,
          description: 'Docker: one Compose service, as <project>/<service>.',
        }),
      ),
    },
    { additionalProperties: false },
  ),
  summarize: (a) =>
    summary(a.cluster, a.namespace ?? a.host, a.workload ?? a.composeService, a.container),
  async run(args, { api }) {
    const cluster = await resolveCluster(api, args.cluster);
    const kube = cluster.kind === 'kubernetes';
    if (kube && (args.host || args.composeService)) {
      throw new ToolError(
        'This cluster is Kubernetes: filter by `namespace`, `workload` or `container`.',
        'Leave out `host` and `composeService`; they are Docker notions.',
        { cluster: clusterField(cluster) },
      );
    }
    if (!kube && (args.namespace || args.workload)) {
      throw new ToolError(
        'This cluster is a Docker fleet: filter by `host`, `container` or `composeService`.',
        'Leave out `namespace` and `workload`; they are Kubernetes notions.',
        { cluster: clusterField(cluster) },
      );
    }
    const [project, service] = args.composeService?.split('/', 2) ?? [];
    const a = await api.get<Answer>(`/clusters/${cluster.id}/right-sizing`, {
      namespace: args.namespace,
      workload: args.workload,
      host: args.host,
      container: args.container,
      project: service ? project : undefined,
      service: service ?? project,
    });
    const clean = (o: Record<string, string>) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'kind' ? v : name(v)]));
    const hints = a.hints.slice(0, MCP_MAX_HINTS).map((h) => ({
      object: clean(h.object),
      ...(h.container ? { container: name(h.container) } : {}),
      resource: h.resource,
      code: h.code,
      facts: Object.fromEntries(
        Object.entries(h.facts).map(([k, v]) => [k, typeof v === 'string' ? name(v) : v]),
      ),
      suggestion: h.suggestion,
      ...(h.giveBack ? { giveBack: h.giveBack } : {}),
      historyHours: h.basedOn.hours,
    }));
    const body = {
      cluster: clusterField(cluster),
      windowHours: a.window.hours,
      computedAt: a.computedAt,
      summary: a.summary,
      hints,
      ...(a.hints.length > hints.length ? { moreHints: a.hints.length - hints.length } : {}),
      notEnoughHistory: a.notEnoughHistory.slice(0, 20).map((n) => ({
        object: clean(n.object),
        ...(n.container ? { container: name(n.container) } : {}),
        hours: n.hours,
        needed: a.window.minHistoryHours,
      })),
    };
    // Keep within the tool's answer size: drop hints from the end.
    while (
      Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_OUTPUT_BYTES &&
      body.hints.length
    ) {
      body.hints.pop();
      (body as Record<string, unknown>).moreHints = a.hints.length - body.hints.length;
    }
    return { body };
  },
});
