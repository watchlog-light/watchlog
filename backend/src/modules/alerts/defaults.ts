// SPDX-License-Identifier: AGPL-3.0-only
// Default rules (SPEC §4.7, ADR-072, ADR-084) and the evaluators of the state rules,
// which read the objects and heartbeats in PostgreSQL. Metric rules are in metric-rules.ts.
import type { Database } from '../../db/index.js';
import {
  crashLooping,
  podIsActive,
  type ContainerStatus,
  type NodeCondition,
  type PodSpec,
  type PodStatus,
} from '../kubernetes/views.js';
import type { EvalContext, RuleEvaluator } from './engine.js';
import { AGENT_SILENT_MS, CLUSTER_FINGERPRINT, clusterReporting } from './holding.js';
import type { Observation, Severity } from './state-machine.js';

export interface Condition {
  op: '>' | '<';
  value: number;
  /** A second threshold that raises the severity to critical. */
  critical?: number;
}

export interface DefaultRule {
  key: string;
  name: string;
  severity: Severity;
  forSeconds: number;
  condition?: Condition;
  /** Catalog key of a metric rule. */
  metric?: string;
  /** Unit of the condition's thresholds (metric rules). */
  unit?: 'ratio' | 'count';
  /** The catalog metric per cluster kind (metric rules; the preview queries it). */
  metrics?: Partial<Record<'kubernetes' | 'docker', string>>;
  evaluator: RuleEvaluator;
}

/** An OOM kill keeps its alert firing this long (ADR-072). */
export const OOM_WINDOW_MS = 10 * 60_000;

interface Row {
  namespace: string;
  name: string;
  node: string;
  spec_summary: unknown;
  status_summary: unknown;
}

function objects(ctx: EvalContext, kind: string): Promise<Row[]> {
  return ctx.memo(`objects:${ctx.cluster.id}:${kind}`, () =>
    loadObjects(ctx.db, ctx.cluster.id, kind),
  );
}

function loadObjects(db: Database, clusterId: string, kind: string): Promise<Row[]> {
  return db
    .selectFrom('objects')
    .select(['namespace', 'name', 'node', 'spec_summary', 'status_summary'])
    .where('cluster_id', '=', clusterId)
    .where('kind', '=', kind)
    .where('deleted_at', 'is', null)
    .execute();
}

const restarts = (n: number) => (n === 1 ? '1 restart' : `${n} restarts`);
const parseTime = (t: string | undefined) => (t ? Date.parse(t) : NaN);

/** A pod condition, found per container; the first match describes the pod. */
export type PodMatch = {
  container: ContainerStatus;
  summary: string;
  since?: number;
  /** What the alert text says (alerts redesign item 6): reason, exit code, limit… */
  facts?: Record<string, unknown>;
} | null;

/**
 * One observation per workload (a pod without one is its own scope, ADR-075): every
 * matching pod of a Deployment adds to the same alert.
 */
function podRule(match: (spec: PodSpec, st: PodStatus, now: number) => PodMatch): RuleEvaluator {
  return {
    kinds: ['kubernetes'],
    async evaluate(ctx) {
      const byScope = new Map<string, Observation & { pods: string[] }>();
      for (const p of await objects(ctx, 'Pod')) {
        const st = p.status_summary as PodStatus;
        const spec = p.spec_summary as PodSpec;
        if (!podIsActive(st) || st.deleting_since) continue;
        const m = match(spec, st, ctx.now);
        if (!m) continue;
        const wl = spec.workload ?? { kind: 'Pod', name: p.name };
        const fp = `pod:${p.namespace}/${wl.kind}/${wl.name}`;
        const existing = byScope.get(fp);
        if (existing) {
          existing.pods.push(p.name);
          if (m.since !== undefined && (existing.since ?? Infinity) > m.since)
            existing.since = m.since;
          continue;
        }
        byScope.set(fp, {
          fingerprint: fp,
          severity: ctx.rule.severity as Severity,
          labels: {
            namespace: p.namespace,
            workload: wl.name,
            workload_kind: wl.kind,
            pod: p.name,
            node: p.node,
          },
          details: { summary: m.summary, container: m.container.name, ...m.facts },
          since: m.since,
          pods: [p.name],
        });
      }
      return [...byScope.values()].map(({ pods, ...o }) => ({
        ...o,
        details: { ...o.details, pods: pods.sort().slice(0, 5), podCount: pods.length },
      }));
    },
  };
}

