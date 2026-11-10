// SPDX-License-Identifier: AGPL-3.0-only
// "What we checked" (ADR-147): every answer lists what WatchLog looked at and what it found,
// so a reader without a clear cause starts from the facts, never from a blank. Pure: one
// evidence snapshot in, the checks out. A check that finds something abnormal is `possible`
// until a rule explains it (ranking then marks it `explains`).
import type { EvContainer, EvEdge, EvPod, Evidence } from './evidence.js';
import { WINDOW_BEFORE_MS } from './evidence.js';
import { nodeObject } from './resolve.js';
import { containerRestarts, oomKills, podRestarts, SAME_MS } from './rules/common.js';
import type { Check, CheckTopic, FlowsOff } from './types.js';

/** DNS errors (NXDOMAIN, SERVFAIL, timeouts) over lookups that count: the map's 5 %. */
export const DNS_ERROR_RATIO = 0.05;
/** Host memory or disk at this share is "nearly full" (ADR-149). */
export const HOST_FULL_RATIO = 0.9;
/** An edge is failing from this share of failed connects or 5xx (the map's warning). */
export const EDGE_FAILED_RATIO = 0.01;
/** An edge is slow from this p95 (the map's warning). */
export const EDGE_SLOW_P95_S = 1;

const check = (
  topic: CheckTopic,
  code: string,
  result: Check['result'],
  facts: Check['facts'] = {},
  object?: Check['object'],
): Check => ({ topic, code, facts, result, ...(object ? { object } : {}) });

const minutes = (ev: Evidence) =>
  Math.round(
    Math.min(
      WINDOW_BEFORE_MS,
      Date.parse(ev.symptomAt ?? ev.window.to) - Date.parse(ev.window.from),
    ) / 60_000,
  ) || 60;

/** The focus's short name, for "web itself". */
export function shortName(ev: Evidence): string {
  const f = ev.focus;
  switch (f.kind) {
    case 'pod':
    case 'workload':
    case 'container':
    case 'node':
    case 'host':
      return f.name;
    case 'compose_service':
      return f.service;
    case 'application':
      return ev.application?.name ?? f.id;
    case 'none':
      return ev.alert?.rule.name ?? '';
  }
}

/** Restarts in the window, from the termination times we have (pods) or the metric. */
const recent = (iso: string | null | undefined, ev: Evidence) =>
  !!iso && Date.parse(iso) >= Date.parse(ev.window.from);

/** The object itself: restarts, OOM kills, exits, waiting and scheduling, replicas. */
function selfCheck(ev: Evidence, name: string): Check {
  if (ev.gone) return check('self', 'self_gone', 'not_run', { name });
  if (ev.focus.kind === 'none') return check('self', 'self_no_object', 'not_applicable', { name });
  if (ev.platform === 'kubernetes' && (ev.focus.kind === 'pod' || ev.focus.kind === 'workload'))
    return kubeSelf(ev, name);
  if (ev.focus.kind === 'container' || ev.focus.kind === 'compose_service')
    return dockerSelf(ev, name);
  return check('self', 'self_ok', 'ok', { name });
}

function kubeSelf(ev: Evidence, name: string): Check {
  const pods = ev.pods;
  const term = (p: EvPod) => p.lastTermination;
  // kind sometimes reports a last termination without finishedAt (measured on the OOM
  // fixture): with restarts it counts as recent.
  const lately = (p: EvPod) => {
    const t = term(p);
    return !!t && (t.finishedAt ? recent(t.finishedAt, ev) : p.restarts > 0);
  };
  const oom = pods.find(
    (p) => p.failing === 'OOMKilled' || (term(p)?.reason === 'OOMKilled' && lately(p)),
  );
  if (oom) return check('self', 'self_oom_killed', 'possible', { name, n: null });
  const failing = pods.find((p) => p.failing && p.failing !== 'Pending');
  if (failing) return check('self', 'self_failing', 'possible', { name, reason: failing.failing });
  const pending = pods.find((p) => p.phase === 'Pending');
  if (pending) return check('self', 'self_pending', 'possible', { name, pod: pending.name });
  // Restarts in the counted hour (the metrics); without them the workload's own number,
  // which covers the hour before now.
  const restarts = ev.metrics
    ? pods.reduce((n, p) => n + (podRestarts(ev, p)?.n ?? 0), 0)
    : (ev.workload?.restartsInRange ?? pods.filter(lately).reduce((n, p) => n + p.restarts, 0));
  const when = (iso: string | null) => (iso ? Date.parse(iso) : ev.now);
  const last = pods
    .filter(lately)
    .map((p) => term(p)!)
    .sort((a, b) => when(b.finishedAt) - when(a.finishedAt))[0];
  if (restarts > 0)
    return last
      ? check('self', 'self_restarts_exit', 'possible', {
          name,
          n: Math.round(restarts),
          reason: last.reason,
          exitCode: last.exitCode,
        })
      : check('self', 'self_restarts', 'possible', { name, n: Math.round(restarts) });
  const w = ev.workload;
  if (w && w.desired !== null && w.ready !== null && w.ready < w.desired)
    return check('self', 'self_not_ready', 'possible', {
      name,
      ready: w.ready,
      desired: w.desired,
    });
  return check('self', 'self_ok', 'ok', { name });
}

