// SPDX-License-Identifier: AGPL-3.0-only
// Probable cause for an alert on a server's service or process group (ADR-213): the server
// workload page computes the cause from the workload's own series (servers/cause.ts); this
// reads it through the API, as the engine reads everything (ADR-148), and words it with the
// codes the other rules use (bad_change, oom_limit, dependency_down, cpu_throttled), so the
// panel, Needs attention and the notifications say it the same way.
import type { CausesAnswer } from './engine.js';
import type { EvAlert, Reader } from './evidence.js';
import type { ClusterRef, Target } from './resolve.js';
import type { Cause, Check, ObjectRef, Sentence, Step } from './types.js';

interface WorkloadAnswer {
  workload: {
    id: string;
    source: 'service' | 'process' | 'container';
    name: string;
    memoryLimitBytes: number | null;
  };
  connections: { to: string; port: number | null; rate: number; failed: number }[];
  cause: {
    state: 'likely' | 'possible' | 'none';
    code: 'release' | 'memory_limit' | 'oom' | 'dependency' | 'cpu_limit' | null;
    since: number | null;
    symptom: Record<string, string | number | null>;
    facts: Record<string, string | number | null>;
    checks: {
      topic: 'changes' | 'memory' | 'dependencies' | 'cpu';
      result: 'explains' | 'possible' | 'ok' | 'not_run';
      facts: Record<string, string | number | null>;
    }[];
  };
}

/** The service or process group an alert of a server rule is about, or null. */
export function serverWorkloadOf(alert: EvAlert | null): { node: string; id: string } | null {
  if (!alert?.rule.key?.startsWith('server.')) return null;
  const l = alert.labels;
  if (!l.node) return null;
  if (l.group) return { node: l.node, id: `process:${l.group}` };
  if (l.unit) return { node: l.node, id: `service:${l.unit}` };
  return null;
}

const iso = (unix: number | null | undefined) =>
  unix ? new Date(unix * 1000).toISOString() : null;

const CHANGE_WINDOW_MIN = 30;