function matchCrashLoop(_spec: PodSpec, st: PodStatus, now: number): PodMatch {
  const c = (st.containers ?? []).find((c) => !c.init && crashLooping(c, now));
  if (!c) return null;
  const t =
    c.state === 'terminated' && c.reason
      ? { reason: c.reason, exit_code: c.exit_code ?? 0 }
      : c.last_termination;
  return {
    container: c,
    summary: t
      ? `${c.name}: ${t.reason} (exit ${t.exit_code}), ${restarts(c.restart_count)}`
      : `${c.name}: CrashLoopBackOff, ${restarts(c.restart_count)}`,
    facts: { reason: t?.reason ?? null, exitCode: t?.exit_code ?? null, restarts: c.restart_count },
  };
}
const crashLoop = podRule(matchCrashLoop);

const memoryLimit = (spec: PodSpec, container: string) =>
  spec.containers?.find((c) => c.name === container)?.limits?.memory ?? null;

function matchOomKilled(spec: PodSpec, st: PodStatus, now: number): PodMatch {
  for (const c of st.containers ?? []) {
    if (c.init) continue;
    const current = c.state === 'terminated' && c.reason === 'OOMKilled';
    const finished = parseTime(c.last_termination?.finished_at);
    const recent = c.last_termination?.reason === 'OOMKilled' && now - finished < OOM_WINDOW_MS;
    if (current || recent) {
      return {
        container: c,
        summary: `${c.name}: OOMKilled (exit 137), ${restarts(c.restart_count)}`,
        since: recent ? finished : undefined,
        facts: {
          restarts: c.restart_count,
          killedAt: recent ? new Date(finished).toISOString() : null,
          limit: memoryLimit(spec, c.name),
        },
      };
    }
  }
  return null;
}
const oomKilled = podRule(matchOomKilled);

function matchPending(spec: PodSpec, st: PodStatus): PodMatch {
  if (st.phase !== 'Pending') return null;
  const created = parseTime(spec.created_at ?? st.started_at);
  const c = st.containers?.[0] ?? ({ name: '' } as ContainerStatus);
  return {
    container: c,
    summary: st.reason || st.message || 'Pending',
    since: Number.isNaN(created) ? undefined : created,
    facts: { reason: st.reason ?? null, message: st.message ?? null },
  };
}
const pending = podRule(matchPending);

function matchImagePull(spec: PodSpec, st: PodStatus): PodMatch {
  const c = (st.containers ?? []).find(
    (c) =>
      c.state === 'waiting' && (c.reason === 'ImagePullBackOff' || c.reason === 'ErrImagePull'),
  );
  if (!c) return null;
  const image = spec.containers?.find((x) => x.name === c.name)?.image ?? null;
  return { container: c, summary: `${c.name}: ${c.reason}`, facts: { reason: c.reason, image } };
}
const imagePull = podRule(matchImagePull);

/**
 * The pod rules' matchers by rule key, the most specific first (an OOM kill names a
 * crash loop). The Workloads page words its reason lines with them and the alert texts.
 */
export const POD_MATCHERS: [string, (spec: PodSpec, st: PodStatus, now: number) => PodMatch][] = [
  ['k8s.container.oomkilled', matchOomKilled],
  ['k8s.pod.crashloop', matchCrashLoop],
  ['k8s.pod.imagepull', matchImagePull],
  ['k8s.pod.pending', matchPending],
];

function nodeConditions(
  pick: (c: NodeCondition) => boolean,
  scope: (node: string, c: NodeCondition) => string,
): RuleEvaluator {
  return {
    kinds: ['kubernetes'],
    async evaluate(ctx) {
      const out: Observation[] = [];
      for (const n of await objects(ctx, 'Node')) {
        const conds = (
          (n.status_summary as { conditions?: NodeCondition[] }).conditions ?? []
        ).filter(pick);
        for (const c of conds) {
          const since = parseTime(c.since);
          out.push({
            fingerprint: scope(n.name, c),
            severity: ctx.rule.severity as Severity,
            labels: { node: n.name, condition: c.type },
            details: {
              summary: `${c.type} ${c.status}${c.reason ? ` (${c.reason})` : ''}`,
              status: c.status,
              reason: c.reason ?? null,
              message: c.message ?? '',
            },
            since: Number.isNaN(since) ? undefined : since,
          });
        }
      }
      return out;
    },
  };
}

const nodeNotReady = nodeConditions(
  (c) => c.type === 'Ready' && c.status !== 'True',
  (node) => `node:${node}`,
);
const nodePressure = nodeConditions(
  (c) => (c.type === 'MemoryPressure' || c.type === 'DiskPressure') && c.status === 'True',
  (node, c) => `node:${node}:${c.type}`,
);

