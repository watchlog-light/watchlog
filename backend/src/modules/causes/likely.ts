// SPDX-License-Identifier: AGPL-3.0-only
// The likely cause in other answers (ADR-148, ADR-155): the alert detail, each problem of
// Needs attention and each application with a finding carry `likelyCause`, the short form
// of GET /causes's top cause when it is likely (possible and no clear cause leave it out).
// One CausesService per backend holds the 15 s answer cache that GET /causes, these fields
// and MCP share, and keeps a list's work bounded: at most LIST_MAX subjects, LIST_WORKERS
// at a time per list and LIST_SLOTS in the whole process, within LIST_BUDGET_MS.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiReader } from '../mcp/reader.js';
import { AnswerCache } from './cache.js';
import { explain, type CausesAnswer } from './engine.js';
import type { Reader } from './evidence.js';
import { memoReader } from './gather.js';
import type { ClusterRef } from './resolve.js';
import { formatSubject, type Subject } from './subject.js';
import type { Facts, Sentence } from './types.js';

/** The top cause, short: the panel (GET /causes) has the chain and what was checked. */
export interface LikelyCause {
  /** The catalog rule (ADR-150). */
  rule: string;
  code: string;
  facts: Facts;
  /** When the cause began; null when the evidence doesn't say. */
  since: string | null;
  /** The answer's first sentence (causes.headline.<code>). */
  headline: Sentence;
  /** GET /causes?cluster=<the cluster>&subject=<this>: the whole answer. */
  subject: string;
}

/** An answer's likely cause, short; undefined when the answer is possible or none. */
export function likelyCause(a: CausesAnswer): LikelyCause | undefined {
  if (a.state !== 'likely') return undefined;
  const top = a.causes.find((c) => c.strength === 'likely');
  if (!top) return undefined;
  return {
    rule: top.rule,
    code: top.code,
    facts: top.facts,
    since: top.since,
    headline: a.headline,
    subject: `${a.subject.kind}:${a.subject.ref}`,
  };
}

/**
 * Sent on the in-process reads the engine makes: the answers it reads (the overview, the
 * alert, the applications) leave `likelyCause` out, so a cause never asks for causes. Any
 * caller may send it to skip the work; the field is optional.
 */
export const NO_CAUSE_HEADER = 'x-watchlog-no-cause';

/** Whether this request's answer should carry `likelyCause`. */
export const wantsCause = (request: FastifyRequest) => request.headers[NO_CAUSE_HEADER] !== '1';

/** The reader explain() uses for a request: as its caller, the answers without causes. */
export const causeReader = (app: FastifyInstance, request: FastifyRequest): Reader =>
  ApiReader.forRequest(app, request, { [NO_CAUSE_HEADER]: '1' });

/** Subjects a list answer explains at most: the first ones (lists come worst first). */
export const LIST_MAX = 20;
/** Uncached answers one list computes at a time. */
export const LIST_WORKERS = 4;
/** Uncached answers all lists compute at a time, in the whole process. */
export const LIST_SLOTS = 8;
/**
 * How long a list waits for its causes. An answer not ready by then is left out of that
 * response; one already started still finishes into the cache, for the next refresh.
 */
export const LIST_BUDGET_MS = 2_000;

export interface ListJob {
  cluster: ClusterRef;
  subject: Subject;
}

export interface CausesServiceOptions {
  cache?: AnswerCache<CausesAnswer>;
  explainFn?: typeof explain;
  listMax?: number;
  workers?: number;
  slots?: number;
  budgetMs?: number;
}

export class CausesService {
  readonly cache: AnswerCache<CausesAnswer>;
  private readonly explainFn: typeof explain;
  private readonly listMax: number;
  private readonly workers: number;
  private readonly budgetMs: number;
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(opts: CausesServiceOptions = {}) {
    this.cache = opts.cache ?? new AnswerCache<CausesAnswer>();
    this.explainFn = opts.explainFn ?? explain;
    this.listMax = opts.listMax ?? LIST_MAX;
    this.workers = opts.workers ?? LIST_WORKERS;
    this.budgetMs = opts.budgetMs ?? LIST_BUDGET_MS;
    this.free = opts.slots ?? LIST_SLOTS;
  }

