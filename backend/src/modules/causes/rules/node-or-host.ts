// SPDX-License-Identifier: AGPL-3.0-only
// node_or_host (ADR-150 #7, slice 4, ADR-154): the pod's or container's symptom comes from the
// node or host under it.
//
// Kubernetes:
//   - held off cordoned or tainted nodes: a Pending pod whose FailedScheduling names cordoned
//     nodes ("node(s) were unschedulable") or taints, while a node is cordoned or carries a
//     condition taint (node.kubernetes.io/…). The node-drain scenario: `pinned` may only run on
//     the drained node. There is no change marker for a cordon (slice 0, gap 4): the node's
//     NodeNotSchedulable event says when, unless a NodeSchedulable came after it. Complete
//     unless the scheduler also finds the other nodes short of CPU or memory (the held node
//     might be too); it then covers `unschedulable`, whose chain is partial for a cordon
//     (ADR-152);
//   - on a node that isn't Ready: its pods' state is the node's (NotReady, Unknown);
//   - evicted: the kubelet evicted the pod because the node was low on a resource (its
//     message says so; a pod over its own ephemeral-storage limit is the pod's, not this);
//   - OOM-killed for the node's sake: with no memory limit (only the node can have run out),
//     or under MemoryPressure while its memory stayed well below its limit (it covers
//     oom_limit's partial chain then); under pressure near the limit, both stay partial.
// Docker (ADR-149):
//   - the host went silent (status inactive, 3 minutes without a report): what WatchLog shows
//     of its containers is from before (slice 0, gap 5); there is no cordon or drain on Docker
//     (gap 4);
//   - OOM-killed for the host's sake: no memory limit, or the host nearly full (≥ 90 %) while
//     its memory stayed well below its limit.
//   - stopped when its host rebooted or its Docker daemon restarted (the containers API's
//     `stoppedWith`, ADR-159): "host restarted at 08:50", not a crash.
// Kubernetes again: a pod whose newest termination is reason Unknown (exit 255: the node or
// the runtime restarted the container) within minutes of its node's Rebooted event: "node
// restarted at 08:50" (ADR-159; crash_exit skips those terminations since 216f951).
// Both: a node under pressure or a host nearly full while the object fails (restarts, not
// ready) is a partial chain, possible at best.
import { HOST_FULL_RATIO, shortName } from '../checks.js';
import type { EvContainer, EvNode, Evidence } from '../evidence.js';
import { nodeObject } from '../resolve.js';
import type { Match, Rule, RuleCode } from '../rules.js';
import type { CheckTopic, Facts, Step } from '../types.js';
import { schedulingReasons } from './unschedulable.js';
import {
  conditionTaint,
  containerEvents,
  containerRef,
  containerRestarts,
  earliest,
  HELD_BY_NODES,
  iso,
  memoryPoints,
  oomKills,
  podEvents,
  podMemoryLimit,
  podRef,
  podRestarts,
  recentTermination,
  terminations,
} from './common.js';

/** Memory that stayed under this share of the limit was not what the limit killed. */
export const BELOW_LIMIT = 0.5;

const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

/** When the node was last cordoned (NodeNotSchedulable), unless uncordoned since; null otherwise. */
export function cordonedAt(n: EvNode): string | null {
  const events = n.events ?? [];
  const off = events.find((e) => e.reason === 'NodeNotSchedulable');
  const on = events.find((e) => e.reason === 'NodeSchedulable');
  if (!off) return null;
  return on && ms(on.lastSeen) > ms(off.lastSeen) ? null : off.lastSeen;
}

const PRESSURES = ['MemoryPressure', 'DiskPressure', 'PIDPressure'];

/** What is wrong with a node, as its step: not Ready, under pressure, or cordoned; null when fine. */
function nodeStep(n: EvNode, platform: 'kubernetes'): Step | null {
  const object = nodeObject(n.name, platform);
  const base = { object, source: 'kubernetes' as const, next: null, at: null };
  if (n.status !== 'Ready') {
    const ready = n.conditions.find((c) => c.type === 'Ready');
    return {
      ...base,
      code: 'node_not_ready',
      facts: { node: n.name, status: n.status, reason: ready?.reason ?? null },
      since: ready?.since ?? null,
    };
  }
  const p = n.conditions.find((c) => c.bad && PRESSURES.includes(c.type));
  if (p)
    return {
      ...base,
      code: 'node_pressure',
      facts: { node: n.name, condition: p.type },
      since: p.since,
    };
  if (n.unschedulable || n.taints.some((t) => t.startsWith('node.kubernetes.io/unschedulable')))
    return {
      ...base,
      code: 'node_cordoned',
      facts: { node: n.name },
      at: cordonedAt(n),
      since: null,
    };
  return null;
}