const deploymentUnavailable: RuleEvaluator = {
  kinds: ['kubernetes'],
  async evaluate(ctx) {
    const out: Observation[] = [];
    for (const d of await objects(ctx, 'Deployment')) {
      const desired = (d.spec_summary as { replicas?: number }).replicas ?? 0;
      const ready = (d.status_summary as { ready?: number }).ready ?? 0;
      if (desired <= 0 || ready >= desired) continue;
      out.push({
        fingerprint: `deploy:${d.namespace}/${d.name}`,
        severity: ctx.rule.severity as Severity,
        labels: { namespace: d.namespace, workload: d.name, workload_kind: 'Deployment' },
        details: { summary: `${ready}/${desired} replicas ready`, ready, desired },
      });
    }
    return out;
  },
};

const dockerUnhealthy: RuleEvaluator = {
  kinds: ['docker'],
  async evaluate(ctx) {
    const out: Observation[] = [];
    for (const c of await objects(ctx, 'DockerContainer')) {
      const st = c.status_summary as {
        state?: string;
        health?: string;
        status?: string;
        health_detail?: { failing_streak?: number; probes?: { output?: string }[] };
      };
      if (st.health !== 'unhealthy' || st.state !== 'running') continue;
      const probes = st.health_detail?.probes ?? [];
      const output = probes.at(-1)?.output?.trim().split('\n')[0]?.slice(0, 120) ?? null;
      const project = c.spec_summary as { compose_project?: string; compose_service?: string };
      out.push({
        fingerprint: `docker:${c.node}/${c.name}`,
        severity: ctx.rule.severity as Severity,
        labels: { node: c.node, container: c.name },
        details: {
          summary: st.status ?? 'unhealthy',
          streak: st.health_detail?.failing_streak ?? null,
          output,
          compose: project.compose_project
            ? `${project.compose_project}/${project.compose_service ?? c.name}`
            : null,
        },
      });
    }
    return out;
  },
};

const agentNotReporting: RuleEvaluator = {
  kinds: ['kubernetes', 'docker'],
  async evaluate(ctx) {
    const r = await clusterReporting(ctx);
    const severity = ctx.rule.severity as Severity;
    // Every agent silent: one alert for the cluster, not one per agent (ADR-094).
    if (r.allSilent) {
      return [
        {
          fingerprint: CLUSTER_FINGERPRINT,
          severity,
          labels: { agent: 'all' },
          details: {
            agents: r.agents,
            lastSeen: r.lastSeen === null ? null : new Date(r.lastSeen).toISOString(),
          },
          since: (r.lastSeen ?? ctx.now) + AGENT_SILENT_MS,
        },
      ];
    }
    return r.silent.map((a) => ({
      fingerprint: `agent:${a.mode}:${a.node}`,
      severity,
      labels: { node: a.node, agent: a.mode },
      details: { lastSeen: new Date(a.lastSeen).toISOString() },
      since: a.lastSeen + AGENT_SILENT_MS,
    }));
  },
};

/** The state rules; metric rules are added by metric-rules.ts. */
export const STATE_RULES: DefaultRule[] = [
  {
    key: 'k8s.pod.crashloop',
    name: 'Pod CrashLoopBackOff',
    severity: 'critical',
    forSeconds: 120,
    evaluator: crashLoop,
  },
  {
    key: 'k8s.container.oomkilled',
    name: 'Container OOMKilled',
    severity: 'warning',
    forSeconds: 0,
    evaluator: oomKilled,
  },
  {
    key: 'k8s.pod.pending',
    name: 'Pod pending too long',
    severity: 'warning',
    forSeconds: 300,
    evaluator: pending,
  },
  {
    key: 'k8s.pod.imagepull',
    name: 'ImagePullBackOff',
    severity: 'warning',
    forSeconds: 120,
    evaluator: imagePull,
  },
  {
    key: 'k8s.node.notready',
    name: 'Node NotReady',
    severity: 'critical',
    forSeconds: 60,
    evaluator: nodeNotReady,
  },
  {
    key: 'k8s.node.pressure',
    name: 'Node memory or disk pressure',
    severity: 'critical',
    forSeconds: 0,
    evaluator: nodePressure,
  },
  {
    key: 'k8s.deployment.unavailable',
    name: 'Deployment replicas unavailable',
    severity: 'critical',
    forSeconds: 300,
    evaluator: deploymentUnavailable,
  },
  {
    key: 'docker.container.unhealthy',
    name: 'Docker container unhealthy',
    severity: 'warning',
    forSeconds: 0,
    evaluator: dockerUnhealthy,
  },
  {
    key: 'agent.not_reporting',
    name: 'Agent not reporting',
    severity: 'critical',
    forSeconds: 0,
    evaluator: agentNotReporting,
  },
];