  private key(orgId: string, cluster: ClusterRef, subject: Subject) {
    return `${orgId}\u0000${cluster.id}\u0000${formatSubject(subject)}`;
  }

  /** One subject's answer, kept 15 s (GET /causes, MCP). */
  answer(reader: Reader, orgId: string, cluster: ClusterRef, subject: Subject) {
    return this.cache.get(this.key(orgId, cluster, subject), () =>
      this.explainFn(reader, cluster, subject),
    );
  }

  /**
   * The likely cause of each job, in order (undefined: none likely, not explained, or not
   * ready within the budget). The same subject twice is explained once; the reads every
   * answer makes (the overview, the alerts, the lists) are made once for the whole list.
   */
  async likely(
    reader: Reader,
    orgId: string,
    jobs: ListJob[],
  ): Promise<(LikelyCause | undefined)[]> {
    const out: (LikelyCause | undefined)[] = new Array(jobs.length).fill(undefined);
    const keys = jobs.map((j) => this.key(orgId, j.cluster, j.subject));
    const unique = [...new Set(keys)].slice(0, this.listMax);
    if (unique.length === 0) return out;
    const shared = memoReader(reader);
    const found = new Map<string, LikelyCause | undefined>();
    const deadline = Date.now() + this.budgetMs;
    let next = 0;
    const work = async () => {
      while (next < unique.length) {
        const key = unique[next++]!;
        const job = jobs[keys.indexOf(key)]!;
        const release = await this.slot(deadline);
        if (!release) return;
        try {
          const a = await this.cache.get(key, () =>
            this.explainFn(shared, job.cluster, job.subject),
          );
          found.set(key, likelyCause(a));
        } catch {
          // A subject that can't be explained (gone, ambiguous) has no likely cause.
        } finally {
          release();
        }
      }
    };
    const all = Promise.all(Array.from({ length: Math.min(this.workers, unique.length) }, work));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      all,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      }),
    ]);
    clearTimeout(timer);
    keys.forEach((k, i) => (out[i] = found.get(k)));
    return out;
  }

  /** A slot for one uncached answer; null when the deadline passed while waiting. */
  private async slot(deadline: number): Promise<(() => void) | null> {
    if (this.free === 0) {
      const ready = new Promise<void>((resolve) => this.waiting.push(resolve));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), Math.max(0, deadline - Date.now()));
      });
      const won = await Promise.race([ready.then(() => 'ready' as const), late]);
      clearTimeout(timer);
      if (won === 'late') {
        // Hand a slot freed later on to the next waiter instead.
        void ready.then(() => this.release());
        return null;
      }
    } else this.free--;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.release();
    };
  }

  private release() {
    const w = this.waiting.shift();
    if (w) w();
    else this.free++;
  }
}

/** A Needs-attention problem as GET /causes is asked about it: its alert, pod or container. */
export function problemSubject(
  p: {
    alertId: string | null;
    object: { kind: string; namespace: string | null; name: string } | null;
  },
  platform: ClusterRef['kind'],
): Subject | null {
  if (p.alertId) return { kind: 'alert', id: p.alertId };
  const o = p.object;
  if (!o) return null;
  if (platform === 'kubernetes' && o.kind === 'Pod' && o.namespace)
    return { kind: 'pod', namespace: o.namespace, name: o.name };
  // Docker problems name the container's host in `namespace`.
  if (platform === 'docker' && o.kind === 'Container' && o.namespace)
    return { kind: 'container', host: o.namespace, name: o.name };
  // Nodes and volumes are no subject (ADR-146).
  return null;
}
