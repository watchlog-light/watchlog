// SPDX-License-Identifier: AGPL-3.0-only
// crash_exit (ADR-150 #4): the subject exits with a code. Kubernetes: a container that
// terminated with a non-zero code in the window (not OOMKilled: that is oom_limit), restarting
// with back-off; Docker (ADR-149): the container's newest Died event in the window with a
// non-zero code (or a container that stopped with one), restarted by its restart policy or
// left stopped. The chain: the restarts in the last hour (the symptom), the exit code and
// how often (where it starts), and the newest warning event that says more than the exit
// (a failing probe, say).
//
// Not this rule: exit 0 (a clean stop, or a process that ends on purpose: a stop is
// dependency_down's at the far end of an edge); a Docker exit 137 counted as an OOM kill; a
// Docker container stopped by a signal (137, 143) or running again without a restart by its
// policy (someone stopped and started it).
// Docker has no Jobs (ADR-149): a one-shot container that exited non-zero is this rule.
import { shortName } from '../checks.js';
import { interval } from '../counts.js';
import type { EvContainer, EvCount, EvPod, Evidence } from '../evidence.js';
import type { Match, Rule } from '../rules.js';
import type { Facts, Step } from '../types.js';
import {
  containerEvents,
  containerRef,
  containerRestarts,
  failureSince,
  firstBackOff,
  iso,
  lastDockerExit,
  oomKills,
  podEvents,
  podRef,
  podRestarts,
  workloadRestarts,
  recentTermination,
  telling,
  terminations,
  type Termination,
} from './common.js';

/** Pods of Jobs are job_failed's: their failed run is the problem, not each exit. */
const JOB_KINDS = new Set(['Job', 'CronJob']);
/** Exit codes of a container stopped by a signal (`docker stop`): SIGKILL, SIGTERM. */
const STOP_CODES = new Set([137, 143]);

function eventStep(ev: Evidence, object: Step['object'], events: Evidence['events']): Step | null {
  const e = telling(events, ev.window.from);
  return e
    ? {
        object,
        source: ev.platform === 'docker' ? 'docker' : 'kubernetes',
        code: 'last_event',
        facts: { reason: e.reason, message: e.message.slice(0, 200) },
        at: e.lastSeen,
        since: null,
        next: null,
      }
    : null;
}

/** The chain and headline from what both platforms know. */
function build(
  ev: Evidence,
  o: {
    object: Step['object'];
    exitCode: number;
    reason: string | null;
    container: string | null;
    restarts: EvCount | null;
    at: string | null;
    last: Step | null;
    restartStep: string;
  },
): Omit<Match, 'since' | 'complete'> {
  const name = shortName(ev);
  const n = o.restarts?.n ?? 0;
  const everyS = interval(o.restarts);
  const kube = ev.platform === 'kubernetes';
  const exitFacts: Facts = kube
    ? { container: o.container ?? '?', exitCode: o.exitCode, reason: o.reason ?? 'Error' }
    : { exitCode: o.exitCode };
  const base = kube ? 'exit_code' : 'exit_code_docker';
  const exit: Step = {
    object: o.object,
    source: kube ? 'kubernetes' : 'docker',
    code: n ? (everyS ? `${base}_every` : base) : kube ? base : 'exited_code',
    facts: n && everyS ? { ...exitFacts, everyS } : exitFacts,
    at: o.at,
    since: null,
    next: o.last ? 'after' : null,
  };
  const chain: Step[] = [];
  if (n)
    chain.push({
      object: o.object,
      source: kube ? 'kubernetes' : 'docker',
      code: o.restartStep,
      facts: { n },
      at: iso(o.restarts?.last),
      since: null,
      next: 'because',
    });
  chain.push(exit);
  if (o.last) chain.push(o.last);
  return {
    code: 'crash_exit',
    facts: { name, exitCode: o.exitCode, reason: o.reason, n, everyS },
    chain,
    headline: !n
      ? { code: 'crash_exit_once', facts: { name, exitCode: o.exitCode } }
      : everyS
        ? { code: 'crash_exit_every', facts: { name, exitCode: o.exitCode, everyS, n } }
        : { code: 'crash_exit', facts: { name, exitCode: o.exitCode, n } },
  };
}

