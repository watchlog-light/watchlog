// SPDX-License-Identifier: AGPL-3.0-only
// What is wrong with a Docker fleet's containers (Docker parity of the overview's
// problems, ADR-110): unhealthy, restarting, OOM-killed, or exited with a non-zero code
// in the last day. Worded by the alert texts; skipped when an alert (firing or
// silenced) already names the container.
import { alertText } from '../alerts/text.js';
import type { StoppedWithHost } from '../docker/host-restart.js';
import type { FiringAlert, Problem } from './problems.js';
import { problemType } from './problems.js';

export interface DockerContainerRow {
  node: string;
  name: string;
  spec_summary: unknown;
  status_summary: unknown;
}

interface Status {
  state?: string;
  health?: string;
  restart_count?: number;
  exit_code?: number;
  oom_killed?: boolean;
  restarting?: boolean;
  finished_at?: string;
  started_at?: string;
  error?: string;
  health_since?: string;
  health_detail?: { failing_streak?: number; probes?: { output?: string }[] };
}

/** A container problem's short name, for heatmap cells and status pills. */
export const FAILING: Record<string, string> = {
  'docker.container.oom': 'OOMKilled',
  'docker.container.restarting': 'Restarting',
  'docker.container.unhealthy': 'Unhealthy',
  'docker.container.exited': 'Exited',
};

/** Exited containers count for this long after they stopped. */
export const EXITED_RECENT_MS = 24 * 3600_000;
/**
 * A crash loop whose process runs a while before it exits is mostly `running` when sampled
 * (v0.4 slice 0, gap 7): it counts as restarting while its restart policy started it again
 * this recently, right after it ended, with this many restarts.
 */
export const LOOP_RECENT_MS = 5 * 60_000;
export const LOOP_GAP_MS = 2 * 60_000;
export const LOOP_MIN_RESTARTS = 3;

export interface DockerProblem {
  ruleKey: string;
  severity: 'critical' | 'warning';
  details: Record<string, unknown>;
  since: string | null;
}

/**
 * The problem of one container, else null. A container stopped by its host's reboot or its
 * daemon's restart (`withHost`) and still stopped is no problem: Docker's restart policy
 * left it stopped (ADR-159).
 */
export function dockerProblem(
  st: Status,
  now: number,
  memoryLimit?: string | null,
  withHost?: StoppedWithHost | null,
): DockerProblem | null {
  const restarts = st.restart_count ?? 0;
  const finished = Date.parse(st.finished_at ?? '');
  const recent = now - finished < EXITED_RECENT_MS;
  // Docker keeps OOMKilled set on a running container after one of its processes was
  // killed (measured on kind's node containers): only a container that stopped (or keeps
  // restarting) recently was killed itself.
  if (st.oom_killed && (st.state === 'restarting' || (st.state !== 'running' && recent)))
    return {
      ruleKey: 'docker.container.oom',
      severity: 'critical',
      details: { limit: memoryLimit ?? null, restarts },
      since: st.finished_at ?? null,
    };
  if (st.state === 'restarting' || st.restarting)
    return {
      ruleKey: 'docker.container.restarting',
      severity: 'critical',
      details: { exitCode: st.exit_code ?? null, restarts },
      since: st.finished_at ?? null,
    };
  // Running again, but its policy restarted it moments after it ended, again and again. Its
  // exit code is gone while it runs (Docker resets it).
  const started = Date.parse(st.started_at ?? '');
  if (
    st.state === 'running' &&
    restarts >= LOOP_MIN_RESTARTS &&
    now - started < LOOP_RECENT_MS &&
    started >= finished &&
    started - finished < LOOP_GAP_MS
  )
    return {
      ruleKey: 'docker.container.restarting',
      severity: 'critical',
      details: { exitCode: null, restarts },
      since: st.finished_at ?? null,
    };
  if (st.health === 'unhealthy') {
    const probes = st.health_detail?.probes ?? [];
    return {
      ruleKey: 'docker.container.unhealthy',
      severity: 'warning',
      details: {
        streak: st.health_detail?.failing_streak ?? null,
        output: probes.at(-1)?.output ?? null,
      },
      since: st.health_since ?? null,
    };
  }
  if (
    (st.state === 'exited' || st.state === 'dead') &&
    (st.exit_code ?? 0) !== 0 &&
    recent &&
    !withHost
  )
    return {
      ruleKey: 'docker.container.exited',
      severity: 'warning',
      details: { exitCode: st.exit_code, finishedAt: st.finished_at, error: st.error ?? null },
      since: st.finished_at ?? null,
    };
  return null;
}

/**
 * The fleet's container problems no alert covers, as overview problems. Containers on
 * hosts that stopped reporting are left out: their state is stale, and the host's own
 * "not reporting" alert says so.
 */
export function dockerProblems(
  containers: DockerContainerRow[],
  alerts: FiringAlert[],
  clusterName: string,
  now: number,
  memoryLimit: (host: string, name: string) => string | null = () => null,
  liveHosts?: Set<string>,
  withHost: Map<string, StoppedWithHost> = new Map(),
): Problem[] {
  const out: Problem[] = [];
  for (const c of containers) {
    if (liveHosts && !liveHosts.has(c.node)) continue;
    const p = dockerProblem(
      c.status_summary as Status,
      now,
      memoryLimit(c.node, c.name),
      withHost.get(`${c.node}\u0000${c.name}`),
    );
    if (!p) continue;
    if (
      alerts.some(
        (a) => a.labels.container === c.name && (a.labels.node ?? a.labels.host) === c.node,
      )
    )
      continue;
    const labels = { container: c.name, node: c.node };
    const text = alertText({
      ruleKey: p.ruleKey,
      ruleName: p.ruleKey,
      labels,
      details: p.details,
      cluster: { name: clusterName },
      now,
    });
    out.push({
      id: `object:Container:${c.node}/${c.name}`,
      source: 'object',
      severity: p.severity,
      type: problemType(p.ruleKey),
      title: text.title,
      why: [c.node, text.why].filter(Boolean).join(' · ') || null,
      since: p.since,
      alertId: null,
      object: { kind: 'Container', namespace: c.node, name: c.name },
      related: 0,
    });
  }
  return out;
}
