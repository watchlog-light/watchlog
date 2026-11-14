// SPDX-License-Identifier: AGPL-3.0-only
// The per-org active-series cap at ingest (security review SR-3, ADR-177), Cloud only. Every
// org writes into the same VictoriaMetrics, so one org sending a flood of new series (random
// label values) would fill its memory for everyone. Each org gets a cap on the distinct
// series it sent in the last one to two hours:
//
//   - a plan with a node limit (Free's 5, an Enterprise contract, a Pro org staff gave a
//     number): that many nodes × SERIES_PER_NODE (Free: 25,000; a real node sends about
//     1,000 to 1,500);
//   - a plan without one (Pro): the node and Docker agents seen in the window, plus
//     HEADROOM_NODES, × SERIES_PER_NODE, at most SERIES_CEILING. A larger org needs staff to
//     set its node count in its entitlements.
//
// The count is a HyperLogLog sketch per org (4,096 registers, about 1.6 % error) over a hash
// of each series' labels, which the remote_write reader computes while it validates
// (ADR-026). Two windows of an hour: the estimate covers the current and the previous one.
// Below the cap every write passes. At the cap a write passes only if none of its series
// would raise the sketch, that is, only series already counted keep flowing; a write with
// new series gets 402 (the agent drops it, ADR-022) until old series age out of the window.
// Everything is in memory, per backend process; nothing waits for PostgreSQL except an
// org's entitlements, which EntitlementsService caches for 60 seconds.
import { isNodeAgent } from './node-gate.js';
import type { EntitlementsService } from './service.js';

export const SERIES_PER_NODE = 5_000;
export const HEADROOM_NODES = 10;
export const SERIES_CEILING = 300_000;
const WINDOW_MS = 3_600_000;
const SWEEP_MS = 10 * 60_000;
const LOG_EVERY_MS = 3_600_000;

const P = 12;
const M = 1 << P;
const ALPHA = 0.7213 / (1 + 1.079 / M);

interface Sketch {
  /** The current window's registers. */
  cur: Uint8Array;
  /** max(previous window, current window): what the estimate reads. */
  merged: Uint8Array;
  /** Σ 2^-merged[j] and the zero registers, kept up to date as registers rise. */
  sum: number;
  zeros: number;
  windowStart: number;
  /** Node and Docker agents seen (cluster + agent id), this window and the previous one. */
  agents: Set<string>;
  prevAgents: Set<string>;
  loggedAt: number;
}

function emptySketch(now: number): Sketch {
  return {
    cur: new Uint8Array(M),
    merged: new Uint8Array(M),
    sum: M,
    zeros: M,
    windowStart: now,
    agents: new Set(),
    prevAgents: new Set(),
    loggedAt: 0,
  };
}

/** The register a 32-bit hash falls in, and its rank (leading zeros of the rest, + 1). */
const indexOf = (h: number) => h >>> (32 - P);
const rankOf = (h: number) => Math.min(Math.clz32((h << P) | 0) + 1, 32 - P + 1);

export interface SeriesVerdict {
  ok: boolean;
  /** The org's cap and the sketch's estimate before this write. */
  cap: number;
  estimate: number;
}

export interface SeriesLogger {
  warn(obj: object, msg: string): void;
}

export class SeriesGate {
  private readonly orgs = new Map<string, Sketch>();
  private sweptAt: number;

  constructor(
    private readonly entitlements: Pick<EntitlementsService, 'get'>,
    private readonly log: SeriesLogger,
    private readonly now: () => number = Date.now,
  ) {
    this.sweptAt = now();
  }

  /** The org's cap for a node limit (null: none) and the agents it has sent from. */
  static capFor(nodes: number | null, agentsSeen: number): number {
    if (nodes !== null) return Math.max(nodes, 1) * SERIES_PER_NODE;
    return Math.min(SERIES_CEILING, (agentsSeen + HEADROOM_NODES) * SERIES_PER_NODE);
  }

  /** The sketch's estimate of an org's distinct series in the window (tests, the log). */
  estimate(orgId: string): number {
    const s = this.orgs.get(orgId);
    return s ? estimateOf(s) : 0;
  }

  /**
   * Whether a write of these series (label hashes, from inspectWriteRequest) may be stored.
   * Counts them when it may.
   */
  async admit(
    orgId: string,
    clusterId: string,
    agentId: string,
    hashes: Uint32Array,
  ): Promise<SeriesVerdict> {
    const ent = await this.entitlements.get(orgId);
    const now = this.now();
    this.sweep(now);
    let s = this.orgs.get(orgId);
    if (!s) this.orgs.set(orgId, (s = emptySketch(now)));
    else rotate(s, now);
    if (isNodeAgent(agentId)) s.agents.add(`${clusterId}\u0000${agentId}`);
    const seen = s.agents.size + [...s.prevAgents].filter((a) => !s.agents.has(a)).length;
    const cap = SeriesGate.capFor(ent.nodes, seen);
    const estimate = estimateOf(s);
    if (estimate >= cap && raisesAny(s.merged, hashes)) {
      if (now - s.loggedAt >= LOG_EVERY_MS) {
        s.loggedAt = now;
        this.log.warn({ orgId, cap, estimate: Math.round(estimate) }, 'org over its series cap');
      }
      return { ok: false, cap, estimate };
    }
    add(s, hashes);
    return { ok: true, cap, estimate };
  }

  /** Drops the sketches of orgs that sent nothing for two windows. */
  private sweep(now: number): void {
    if (now - this.sweptAt < SWEEP_MS) return;
    this.sweptAt = now;
    for (const [org, s] of this.orgs)
      if (now - s.windowStart >= 2 * WINDOW_MS) this.orgs.delete(org);
  }
}

function estimateOf(s: Sketch): number {
  const raw = (ALPHA * M * M) / s.sum;
  if (raw <= 2.5 * M && s.zeros > 0) return M * Math.log(M / s.zeros);
  return raw;
}

/** A new window: the current one becomes the previous one (or both go, after two). */
function rotate(s: Sketch, now: number): void {
  const age = now - s.windowStart;
  if (age < WINDOW_MS) return;
  if (age >= 2 * WINDOW_MS) {
    Object.assign(s, emptySketch(now), { loggedAt: s.loggedAt });
    return;
  }
  s.merged = s.cur;
  s.cur = new Uint8Array(M);
  s.prevAgents = s.agents;
  s.agents = new Set();
  s.windowStart = now;
  let sum = 0;
  let zeros = 0;
  for (let j = 0; j < M; j++) {
    const r = s.merged[j]!;
    sum += 2 ** -r;
    if (r === 0) zeros++;
  }
  s.sum = sum;
  s.zeros = zeros;
}

function raisesAny(merged: Uint8Array, hashes: Uint32Array): boolean {
  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i]!;
    if (rankOf(h) > merged[indexOf(h)]!) return true;
  }
  return false;
}

function add(s: Sketch, hashes: Uint32Array): void {
  const { cur, merged } = s;
  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i]!;
    const j = indexOf(h);
    const r = rankOf(h);
    if (r > cur[j]!) cur[j] = r;
    const old = merged[j]!;
    if (r > old) {
      merged[j] = r;
      s.sum += 2 ** -r - 2 ** -old;
      if (old === 0) s.zeros--;
    }
  }
}