function dockerSelf(ev: Evidence, name: string): Check {
  const cs = ev.containers;
  // Docker keeps OOMKilled set on a container that runs again; its oom kills in the counted
  // hour (the counter, else OOMKilled events all inside it) say how often. An OOMKilled event
  // in the window whose count reaches back before it is a kill, uncounted.
  const counts = cs.map((c) => oomKills(ev, c));
  const kills = counts.reduce((n, k) => n + (k?.n ?? 0), 0);
  const oom = cs.find((c) => c.oomKilled && c.state !== 'running');
  const event = ev.events.some((e) => e.reason === 'OOMKilled');
  if (oom || kills || (event && counts.some((k) => !k)))
    return check('self', 'self_oom_killed', 'possible', { name, n: kills || null });
  const unhealthy = cs.find((c) => c.health === 'unhealthy');
  if (unhealthy)
    return check('self', 'self_unhealthy', 'possible', {
      name,
      streak: unhealthy.healthDetail?.failingStreak ?? null,
    });
  if (ev.focus.kind === 'compose_service') {
    const running = cs.filter((c) => c.state === 'running').length;
    if (running < cs.length)
      return check('self', 'self_not_running', 'possible', { name, running, total: cs.length });
  } else {
    const stopped = cs.find((c) => c.state !== 'running');
    if (stopped)
      return check('self', 'self_stopped', 'possible', { name, exitCode: stopped.exitCode });
  }
  const restarts = cs.reduce((n, c) => n + (containerRestarts(ev, c)?.n ?? 0), 0);
  if (restarts > 0) {
    const exit = lastExit(ev, cs);
    return exit !== null
      ? check('self', 'self_restarts_code', 'possible', {
          name,
          n: Math.round(restarts),
          exitCode: exit,
        })
      : check('self', 'self_restarts', 'possible', { name, n: Math.round(restarts) });
  }
  return check('self', 'self_ok', 'ok', { name });
}

/** The exit code of the newest "Died" event (Docker says "Exited with code 3"), else a stopped container's. */
function lastExit(ev: Evidence, cs: EvContainer[]): number | null {
  for (const e of ev.events) {
    const m = e.reason === 'Died' ? /code (\d+)/.exec(e.message) : null;
    if (m) return Number(m[1]);
  }
  const stopped = cs.find((c) => c.state !== 'running' && c.exitCode !== 0);
  return stopped ? stopped.exitCode : null;
}

function eventsCheck(ev: Evidence, name: string): Check | null {
  if (ev.gone || ev.focus.kind === 'none' || ev.focus.kind === 'application') return null;
  const warnings = ev.events.filter((e) => e.type === 'Warning');
  if (!warnings.length) return check('events', 'events_none', 'ok', { name, minutes: minutes(ev) });
  const top = [...warnings].sort((a, b) => b.count - a.count)[0]!;
  return check('events', 'events_warnings', 'possible', {
    name,
    n: warnings.reduce((n, e) => n + e.count, 0),
    reason: top.reason,
  });
}

function changesCheck(ev: Evidence, name: string): Check {
  // Before the problem: changes after the symptom (the window runs to now) are no cause.
  const until = Date.parse(ev.symptomAt ?? ev.window.to) + SAME_MS;
  const own = ev.changes.filter(
    (m) => ev.ownTargets.includes(m.target) && Date.parse(m.ts) <= until,
  );
  if (ev.focus.kind === 'none' || ev.focus.kind === 'application')
    return ev.changes.length
      ? check('changes', 'changes_cluster', 'possible', {
          n: ev.changes.length,
          minutes: minutes(ev),
        })
      : check('changes', 'changes_cluster_none', 'ok', { minutes: minutes(ev) });
  if (!own.length) return check('changes', 'changes_none', 'ok', { name, minutes: minutes(ev) });
  return check('changes', 'changes_own', 'possible', { name, n: own.length, minutes: minutes(ev) });
}