export async function serverAnswer(
  reader: Reader,
  cluster: ClusterRef,
  target: Target,
  at: { node: string; id: string },
  now: number,
): Promise<CausesAnswer> {
  const d = await reader.get<WorkloadAnswer>(
    `/clusters/${cluster.id}/servers/${encodeURIComponent(at.node)}/workloads/${encodeURIComponent(at.id)}`,
  );
  const w = d.workload;
  const c = d.cause;
  const name = w.name;
  const object: ObjectRef = {
    kind: 'host',
    ref: at.node,
    name,
    platform: 'server',
    host: at.node,
  };
  const exitCode = typeof c.symptom.exitCode === 'number' ? c.symptom.exitCode : null;
  const n = Math.round(Number(c.symptom.restarts) || Number(c.symptom.failedExits) || 0);
  const since = iso(c.since);
  const symptomStep = (next: Step['next']): Step => ({
    object,
    source: 'metrics',
    code: exitCode !== null ? 'exit_code_docker' : 'restarts',
    facts: exitCode !== null ? { exitCode } : { n },
    at: null,
    since,
    next,
  });

  const causes: Cause[] = [];
  let headline: Sentence;
  const checked = c.checks.length + 1;
  // 0.10 (ADR-225): a service a systemd timer starts, whose last run failed: the job is why.
  const job =
    w.source === 'service' ? await failedTimerOf(reader, cluster.id, at.node, name) : null;
  switch (c.code) {
    case 'release':
      headline =
        exitCode !== null
          ? { code: 'bad_change_crash', facts: { name, exitCode } }
          : { code: 'bad_change', facts: { name } };
      causes.push({
        rule: 'bad_change',
        code: 'bad_change',
        facts: {},
        strength: c.state === 'none' ? 'possible' : c.state,
        since: iso(Number(c.facts.releaseAt)),
        chain: [
          symptomStep('after'),
          {
            object: {
              kind: 'change',
              ref: `${w.source === 'service' ? 'Service' : 'ProcessGroup'}/${at.node}/${name}`,
              name,
              platform: 'server',
              host: at.node,
            },
            source: 'metrics',
            code: 'executable_changed',
            facts: {},
            at: iso(Number(c.facts.releaseAt)),
            since: null,
            next: null,
          },
        ],
      });
      break;
    case 'memory_limit':
    case 'oom': {
      const kills = Math.max(1, Math.round(Number(c.facts.oomKills) || 0));
      const limit = w.memoryLimitBytes;
      headline =
        c.code === 'memory_limit' && limit
          ? { code: 'oom_limit', facts: { name, limitBytes: limit, n: kills } }
          : { code: 'server_oom', facts: { name, n: kills } };
      causes.push({
        rule: 'oom_limit',
        code: limit ? 'oom_limit' : 'server_oom',
        facts: limit ? { limitBytes: limit } : {},
        strength: c.state === 'none' ? 'possible' : c.state,
        since,
        chain: [
          {
            object,
            source: 'metrics',
            code: limit ? 'oom_killed_kills' : 'host_ran_out',
            facts: limit ? { n: kills, limitBytes: limit } : { host: at.node },
            at: null,
            since,
            next: null,
          },
        ],
      });
      break;
    }
    case 'dependency': {
      const conn = d.connections.find((x) => x.to === c.facts.to) ?? d.connections[0];
      const pct = conn && conn.rate > 0 ? Math.round((conn.failed / conn.rate) * 100) : 100;
      headline = { code: 'possible', facts: { name, n: 1 } };
      causes.push({
        rule: 'dependency_down',
        code: 'dependency_down',
        facts: { target: String(c.facts.to ?? '') },
        strength: 'possible',
        since,
        chain: [
          {
            object,
            source: 'service_map',
            code: 'edge_failed',
            facts: { pct: Math.min(100, pct) },
            at: null,
            since,
            next: null,
          },
        ],
      });
      break;
    }
    case 'cpu_limit':
      headline = { code: 'possible', facts: { name, n: 1 } };
      causes.push({
        rule: 'cpu_throttled',
        code: 'cpu_throttled',
        facts: { pct: Number(c.facts.share) || 0 },
        strength: 'possible',
        since,
        chain: [
          {
            object,
            source: 'metrics',
            code: 'cpu_throttled_share',
            facts: { container: name, pct: Number(c.facts.share) || 0 },
            at: null,
            since,
            next: null,
          },
        ],
      });
      break;
    default:
      headline = job
        ? job.exitCode !== null
          ? {
              code: 'scheduled_job_failed_exit',
              facts: { name, job: job.name, exitCode: job.exitCode },
            }
          : { code: 'scheduled_job_failed', facts: { name, job: job.name } }
        : {
            code: 'none_found',
            facts: {
              name,
              n: checked,
              found: c.checks.filter((x) => x.result === 'possible').length,
            },
          };
  }
  if (job) {
    causes.push({
      rule: 'job_failed',
      code: 'scheduled_job_failed',
      facts: { job: job.name, n: job.streak },
      strength: c.code ? 'possible' : 'likely',
      since: job.at,
      chain: [
        {
          object,
          source: 'metrics',
          code: job.exitCode !== null ? 'scheduled_run_failed_exit' : 'scheduled_run_failed',
          facts: { job: job.name, exitCode: job.exitCode, n: job.streak },
          at: job.at,
          since: null,
          next: null,
        },
      ],
    });
  }

  const checks: Check[] = [];
  const memory = c.checks.find((x) => x.topic === 'memory');
  checks.push({
    topic: 'self',
    result: memory?.result === 'explains' ? 'explains' : 'ok',
    code:
      memory?.result === 'explains'
        ? 'self_oom_killed'
        : n > 0
          ? exitCode !== null
            ? 'self_restarts_code'
            : 'self_restarts'
          : 'self_ok',
    facts: { name, n, exitCode },
    object,
  });
  for (const x of c.checks) {
    if (x.topic === 'memory') continue;
    if (x.topic === 'changes') {
      checks.push({
        topic: 'changes',
        result: x.result === 'explains' ? 'explains' : 'ok',
        code: x.result === 'explains' ? 'changes_own' : 'changes_none',
        facts: { name, n: 1, minutes: CHANGE_WINDOW_MIN },
      });
    } else if (x.topic === 'dependencies') {
      checks.push({
        topic: 'dependencies',
        result: x.result === 'not_run' ? 'not_run' : x.result === 'possible' ? 'possible' : 'ok',
        code:
          x.result === 'not_run'
            ? 'dependencies_none'
            : x.result === 'possible'
              ? 'dependencies_failing'
              : 'dependencies_ok',
        facts: {
          name,
          n: x.result === 'possible' ? 1 : d.connections.length,
          target: x.facts.to ?? null,
        },
      });
    } else if (x.topic === 'cpu') {
      checks.push({
        topic: 'cpu',
        result: x.result === 'possible' ? 'possible' : 'ok',
        code: x.result === 'possible' ? 'cpu_throttled' : 'cpu_ok',
        facts: { name, pct: x.facts.share ?? null },
      });
    }
  }

  const symptomAt = target.symptomAt ?? since;
  const end = target.resolvedAt ? Date.parse(target.resolvedAt) : now;
  const anchor = symptomAt ? Math.min(Date.parse(symptomAt), end) : end;
  return {
    subject: target.self,
    object,
    cluster,
    state: c.code ? (c.state === 'none' ? 'possible' : c.state) : job ? 'likely' : 'none',
    checkedAt: new Date(now).toISOString(),
    symptomSince: symptomAt,
    resolvedAt: target.resolvedAt,
    window: {
      from: new Date(anchor - 60 * 60_000).toISOString(),
      to: new Date(Math.max(end, anchor)).toISOString(),
    },
    headline,
    causes,
    checks,
    flowsOff: null,
  };
}

interface JobsAnswer {
  jobs: {
    kind: string;
    name: string;
    unit: string;
    state: string;
    failedStreak: number;
    lastRun: { startedAt: number; code: number | null; result: string } | null;
  }[];
}

/** The systemd timer that starts this service, when its last run failed (soft: none). */
async function failedTimerOf(
  reader: Reader,
  clusterId: string,
  node: string,
  unit: string,
): Promise<{ name: string; exitCode: number | null; streak: number; at: string | null } | null> {
  let d: JobsAnswer;
  try {
    d = await reader.get<JobsAnswer>(`/clusters/${clusterId}/scheduled-jobs`, { node });
  } catch {
    return null;
  }
  const j = d.jobs.find((x) => x.kind === 'timer' && x.unit === unit && x.state === 'failed');
  if (!j) return null;
  return {
    name: j.name,
    exitCode: j.lastRun?.result === 'failed' ? j.lastRun.code : null,
    streak: Math.max(1, j.failedStreak),
    at: iso(j.lastRun?.startedAt ?? null),
  };
}
