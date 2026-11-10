// SPDX-License-Identifier: AGPL-3.0-only
// unschedulable (ADR-150 #6, Kubernetes only, ADR-149): a pod stays Pending on no node, and
// the scheduler's FailedScheduling event in the window says why: not enough CPU or memory (or
// another resource) free for its requests, no node matching its node selector or affinity,
// taints it doesn't tolerate. The chain: Pending (the symptom), the scheduler's reason (where
// it starts).
//
// Precedence with node_or_host (slice 4): when the scheduler names cordoned nodes ("node(s)
// were unschedulable"), the drain or cordon is where it starts (the node-drain scenario:
// `pinned` is held to the cordoned node by its selector). This rule then says so as a partial
// chain (possible at best), and node_or_host, with the cordon in its own chain, ranks first
// once it exists: a complete chain outranks a partial one before the catalog's order is
// asked (rank.ts). Docker has no form: a container Compose can't start never reaches the agent.
import { shortName } from '../checks.js';
import type { EvEvent, EvPod, Evidence } from '../evidence.js';
import type { Match, Rule } from '../rules.js';
import type { Facts, Step } from '../types.js';
import { earliest, podEvents, podRef } from './common.js';

export type SchedulingReason =
  'cpu' | 'memory' | 'resource' | 'selector' | 'taint' | 'cordoned' | 'other';

export interface Scheduling {
  /** Nodes the scheduler looked at ("0/3 nodes are available"). */
  nodes: number | null;
  reasons: { reason: SchedulingReason; n: number; detail: string | null }[];
  /** The scheduler's own summary, without the preemption part. */
  message: string;
}

const PATTERNS: [RegExp, SchedulingReason][] = [
  [/^(\d+) Insufficient cpu$/i, 'cpu'],
  [/^(\d+) Insufficient memory$/i, 'memory'],
  [/^(\d+) Insufficient (\S+)$/i, 'resource'],
  [/^(\d+) node\(s\) didn't match Pod's node affinity\/selector$/i, 'selector'],
  [/^(\d+) node\(s\) didn't match (?:pod )?(?:anti-)?affinity rules$/i, 'selector'],
  [/^(\d+) node\(s\) had untolerated taints?(?:\(s\))?(?: \{(.*)\})?$/i, 'taint'],
  [/^(\d+) node\(s\) had taints? that the pod didn't tolerate(?: \{(.*)\})?$/i, 'taint'],
  [/^(\d+) node\(s\) were unschedulable$/i, 'cordoned'],
];

/**
 * The scheduler's FailedScheduling message, read: "0/3 nodes are available: 1 node(s) had
 * untolerated taint(s), 2 Insufficient cpu. preemption: …" (measured on kind 1.37; older
 * schedulers name the taint in braces). Exported for node_or_host (slice 4).
 */
export function schedulingReasons(message: string): Scheduling {
  const head = message
    .split(/\.\s*preemption:/i)[0]!
    .trim()
    .replace(/\.$/, '');
  const m = /^(\d+)\/(\d+) nodes are available:\s*(.*)$/s.exec(head);
  const nodes = m ? Number(m[2]) : null;
  const reasons: Scheduling['reasons'] = [];
  for (const part of (m ? m[3]! : head).split(/,\s*(?=\d+ )/)) {
    const p = part.trim();
    const hit = PATTERNS.map(([re, reason]) => [re.exec(p), reason] as const).find(([x]) => x);
    if (hit) {
      const [x, reason] = hit;
      reasons.push({
        reason,
        n: Number(x![1]),
        detail: reason === 'resource' ? x![2]! : reason === 'taint' ? (x![2] ?? null) : null,
      });
    } else if (p) {
      const n = /^(\d+) /.exec(p);
      reasons.push({ reason: 'other', n: n ? Number(n[1]) : 0, detail: p });
    }
  }
  return { nodes, reasons, message: head };
}

/** What keeps it off most nodes: a resource, the selector, then taints (often the control plane). */
const ORDER: SchedulingReason[] = ['cpu', 'memory', 'resource', 'selector', 'other', 'taint'];

export function mainReason(s: Scheduling): Scheduling['reasons'][number] | null {
  const cordoned = s.reasons.find((r) => r.reason === 'cordoned');
  if (cordoned) return cordoned;
  return (
    [...s.reasons].sort(
      (a, b) => b.n - a.n || ORDER.indexOf(a.reason) - ORDER.indexOf(b.reason),
    )[0] ?? null
  );
}

function reasonFacts(
  r: Scheduling['reasons'][number],
  s: Scheduling,
  p: EvPod,
): { code: string; facts: Facts } {
  const counts = { n: r.n, nodes: s.nodes ?? r.n };
  switch (r.reason) {
    case 'cpu':
      return p.cpuRequestCores
        ? { code: 'cpu', facts: { ...counts, requestCores: p.cpuRequestCores } }
        : { code: 'resource', facts: { ...counts, resource: 'cpu' } };
    case 'memory':
      return p.memoryRequestBytes
        ? { code: 'memory', facts: { ...counts, requestBytes: p.memoryRequestBytes } }
        : { code: 'resource', facts: { ...counts, resource: 'memory' } };
    case 'resource':
      return { code: 'resource', facts: { ...counts, resource: r.detail ?? '?' } };
    case 'other':
      return { code: 'other', facts: { message: s.message } };
    default:
      return { code: r.reason, facts: counts };
  }
}

export const unschedulable: Rule = {
  code: 'unschedulable',
  platforms: ['kubernetes'],
  applies: (f) => f.kind === 'pod' || f.kind === 'workload',
  match(ev: Evidence): Match | null {
    const from = Date.parse(ev.window.from);
    for (const p of ev.pods) {
      if (p.phase !== 'Pending' || p.node) continue;
      const e: EvEvent | undefined = podEvents(ev, p).find(
        (x) => x.reason === 'FailedScheduling' && Date.parse(x.lastSeen) >= from,
      );
      if (!e) continue;
      const s = schedulingReasons(e.message);
      const r = mainReason(s);
      if (!r) continue;
      const { code, facts } = reasonFacts(r, s, p);
      const name = shortName(ev);
      const pending: Step = {
        object: podRef(p),
        source: 'kubernetes',
        code: 'pending_unscheduled',
        facts: {},
        at: null,
        since: p.createdAt,
        next: 'because',
      };
      const why: Step = {
        object: podRef(p),
        source: 'kubernetes',
        code: `scheduling_${code}`,
        facts,
        at: e.lastSeen,
        since: null,
        next: null,
      };
      return {
        code: 'unschedulable',
        facts: { name, reason: r.reason, pod: p.name, message: s.message },
        since: earliest(e.firstSeen, p.createdAt),
        chain: [pending, why],
        // A cordoned node is where it starts: node_or_host's (see above).
        complete: r.reason !== 'cordoned',
        headline: {
          code: `unschedulable_${code}`,
          facts: code === 'other' ? { name, message: s.message } : { name, ...facts },
        },
      };
    }
    return null;
  },
  explains: ['self', 'events'],
};