function nodeChecks(ev: Evidence, name: string): Check[] {
  if (ev.platform === 'kubernetes') {
    if (ev.focus.kind === 'pod' || ev.focus.kind === 'workload') {
      if (!ev.gone && ev.pods.length && ev.pods.every((p) => !p.node))
        return [check('node', 'node_none', 'not_applicable', { name })];
    } else if (ev.focus.kind !== 'node') return [];
    return ev.nodes.map((n) => {
      const o = nodeObject(n.name, 'kubernetes');
      if (n.status !== 'Ready')
        return check('node', 'node_not_ready', 'possible', { node: n.name, status: n.status }, o);
      const bad = n.conditions.find((c) => c.bad && c.type !== 'Ready');
      if (bad)
        return check('node', 'node_pressure', 'possible', { node: n.name, condition: bad.type }, o);
      if (n.unschedulable)
        return check('node', 'node_unschedulable', 'possible', { node: n.name }, o);
      return check('node', 'node_ok', 'ok', { node: n.name }, o);
    });
  }
  if (!['container', 'compose_service', 'host'].includes(ev.focus.kind)) return [];
  return ev.hosts.map((h) => {
    const o = nodeObject(h.name, 'docker');
    if (h.status !== 'active')
      return h.lastSeenAt
        ? check(
            'host',
            'host_silent',
            'possible',
            {
              host: h.name,
              minutes: Math.max(1, Math.round((ev.now - Date.parse(h.lastSeenAt)) / 60_000)),
            },
            o,
          )
        : check('host', 'host_never', 'possible', { host: h.name }, o);
    if ((h.memoryUtilization ?? 0) >= HOST_FULL_RATIO)
      return check(
        'host',
        'host_memory',
        'possible',
        { host: h.name, pct: Math.round(h.memoryUtilization! * 100) },
        o,
      );
    if ((h.diskUtilization ?? 0) >= HOST_FULL_RATIO)
      return check(
        'host',
        'host_disk',
        'possible',
        { host: h.name, pct: Math.round(h.diskUtilization! * 100) },
        o,
      );
    return check('host', 'host_ok', 'ok', { host: h.name }, o);
  });
}

/** The nodes or hosts under the focus whose agent sees no network flows. */
export function flowsOffOf(ev: Evidence): FlowsOff[] | null {
  if (ev.map.mode === 'unavailable') return null;
  const under =
    ev.platform === 'kubernetes'
      ? ev.pods.map((p) => p.node).filter((n): n is string => !!n)
      : ev.containers.map((c) => c.host);
  const mine = new Set(under);
  const agents = mine.size ? ev.map.agents.filter((a) => mine.has(a.node)) : ev.map.agents;
  const off = agents
    .filter((a) => a.ebpf !== 'enabled')
    .map((a) => ({ node: a.node, cause: a.cause, reason: a.reason }));
  // No agent sees flows at all: the whole map is topology.
  if (!off.length && ev.map.mode === 'topology')
    return ev.map.agents.map((a) => ({ node: a.node, cause: a.cause, reason: a.reason }));
  return off.length ? off : null;
}

const pct = (r: number | null | undefined) => Math.round((r ?? 0) * 1000) / 10;

/**
 * The focus's DNS lookups a second (the map's rows over 5 minutes, whose requests already
 * leave search-path misses out, ADR-113), NXDOMAIN answers, and every failure (NXDOMAIN,
 * SERVFAIL, timeouts).
 */
export function dnsTotals(ev: Evidence): { lookups: number; nxdomain: number; errors: number } {
  let lookups = 0;
  let nxdomain = 0;
  let errors = 0;
  for (const d of ev.map.dns) {
    lookups += d.requestsPerSecond;
    nxdomain += d.nxdomainPerSecond;
    errors += d.nxdomainPerSecond + d.servfailPerSecond + d.timeoutPerSecond;
  }
  return { lookups, nxdomain, errors };
}

/** An edge's trouble, as a check of its own (the edge subject) or a dependency. */
export function edgeTrouble(e: EvEdge): { code: string; facts: Check['facts'] } | null {
  if ((e.failedRatio ?? 0) >= EDGE_FAILED_RATIO && (e.failedLastMinute ?? 1) > 0)
    return { code: 'failed', facts: { pct: pct(e.failedRatio), port: e.port } };
  if ((e.http?.serverErrorRatio ?? 0) >= EDGE_FAILED_RATIO)
    return { code: 'errors', facts: { pct: pct(e.http!.serverErrorRatio) } };
  const p95 = e.http?.p95Seconds ?? null;
  if (p95 !== null && p95 >= EDGE_SLOW_P95_S)
    return { code: 'slow', facts: { p95Ms: Math.round(p95 * 1000) } };
  return null;
}