function kube(ev: Evidence): Match | null {
  const crashed = ev.pods
    .filter((p: EvPod) => !JOB_KINDS.has(p.workloadKind ?? ''))
    .map((p) => {
      const ts = terminations(p);
      // The newest termination decides: an OOM kill is oom_limit's, exit 0 is no crash.
      const t: Termination | undefined = ts[0];
      // Reason "Unknown" (exit 255) is the node or the container runtime restarting the
      // container (a reboot, say), not the process exiting: every pod on the node has one.
      if (
        !t ||
        t.reason === 'OOMKilled' ||
        t.reason === 'Unknown' ||
        t.exitCode === 0 ||
        !recentTermination(ev, p, t)
      )
        return null;
      return { p, t, restarts: podRestarts(ev, p) ?? workloadRestarts(ev) };
    })
    .filter((x) => !!x)
    .sort((a, b) => (b.restarts?.n ?? b.p.restarts) - (a.restarts?.n ?? a.p.restarts));
  const top = crashed[0];
  if (!top) return null;
  const { p, t } = top;
  const restarts = top.restarts ?? (p.restarts ? null : { n: 0, first: null, last: null });
  const backoff = firstBackOff(ev);
  return {
    ...build(ev, {
      object: podRef(p),
      exitCode: t.exitCode,
      reason: t.reason,
      container: t.container,
      restarts,
      at: t.finishedAt ?? iso(restarts?.last) ?? null,
      last: eventStep(ev, podRef(p), podEvents(ev, p)),
      restartStep: p.failing === 'CrashLoopBackOff' ? 'restarts_backoff' : 'restarts',
    }),
    since: failureSince(ev, iso(restarts?.first), backoff?.firstSeen, t.finishedAt),
    // Without the metrics, "restarts in the last hour" isn't known: the exit still is.
    // One exit of a pod that runs again and isn't failing proves no loop: a lead only.
    complete: !!p.failing || (restarts?.n ?? p.restarts) > 1,
  };
}

function docker(ev: Evidence): Match | null {
  const crashed = ev.containers
    .map((c: EvContainer) => {
      const exit = lastDockerExit(ev, c);
      if (!exit || exit.exitCode === 0) return null;
      // Exit 137 with OOM kills in the hour is oom_limit's.
      if (exit.exitCode === 137 && ((oomKills(ev, c)?.n ?? 0) > 0 || c.oomKilled)) return null;
      const restarts = containerRestarts(ev, c);
      const restarted = (restarts?.n ?? 0) > 0;
      // Running again with no restart by its policy: someone started it again, the exit is
      // old news. Stopped by a signal (SIGTERM 143, or SIGKILL 137 after the stop timeout)
      // with no policy restart: a stop, not a crash.
      if (!restarted && (c.state === 'running' || STOP_CODES.has(exit.exitCode))) return null;
      return { c, exit, restarts };
    })
    .filter((x) => !!x)
    .sort((a, b) => (b.restarts?.n ?? 0) - (a.restarts?.n ?? 0));
  const top = crashed[0];
  if (!top) return null;
  const { c, exit, restarts } = top;
  const died = containerEvents(ev, c).find((e) => e.reason === 'Died');
  return {
    ...build(ev, {
      object: containerRef(c),
      exitCode: exit.exitCode,
      reason: null,
      container: c.name,
      restarts,
      at: exit.at,
      last: eventStep(ev, containerRef(c), containerEvents(ev, c)),
      restartStep: 'restarts_policy',
    }),
    since: failureSince(
      ev,
      iso(restarts?.first),
      died && Date.parse(died.firstSeen) >= Date.parse(ev.window.from) ? died.firstSeen : null,
      exit.at,
    ),
    complete: true,
  };
}

export const crashExit: Rule = {
  code: 'crash_exit',
  platforms: ['kubernetes', 'docker'],
  applies: (f) => ['pod', 'workload', 'container', 'compose_service'].includes(f.kind),
  match: (ev) => (ev.platform === 'docker' ? docker(ev) : kube(ev)),
  explains: ['self', 'events'],
};
