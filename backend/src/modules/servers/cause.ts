// SPDX-License-Identifier: AGPL-3.0-only
// Probable cause for a server's service or process group (ADR-208, ADR-213): why it is
// crash-looping, failed or OOM-killed, from its own series. Checked in order, the first that
// explains it wins: a release just before (its executable replaced), memory (an OOM kill: at
// its MemoryMax, or the server ran out), a dependency whose connections fail, its CPUQuota.
// Codes and facts only; the words are the web's (i18n), as for every cause (ADR-147).
import type { Workload } from './workloads.js';

export type CauseCode = 'release' | 'memory_limit' | 'oom' | 'dependency' | 'cpu_limit';
export type CheckResult = 'explains' | 'possible' | 'ok' | 'not_run';

export interface CauseCheck {
  topic: 'changes' | 'memory' | 'dependencies' | 'cpu';
  result: CheckResult;
  facts: Record<string, string | number | null>;
}

export interface ServerCause {
  state: 'likely' | 'possible' | 'none';
  code: CauseCode | null;
  /** When the symptom began (Unix seconds), from the exits timeline. */
  since: number | null;
  /** The symptom in numbers: exit code, failed exits and restarts in the last hour. */
  symptom: Record<string, string | number | null>;
  facts: Record<string, string | number | null>;
  checks: CauseCheck[];
}

export interface CauseInput {
  workload: Workload;
  /** [t, failed exits, kills, restarts, OOM kills] per minute over the last hour. */
  points: number[][];
  crashLoopSince: number | null;
  /** When the executable last changed in the last 6 hours (Unix seconds), or null. */
  releaseAt: number | null;
  oomKillsHour: number;
  /** The share of time throttled at its CPUQuota (services), or null. */
  throttledShare: number | null;
  connections: { to: string; port: number | null; rate: number; failed: number }[];
}

/** A release explains a symptom that began within 30 minutes after it (2 minutes' slack). */
const RELEASE_BEFORE_S = 1800;
const SLACK_S = 120;

/** The symptom's start: the crash loop's, else the first minute with a crash or restart. */
export function symptomSince(points: number[][], crashLoopSince: number | null): number | null {
  if (crashLoopSince !== null) return crashLoopSince;
  const first = points.find((p) => (p[1] ?? 0) + (p[2] ?? 0) + (p[3] ?? 0) + (p[4] ?? 0) > 0);
  return first ? first[0]! : null;
}

export function serverCause(i: CauseInput): ServerCause {
  const w = i.workload;
  const sum = (k: number) => i.points.reduce((n, p) => n + (p[k] ?? 0), 0);
  const symptom = {
    exitCode: w.lastExitCode,
    failedExits: sum(1) + sum(2),
    restarts: sum(3),
  };
  const since = symptomSince(i.points, i.crashLoopSince);
  const checks: CauseCheck[] = [];

  // The change came first: a release within 30 minutes before the symptom.
  const releaseExplains =
    i.releaseAt !== null &&
    since !== null &&
    i.releaseAt <= since + SLACK_S &&
    since - i.releaseAt <= RELEASE_BEFORE_S;
  checks.push({
    topic: 'changes',
    result: releaseExplains ? 'explains' : 'ok',
    facts: { releaseAt: i.releaseAt, since },
  });

  const limit = w.memoryLimitBytes;
  const usage = w.memoryBytes;
  const nearLimit = limit !== null && usage !== null && limit > 0 && usage / limit >= 0.9;
  const oom = i.oomKillsHour >= 1;
  checks.push({
    topic: 'memory',
    result: oom ? 'explains' : nearLimit ? 'possible' : 'ok',
    facts: { oomKills: Math.round(i.oomKillsHour), usage, limit },
  });

  const failing = [...i.connections]
    .filter((c) => c.failed > 0)
    .sort((a, b) => b.failed - a.failed)[0];
  const busiest = [...i.connections].sort((a, b) => b.rate - a.rate)[0];
  checks.push({
    topic: 'dependencies',
    result: i.connections.length === 0 ? 'not_run' : failing ? 'possible' : 'ok',
    facts: failing
      ? { to: failing.to, port: failing.port, failed: failing.failed }
      : { to: busiest?.to ?? null, port: busiest?.port ?? null, failed: 0 },
  });

  const throttled = i.throttledShare !== null && i.throttledShare >= 0.25;
  if (i.throttledShare !== null) {
    checks.push({
      topic: 'cpu',
      result: throttled ? 'possible' : 'ok',
      facts: { share: Math.round(i.throttledShare * 100) },
    });
  }

  const base = { since, symptom, checks };
  if (!w.problem) return { ...base, state: 'none', code: null, facts: {} };
  if (releaseExplains) {
    return {
      ...base,
      state: 'likely',
      code: 'release',
      facts: {
        releaseAt: i.releaseAt,
        minutesAfter: Math.max(0, Math.round((since! - i.releaseAt!) / 60)),
      },
    };
  }
  if (oom) {
    return {
      ...base,
      state: 'likely',
      code: limit ? 'memory_limit' : 'oom',
      facts: { oomKills: Math.round(i.oomKillsHour), usage, limit },
    };
  }
  if (failing) {
    return {
      ...base,
      state: 'possible',
      code: 'dependency',
      facts: { to: failing.to, port: failing.port, failed: failing.failed },
    };
  }
  if (nearLimit) {
    return {
      ...base,
      state: 'possible',
      code: 'memory_limit',
      facts: { oomKills: 0, usage, limit },
    };
  }
  if (throttled) {
    return {
      ...base,
      state: 'possible',
      code: 'cpu_limit',
      facts: { share: Math.round(i.throttledShare! * 100) },
    };
  }
  return { ...base, state: 'none', code: null, facts: {} };
}