function networkChecks(ev: Evidence, name: string, flowsOff: FlowsOff[] | null): Check[] {
  const hasMapNode = ['pod', 'workload', 'container', 'compose_service'].includes(ev.focus.kind);
  if (!hasMapNode || ev.gone) return [];
  if (ev.map.mode === 'unavailable')
    return [
      check('dependencies', 'dependencies_unavailable', 'not_run', { name }),
      check('dns', 'dns_unavailable', 'not_run', { name }),
    ];
  if (flowsOff)
    return [
      check('dependencies', 'dependencies_flows_off', 'not_run', { name }),
      check('dns', 'dns_flows_off', 'not_run', { name }),
    ];
  if (!ev.map.ids.length)
    return [check('dependencies', 'dependencies_no_node', 'not_applicable', { name })];
  const out: Check[] = [];
  const calls = ev.map.outgoing.filter((e) => e.connectionsPerSecond > 0 || e.failedPerSecond > 0);
  const failing = ev.map.outgoing.filter((e) => edgeTrouble(e));
  if (failing.length) {
    const worst = failing.sort((a, b) => (b.failedRatio ?? 0) - (a.failedRatio ?? 0))[0]!;
    const node = ev.map.nodes.find((n) => n.id === worst.target);
    out.push(
      check('dependencies', 'dependencies_failing', 'possible', {
        name,
        n: failing.length,
        target: node?.name ?? worst.target.replace(/^[a-z]:/, ''),
      }),
    );
  } else if (calls.length) {
    out.push(check('dependencies', 'dependencies_ok', 'ok', { name, n: calls.length }));
  } else if (ev.map.outgoing.some((e) => /^[wc]:/.test(e.target))) {
    // It called services in the last hour and calls none now (a Docker dependency that
    // stopped leaves Docker's DNS: its callers stop connecting rather than fail).
    const quiet = ev.map.outgoing.filter((e) => /^[wc]:/.test(e.target));
    out.push(check('dependencies', 'dependencies_quiet', 'possible', { name, n: quiet.length }));
  } else {
    out.push(check('dependencies', 'dependencies_none', 'not_applicable', { name }));
  }
  const dns = ev.map.dns;
  const lookups = dns.reduce((n, d) => n + d.requestsPerSecond, 0);
  const errors = dns.reduce(
    (n, d) => n + d.nxdomainPerSecond + d.servfailPerSecond + d.timeoutPerSecond,
    0,
  );
  if (!lookups) out.push(check('dns', 'dns_none', 'not_applicable', { name }));
  else if (errors / lookups >= DNS_ERROR_RATIO)
    out.push(
      check('dns', 'dns_errors', 'possible', {
        name,
        perMinute: Math.round(errors * 60),
        nxdomainPerMinute: Math.round(dns.reduce((n, d) => n + d.nxdomainPerSecond, 0) * 60),
      }),
    );
  else out.push(check('dns', 'dns_ok', 'ok', { name }));
  return out;
}

function edgeCheck(ev: Evidence): Check[] {
  if (!ev.edge) return [];
  const t = edgeTrouble(ev.edge);
  return [
    t
      ? check('edge', `edge_${t.code}`, 'possible', t.facts)
      : check('edge', 'edge_ok', 'ok', { port: ev.edge.port }),
  ];
}

function applicationCheck(ev: Evidence): Check[] {
  const a = ev.application;
  if (!a) return [];
  const name = a.name;
  if (a.reason.code !== 'connected')
    return [check('application', 'application_unreachable', 'not_run', { name })];
  const findings = a.reasons.filter(
    (r) => (r.severity === 'critical' || r.severity === 'warning') && r.code !== 'connected',
  );
  return findings.length
    ? [check('application', 'application_findings', 'possible', { name, n: findings.length })]
    : [check('application', 'application_ok', 'ok', { name })];
}

/** Every check of one snapshot, and the nodes or hosts with network flows off. */
export function checksOf(ev: Evidence): { checks: Check[]; flowsOff: FlowsOff[] | null } {
  const name = shortName(ev);
  const flowsOff = flowsOffOf(ev);
  const events = eventsCheck(ev, name);
  return {
    checks: [
      ...edgeCheck(ev),
      ...applicationCheck(ev),
      // A node's or host's own state is its node or host check.
      ...(['application', 'node', 'host'].includes(ev.focus.kind) ? [] : [selfCheck(ev, name)]),
      ...(events ? [events] : []),
      changesCheck(ev, name),
      ...nodeChecks(ev, name),
      ...networkChecks(ev, name, flowsOff),
    ],
    flowsOff,
  };
}