const nodeOf = (ev: Evidence, name: string | null) =>
  name ? (ev.nodes.find((n) => n.name === name) ?? null) : null;

const stepTime = (s: Step) => s.at ?? s.since;

function held(ev: Evidence, name: string): Match | null {
  const from = ms(ev.window.from);
  const bad = ev.nodes
    .filter((n) => n.unschedulable || n.taints.some(conditionTaint) || n.status !== 'Ready')
    .map((n) => nodeStep(n, 'kubernetes'))
    .filter((s): s is Step => !!s);
  if (!bad.length) return null;
  for (const p of ev.pods) {
    if (p.phase !== 'Pending' || p.node) continue;
    const e = podEvents(ev, p).find(
      (x) =>
        x.reason === 'FailedScheduling' && ms(x.lastSeen) >= from && HELD_BY_NODES.test(x.message),
    );
    if (!e) continue;
    const s = schedulingReasons(e.message);
    const n = s.reasons
      .filter((r) => r.reason === 'cordoned' || r.reason === 'taint')
      .reduce((k, r) => k + r.n, 0);
    // Short of CPU or memory elsewhere: the held node might be too.
    const short = s.reasons.some((r) => ['cpu', 'memory', 'resource'].includes(r.reason));
    // Not Ready before under pressure before cordoned: what says most about the node.
    const node = bad[0]!;
    const pending: Step = {
      object: podRef(p),
      source: 'kubernetes',
      code: 'pending_unscheduled',
      facts: {},
      at: null,
      since: p.createdAt,
      next: 'because',
    };
    const nodeName = String(node.facts.node);
    const how =
      node.code === 'node_cordoned'
        ? 'cordoned'
        : node.code === 'node_not_ready'
          ? 'not_ready'
          : 'pressure';
    return {
      code: 'node_or_host',
      facts: { name, node: nodeName, how, pod: p.name, platform: 'kubernetes', n },
      since: earliest(stepTime(node), e.firstSeen),
      chain: [pending, node],
      complete: !short,
      headline: {
        code: `node_or_host_held_${how}`,
        facts:
          how === 'pressure'
            ? { name, node: nodeName, condition: String(node.facts.condition) }
            : { name, node: nodeName },
      },
      explains: ['self', 'events', 'node'],
      ...(short ? {} : { covers: ['unschedulable'] as RuleCode[] }),
    };
  }
  return null;
}

function notReady(ev: Evidence, name: string): Match | null {
  for (const p of ev.pods) {
    const n = nodeOf(ev, p.node);
    if (!n || n.status === 'Ready') continue;
    const node = nodeStep(n, 'kubernetes')!;
    const on: Step = {
      object: podRef(p),
      source: 'kubernetes',
      code: 'on_node',
      facts: { node: n.name, status: p.status },
      at: null,
      since: null,
      next: 'because',
    };
    return {
      code: 'node_or_host',
      facts: { name, node: n.name, how: 'not_ready', pod: p.name, platform: 'kubernetes' },
      since: node.since,
      chain: [on, node],
      complete: true,
      headline: {
        code: 'node_or_host_not_ready',
        facts: { name, node: n.name, status: n.status },
      },
      explains: ['self', 'node'],
    };
  }
  return null;
}

