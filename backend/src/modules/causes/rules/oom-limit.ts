// SPDX-License-Identifier: AGPL-3.0-only
// oom_limit (ADR-150 #3): OOM-killed at its memory limit. Kubernetes: a container whose
// termination reason is OOMKilled in the window, with a memory limit; Docker (ADR-149): the
// container's oom kills (its oom-events counter, else the OOMKilled events) or a container
// that stopped OOM-killed, with a memory limit. The chain names the limit, the count in the
// last hour (restarts on Kubernetes, where no kill counter exists per pod; kills on Docker)
// and, only when two runs or more show it, how fast memory climbs to the limit.
//
// Not this rule: a kill without a memory limit (the node or host ran out: node_or_host);
// under node memory pressure or a nearly full host the limit may not be why, so the chain
// is partial (possible at best). The working set at the kill is rarely seen (scrapes every
// 15 s miss the peak, slice 0 gap 11): "limit reached" comes from the termination reason.
import { memoryTrend } from '../counts.js';
import type { EvContainer, Evidence } from '../evidence.js';
import type { Match, Rule } from '../rules.js';
import type { Step } from '../types.js';
import { shortName } from '../checks.js';
import {
  containerEvents,
  containerRef,
  failureSince,
  firstBackOff,
  hostShortOfMemory,
  iso,
  memoryPoints,
  nodeShortOfMemory,
  oomKills,
  podMemoryLimit,
  podRef,
  podRestarts,
  workloadRestarts,
  recentTermination,
  terminations,
} from './common.js';

function trendStep(ev: Evidence, object: Step['object'], key: string, limit: number): Step | null {
  const t = memoryTrend(memoryPoints(ev, key), limit, ev.metrics?.step ?? 15);
  if (!t) return null;
  return {
    object,
    source: 'metrics',
    code: 'memory_climbs',
    facts: { limitBytes: limit, perMinuteBytes: Math.round(t.perMinute), minutes: t.minutes },
    at: null,
    since: null,
    next: null,
  };
}

function kube(ev: Evidence): Match | null {
  const killed = ev.pods
    .map((p) => {
      const t = terminations(p).find((x) => x.reason === 'OOMKilled');
      if (!t || !recentTermination(ev, p, t)) return null;
      const limit = podMemoryLimit(p, t.container);
      return limit ? { p, t, limit, restarts: podRestarts(ev, p) ?? workloadRestarts(ev) } : null;
    })
    .filter((x) => !!x)
    .sort((a, b) => (b.restarts?.n ?? b.p.restarts) - (a.restarts?.n ?? a.p.restarts));
  const top = killed[0];
  if (!top) return null;
  const { p, t, limit } = top;
  const counted = killed.every((k) => k.restarts);
  const n = counted ? killed.reduce((s, k) => s + k.restarts!.n, 0) : null;
  const container = t.container ?? p.name;
  const trend = trendStep(ev, podRef(p), `${p.namespace}/${p.name}/${container}`, limit);
  const backoff = firstBackOff(ev);
  const at = t.finishedAt ?? iso(top.restarts?.last) ?? null;
  const step: Step = {
    object: podRef(p),
    source: 'kubernetes',
    code: n ? 'oom_killed_restarts' : 'oom_killed',
    facts: n ? { container, limitBytes: limit, n } : { container, limitBytes: limit },
    at,
    since: null,
    next: trend ? 'because' : null,
  };
  const name = shortName(ev);
  return {
    code: 'oom_limit',
    facts: { name, container, limitBytes: limit, n, platform: 'kubernetes' },
    since: failureSince(ev, iso(top.restarts?.first), backoff?.firstSeen, t.finishedAt),
    chain: trend ? [step, trend] : [step],
    complete: !killed.some((k) => nodeShortOfMemory(ev, k.p.node)),
    headline: n
      ? { code: 'oom_limit_restarts', facts: { name, limitBytes: limit, n } }
      : { code: 'oom_limit_last', facts: { name, limitBytes: limit } },
  };
}

function docker(ev: Evidence): Match | null {
  const from = Date.parse(ev.window.from);
  const killed = ev.containers
    .map((c: EvContainer) => {
      const kills = oomKills(ev, c);
      const event = containerEvents(ev, c).find(
        (e) => e.reason === 'OOMKilled' && Date.parse(e.lastSeen) >= from,
      );
      // Docker keeps oomKilled set on a container that runs again: alone, it only counts
      // for a container that is stopped or restarting.
      const stopped = c.oomKilled && c.state !== 'running';
      if (!(kills?.n || event || stopped) || !c.memoryLimitBytes) return null;
      return { c, kills, event, limit: c.memoryLimitBytes };
    })
    .filter((x) => !!x)
    .sort((a, b) => (b.kills?.n ?? 0) - (a.kills?.n ?? 0));
  const top = killed[0];
  if (!top) return null;
  const { c, limit } = top;
  const n = killed.every((k) => k.kills) ? killed.reduce((s, k) => s + k.kills!.n, 0) : null;
  const trend = trendStep(ev, containerRef(c), `${c.host}/${c.name}`, limit);
  const step: Step = {
    object: containerRef(c),
    source: 'docker',
    code: n ? 'oom_killed_kills' : 'oom_killed',
    facts: n ? { limitBytes: limit, n } : { container: c.name, limitBytes: limit },
    at: iso(top.kills?.last) ?? top.event?.lastSeen ?? c.finishedAt,
    since: null,
    next: trend ? 'because' : null,
  };
  const name = shortName(ev);
  return {
    code: 'oom_limit',
    facts: { name, container: c.name, limitBytes: limit, n, platform: 'docker' },
    since: failureSince(ev, iso(top.kills?.first), top.event?.firstSeen, c.finishedAt),
    chain: trend ? [step, trend] : [step],
    complete: !killed.some((k) => hostShortOfMemory(ev, k.c.host)),
    headline: n
      ? { code: 'oom_limit', facts: { name, limitBytes: limit, n } }
      : { code: 'oom_limit_last', facts: { name, limitBytes: limit } },
  };
}

/** Whether a pod or container was OOM-killed at its limit in the window (for other rules). */
export const oomAtLimit = (ev: Evidence) => (ev.platform === 'docker' ? docker(ev) : kube(ev));

export const oomLimit: Rule = {
  code: 'oom_limit',
  platforms: ['kubernetes', 'docker'],
  applies: (f) => ['pod', 'workload', 'container', 'compose_service'].includes(f.kind),
  match: oomAtLimit,
  explains: ['self', 'events'],
};