/** The resource an eviction names: "The node was low on resource: memory." → memory. */
export function evictedFor(message: string): string | null {
  const m = /node was low on resource: \[?([\w.-]+)/i.exec(message);
  return m ? m[1]!.replace(/\.+$/, '') : null;
}

const CONDITION_OF: Record<string, string> = {
  memory: 'MemoryPressure',
  'ephemeral-storage': 'DiskPressure',
  nodefs: 'DiskPressure',
  imagefs: 'DiskPressure',
  pids: 'PIDPressure',
};

function evicted(ev: Evidence, name: string): Match | null {
  const from = ms(ev.window.from);
  for (const p of ev.pods) {
    const e = podEvents(ev, p).find((x) => x.reason === 'Evicted' && ms(x.lastSeen) >= from);
    const message = e?.message ?? (p.status === 'Evicted' ? (p.message ?? '') : '');
    const resource = message ? evictedFor(message) : null;
    if (!resource) continue;
    const n = nodeOf(ev, p.node);
    const condition = CONDITION_OF[resource] ?? null;
    const now = n?.conditions.find((c) => c.type === condition && c.bad);
    const at = e?.lastSeen ?? p.startedAt ?? null;
    const out: Step = {
      object: podRef(p),
      source: 'kubernetes',
      code: 'evicted',
      facts: { resource },
      at,
      since: null,
      next: 'because',
    };
    const nodeName = p.node ?? n?.name ?? null;
    const node: Step | null = nodeName
      ? {
          object: nodeObject(nodeName, 'kubernetes'),
          source: 'kubernetes',
          code: now ? 'node_pressure' : 'node_was_low',
          facts: now ? { node: nodeName, condition: now.type } : { node: nodeName, resource },
          at: null,
          since: now?.since ?? null,
          next: null,
        }
      : null;
    return {
      code: 'node_or_host',
      facts: {
        name,
        node: nodeName,
        how: 'evicted',
        resource,
        pod: p.name,
        platform: 'kubernetes',
      },
      since: earliest(e && ms(e.firstSeen) >= from ? e.firstSeen : null, at),
      chain: node ? [out, node] : [{ ...out, next: null }],
      complete: true,
      headline: nodeName
        ? { code: 'node_or_host_evicted', facts: { name, node: nodeName, resource } }
        : { code: 'node_or_host_evicted_node', facts: { name, resource } },
      explains: ['self', 'events', 'node'],
    };
  }
  return null;
}

/** The highest working set seen in the counted hour, when the metrics have it. */
function peak(ev: Evidence, key: string): number | null {
  const pts = memoryPoints(ev, key);
  return pts.length ? Math.max(...pts.map(([, v]) => v)) : null;
}

/**
 * An OOM kill that is the node's or the host's: no limit (only the node can have run out), or
 * short of memory while the working set stayed below half its limit. Null when the limit is
 * the likelier reason (oom_limit's).
 */
function oomFor(
  short: boolean,
  limit: number | null,
  top: number | null,
): { complete: boolean; below: boolean } | null {
  if (!limit) return { complete: true, below: false };
  if (!short) return null;
  const below = top !== null && top < BELOW_LIMIT * limit;
  return { complete: below, below };
}

/** The kill's step: without a limit, below it (the peak seen), or under it, peak unseen. */
function killStep(container: string, limit: number | null, top: number | null) {
  if (!limit) return { code: 'oom_killed_no_limit', facts: { container } as Facts };
  return top === null
    ? { code: 'oom_killed_with_limit', facts: { container, limitBytes: limit } as Facts }
    : {
        code: 'oom_killed_below_limit',
        facts: { container, limitBytes: limit, peakBytes: top } as Facts,
      };
}

function kubeOom(ev: Evidence, name: string): Match | null {
  for (const p of ev.pods) {
    const t = terminations(p).find((x) => x.reason === 'OOMKilled');
    if (!t || !recentTermination(ev, p, t)) continue;
    const n = nodeOf(ev, p.node);
    const pressure = !!n?.conditions.some((c) => c.type === 'MemoryPressure' && c.bad);
    const limit = podMemoryLimit(p, t.container);
    const container = t.container ?? p.name;
    const top = peak(ev, `${p.namespace}/${p.name}/${container}`);
    const f = oomFor(pressure, limit, top);
    if (!f) continue;
    const r = podRestarts(ev, p);
    const kill: Step = {
      object: podRef(p),
      source: 'kubernetes',
      ...killStep(container, limit, top),
      at: t.finishedAt ?? iso(r?.last) ?? null,
      since: null,
      next: p.node ? 'because' : null,
    };
    const used =
      n?.memory?.usageBytes && n.memory.allocatableBytes
        ? Math.round((n.memory.usageBytes / n.memory.allocatableBytes) * 100)
        : null;
    const node: Step | null = p.node
      ? {
          object: nodeObject(p.node, 'kubernetes'),
          source: 'kubernetes',
          code: pressure ? 'node_pressure' : used === null ? 'node_ran_out' : 'node_memory',
          facts: pressure
            ? { node: p.node, condition: 'MemoryPressure' }
            : used === null
              ? { node: p.node }
              : { node: p.node, pct: used },
          at: null,
          since: pressure
            ? (n!.conditions.find((c) => c.type === 'MemoryPressure')?.since ?? null)
            : null,
          next: null,
        }
      : null;
    return {
      code: 'node_or_host',
      facts: { name, node: p.node, how: 'oom', container, platform: 'kubernetes' },
      since: earliest(iso(r?.first), t.finishedAt),
      chain: node ? [kill, node] : [kill],
      complete: f.complete,
      headline: limit
        ? {
            code: 'node_or_host_oom_pressure',
            facts: { name, node: p.node ?? '?', limitBytes: limit },
          }
        : { code: 'node_or_host_oom_no_limit', facts: { name, node: p.node ?? '?' } },
      explains: ['self', 'events', 'node'],
      ...(f.complete ? { covers: ['oom_limit'] as RuleCode[] } : {}),
    };
  }
  return null;
}

/** A node under pressure under a failing pod: partial (what else fails there isn't known). */
function kubeStrained(ev: Evidence, name: string): Match | null {
  for (const p of ev.pods) {
    const n = nodeOf(ev, p.node);
    const c = n?.conditions.find((x) => x.bad && PRESSURES.includes(x.type));
    if (!n || !c) continue;
    const restarts = podRestarts(ev, p)?.n ?? 0;
    if (!p.failing && !restarts && p.ready) continue;
    return {
      code: 'node_or_host',
      facts: { name, node: n.name, how: 'pressure', pod: p.name, platform: 'kubernetes' },
      since: c.since,
      chain: [
        {
          object: podRef(p),
          source: 'kubernetes',
          code: 'on_node',
          facts: { node: n.name, status: p.status },
          at: null,
          since: null,
          next: 'because',
        },
        nodeStep(n, 'kubernetes')!,
      ],
      complete: false,
      headline: {
        code: 'node_or_host_pressure',
        facts: { name, node: n.name, condition: c.type },
      },
      explains: ['node'],
    };
  }
  return null;
}

/** A termination this close to the node's Rebooted event came with the reboot. */
export const REBOOT_SLACK_MS = 5 * 60_000;

/** The node's newest reboot (its Rebooted event), else null. */
export function rebootedAt(n: EvNode): string | null {
  return (n.events ?? []).find((e) => e.reason === 'Rebooted')?.lastSeen ?? null;
}

/** Alerts a restart can explain; any other alert (CPU throttling, say) isn't about one. */
const RESTART_ALERTS = new Set(['k8s.pod.crashloop', 'k8s.deployment.unavailable']);

/** A pod the node's reboot restarted: its newest termination is Unknown, at the reboot. */
function nodeRestarted(ev: Evidence, name: string): Match | null {
  if (ev.alert && !RESTART_ALERTS.has(ev.alert.rule.key ?? '')) return null;
  // At the far end of an edge the pod runs again: a past restart explains no call failing
  // or slow now (it read "caller is throttled: hot restarted when its node restarted").
  if (ev.via) return null;
  // Only a symptom that began with the reboot: an hour later, web failing to reach api
  // isn't explained by web's restart at the reboot.
  const symptom = ms(ev.symptomAt);
  if (!Number.isFinite(symptom)) return null;
  for (const p of ev.pods) {
    const t = terminations(p)[0];
    if (!t || t.reason !== 'Unknown' || !recentTermination(ev, p, t)) continue;
    const n = nodeOf(ev, p.node);
    const at = n ? rebootedAt(n) : null;
    if (!n || !at) continue;
    if (t.finishedAt && Math.abs(ms(t.finishedAt) - ms(at)) > REBOOT_SLACK_MS) continue;
    if (symptom < ms(at) - REBOOT_SLACK_MS || symptom > ms(at) + 2 * REBOOT_SLACK_MS) continue;
    const restarts = podRestarts(ev, p)?.n ?? null;
    const restarted: Step = {
      object: podRef(p),
      source: 'kubernetes',
      code: 'restarted_by_node',
      facts: { container: t.container ?? '?' },
      at: t.finishedAt ?? at,
      since: null,
      next: 'because',
    };
    const node: Step = {
      object: nodeObject(n.name, 'kubernetes'),
      source: 'kubernetes',
      code: 'node_rebooted',
      facts: { node: n.name },
      at,
      since: null,
      next: null,
    };
    return {
      code: 'node_or_host',
      facts: { name, node: n.name, how: 'rebooted', pod: p.name, platform: 'kubernetes', at },
      since: at,
      chain: [restarted, node],
      // More restarts in the hour than the reboot's one, or failing now: something else.
      complete: !p.failing && (restarts === null || restarts <= 1),
      headline: { code: 'node_or_host_node_restarted', facts: { name, node: n.name, at } },
      explains: ['self', 'events', 'node'],
    };
  }
  return null;
}

function kube(ev: Evidence): Match | null {
  const name = shortName(ev);
  return (
    held(ev, name) ??
    notReady(ev, name) ??
    evicted(ev, name) ??
    kubeOom(ev, name) ??
    nodeRestarted(ev, name) ??
    kubeStrained(ev, name)
  );
}

const pctOf = (r: number | null | undefined) =>
  r === null || r === undefined ? null : Math.round(r * 100);

function silent(ev: Evidence, name: string): Match | null {
  for (const c of ev.containers) {
    const h = ev.hosts.find((x) => x.name === c.host);
    if (!h || h.status === 'active') continue;
    const minutes = h.lastSeenAt
      ? Math.max(1, Math.round((ev.now - ms(h.lastSeenAt)) / 60_000))
      : null;
    const last: Step = {
      object: containerRef(c),
      source: 'docker',
      code: 'last_report',
      facts: { state: c.state },
      at: h.lastSeenAt,
      since: null,
      next: 'because',
    };
    const host: Step = {
      object: nodeObject(h.name, 'docker'),
      source: 'docker',
      code: h.lastSeenAt ? 'host_silent' : 'host_never',
      facts: h.lastSeenAt ? { host: h.name, minutes } : { host: h.name },
      at: null,
      since: h.lastSeenAt,
      next: null,
    };
    return {
      code: 'node_or_host',
      facts: { name, host: h.name, how: 'silent', minutes, platform: 'docker' },
      since: h.lastSeenAt,
      chain: [last, host],
      complete: true,
      headline: h.lastSeenAt
        ? { code: 'node_or_host_silent', facts: { name, host: h.name, minutes } }
        : { code: 'node_or_host_never', facts: { name, host: h.name } },
      explains: ['host'] as CheckTopic[],
    };
  }
  return null;
}

/** A container OOM-killed in the window (its kills, an OOMKilled event, or stopped so). */
function dockerKilled(ev: Evidence, c: EvContainer): boolean {
  const from = ms(ev.window.from);
  const kills = oomKills(ev, c);
  const event = containerEvents(ev, c).some(
    (e) => e.reason === 'OOMKilled' && ms(e.lastSeen) >= from,
  );
  return !!kills?.n || event || (c.oomKilled && c.state !== 'running');
}

function dockerOom(ev: Evidence, name: string): Match | null {
  for (const c of ev.containers) {
    if (!dockerKilled(ev, c)) continue;
    const h = ev.hosts.find((x) => x.name === c.host);
    const full = (h?.memoryUtilization ?? 0) >= HOST_FULL_RATIO;
    const limit = c.memoryLimitBytes;
    const top = peak(ev, `${c.host}/${c.name}`);
    const f = oomFor(full, limit, top);
    if (!f) continue;
    const kills = oomKills(ev, c);
    const kill: Step = {
      object: containerRef(c),
      source: 'docker',
      ...killStep(c.name, limit, top),
      at: iso(kills?.last) ?? c.finishedAt,
      since: null,
      next: 'because',
    };
    const used = pctOf(h?.memoryUtilization);
    const host: Step = {
      object: nodeObject(c.host, 'docker'),
      source: 'docker',
      code: used === null ? 'host_ran_out' : 'host_memory',
      facts: used === null ? { host: c.host } : { host: c.host, pct: used },
      at: null,
      since: null,
      next: null,
    };
    return {
      code: 'node_or_host',
      facts: { name, host: c.host, how: 'oom', container: c.name, platform: 'docker' },
      since: earliest(iso(kills?.first), c.finishedAt),
      chain: [kill, host],
      complete: f.complete,
      headline: limit
        ? { code: 'node_or_host_oom_host_full', facts: { name, host: c.host, limitBytes: limit } }
        : { code: 'node_or_host_oom_host', facts: { name, host: c.host } },
      explains: ['self', 'events', 'host'],
      ...(f.complete ? { covers: ['oom_limit'] as RuleCode[] } : {}),
    };
  }
  return null;
}

/** A nearly full host under a container that fails: partial. */
function dockerStrained(ev: Evidence, name: string): Match | null {
  for (const c of ev.containers) {
    const h = ev.hosts.find((x) => x.name === c.host);
    if (!h) continue;
    const what =
      (h.diskUtilization ?? 0) >= HOST_FULL_RATIO
        ? { code: 'host_disk', pct: pctOf(h.diskUtilization) }
        : (h.memoryUtilization ?? 0) >= HOST_FULL_RATIO
          ? { code: 'host_memory', pct: pctOf(h.memoryUtilization) }
          : null;
    if (!what) continue;
    const restarts = containerRestarts(ev, c)?.n ?? 0;
    const failing = restarts > 0 || c.restarting || (c.state !== 'running' && c.exitCode !== 0);
    if (!failing) continue;
    const facts: Facts = { host: h.name, pct: what.pct };
    return {
      code: 'node_or_host',
      facts: {
        name,
        host: h.name,
        how: what.code === 'host_disk' ? 'disk' : 'memory',
        platform: 'docker',
      },
      since: null,
      chain: [
        {
          object: containerRef(c),
          source: 'docker',
          code: 'on_host',
          facts: { host: h.name, state: c.state },
          at: null,
          since: null,
          next: 'because',
        },
        {
          object: nodeObject(h.name, 'docker'),
          source: 'docker',
          code: what.code,
          facts,
          at: null,
          since: null,
          next: null,
        },
      ],
      complete: false,
      headline: { code: `node_or_host_${what.code}`, facts: { name, ...facts } },
      explains: ['host'],
    };
  }
  return null;
}

/** A container its host's reboot or its daemon's restart stopped, still stopped. */
function hostRestarted(ev: Evidence, name: string): Match | null {
  for (const c of ev.containers) {
    const w = c.stoppedWith;
    if (!w || c.state === 'running' || c.state === 'restarting') continue;
    const stopped: Step = {
      object: containerRef(c),
      source: 'docker',
      code: 'stopped_with_host',
      facts: { exitCode: c.exitCode },
      at: c.finishedAt,
      since: null,
      next: 'because',
    };
    const host: Step = {
      object: nodeObject(c.host, 'docker'),
      source: 'docker',
      code: w.how === 'host' ? 'host_rebooted' : 'docker_restarted',
      facts: { host: c.host },
      at: w.at,
      since: null,
      next: null,
    };
    return {
      code: 'node_or_host',
      facts: {
        name,
        host: c.host,
        how: w.how === 'host' ? 'rebooted' : 'docker_restarted',
        container: c.name,
        platform: 'docker',
        at: w.at,
      },
      since: w.at,
      chain: [stopped, host],
      complete: true,
      headline: {
        code: w.how === 'host' ? 'node_or_host_host_restarted' : 'node_or_host_docker_restarted',
        facts: { name, host: c.host, at: w.at },
      },
      explains: ['self', 'events', 'host'],
      covers: ['crash_exit'] as RuleCode[],
    };
  }
  return null;
}

function docker(ev: Evidence): Match | null {
  const name = shortName(ev);
  return (
    silent(ev, name) ?? dockerOom(ev, name) ?? hostRestarted(ev, name) ?? dockerStrained(ev, name)
  );
}

export const nodeOrHost: Rule = {
  code: 'node_or_host',
  platforms: ['kubernetes', 'docker'],
  applies: (f) => ['pod', 'workload', 'container', 'compose_service'].includes(f.kind),
  match: (ev) => (ev.platform === 'docker' ? docker(ev) : kube(ev)),
  explains: ['node', 'host'],
};
