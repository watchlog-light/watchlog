// SPDX-License-Identifier: AGPL-3.0-only
// The alert-worker loop (ADR-073, ADR-087, ADR-088): every cycle it confirms its
// locks, shares the 64 org buckets with the other live workers, evaluates the orgs
// of its buckets, prunes old history once a day and records a heartbeat.
import { createServer, type Server } from 'node:http';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { withOrg } from '../../db/org-context.js';
import type { VictoriaQueryClient } from '../../lib/victoria.js';
import { evaluateOrg, type EvaluatorLookup } from './engine.js';
import { BUCKETS, LockSession, bucketOf, type LockLogger } from './locks.js';
import { prunePeriods, recordCycle } from './periods.js';

export const CYCLE_MS = 30_000;
/** A worker whose loop has not advanced for this long is not live (ADR-088). */
export const STALE_MS = 120_000;
const PRUNE_EVERY_MS = 24 * 3_600_000;

export interface WorkerLogger extends LockLogger {
  error(obj: object, msg: string): void;
}

export interface WorkerOptions {
  /** Each org's evaluation, inside withOrg (Cloud: watchlog_app under RLS, ADR-174). */
  db: Database;
  /**
   * Across orgs: listing the orgs and pruning old history (ADR-174). Community: the same as
   * `db`.
   */
  systemDb?: Database;
  databaseUrl: string;
  version: string;
  log: WorkerLogger;
  evaluators: EvaluatorLookup;
  /** Runs at the start of each org's evaluation (default rules, ADR-084). */
  prepareOrg?: (orgId: string) => Promise<void>;
  victoria?: VictoriaQueryClient;
  retentionDays: number;
  workerId?: string;
  now?: () => number;
  cycleMs?: number;
  /** Loops beside the cycle: outbox delivery, Telegram verification polling. */
  tasks?: WorkerTask[];
}

export interface WorkerTask {
  name: string;
  /** Pause between runs; a run that takes longer simply delays the next one. */
  everyMs: number;
  run(now: number): Promise<unknown>;
}

export interface CycleReport {
  buckets: number;
  orgs: number;
  evaluated: number;
  transitions: number;
  notifications: number;
  errors: string[];
}

export class AlertWorker {
  readonly id: string;
  private readonly locks: LockSession;
  private readonly now: () => number;
  private readonly startedAt: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private taskTimers = new Set<NodeJS.Timeout>();
  private taskRuns = new Set<Promise<unknown>>();
  private stopped = false;
  private lastPrune = 0;
  /** When the loop last finished a cycle, evaluating or not (liveness). */
  lastLoopAt: number;

  constructor(private readonly opts: WorkerOptions) {
    this.id = opts.workerId ?? `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.lastLoopAt = this.startedAt;
    this.locks = new LockSession(opts.databaseUrl, opts.log);
  }

  get lockPid(): number | null {
    return this.locks.pid;
  }

  get heldBuckets(): number {
    return this.locks.count;
  }

  /** One cycle. Never throws: errors are logged and recorded in the heartbeat. */
  async runCycle(): Promise<CycleReport> {
    const report: CycleReport = {
      buckets: 0,
      orgs: 0,
      evaluated: 0,
      transitions: 0,
      notifications: 0,
      errors: [],
    };
    const start = this.now();
    let evaluatedAll = false;
    try {
      if (await this.locks.ensure()) {
        await this.heartbeat();
        const live = await this.liveWorkers();
        await this.locks.rebalance(Math.ceil(BUCKETS / Math.max(1, live)), this.bucketOrder());
        report.buckets = this.locks.count;
        if (this.locks.connected) {
          await this.evaluate(report, start);
          evaluatedAll = this.locks.connected;
        }
        if (start - this.lastPrune >= PRUNE_EVERY_MS) {
          await this.prune(start);
          this.lastPrune = start;
        }
      } else {
        report.errors.push('lock connection unavailable');
      }
    } catch (err) {
      report.errors.push((err as Error).message);
      this.opts.log.error({ err: (err as Error).message }, 'alert cycle failed');
    }
    const lastError = report.errors.at(-1) ?? null;
    if (report.errors.length) {
      this.opts.log.warn({ errors: report.errors.slice(0, 10) }, 'alert cycle had errors');
    }
    try {
      await this.heartbeat({ error: lastError, evaluated: evaluatedAll, ms: this.now() - start });
    } catch (err) {
      this.opts.log.error({ err: (err as Error).message }, 'heartbeat failed');
    }
    this.lastLoopAt = this.now();
    return report;
  }

  private async evaluate(report: CycleReport, now: number): Promise<void> {
    const orgs = await this.system.selectFrom('orgs').select('id').execute();
    for (const { id } of orgs) {
      const bucket = bucketOf(id);
      if (!this.locks.holds(bucket)) continue;
      // Every query of one org's evaluation runs for that org only (ADR-174).
      const res = await withOrg(id, async () => {
        await this.opts.prepareOrg?.(id);
        return evaluateOrg(
          { db: this.opts.db, victoria: this.opts.victoria, evaluators: this.opts.evaluators },
          id,
          now,
          () => this.locks.holds(bucket),
        );
      });
      report.orgs++;
      report.evaluated += res.evaluated;
      report.transitions += res.transitions;
      report.notifications += res.notifications;
      report.errors.push(...res.errors);
    }
  }

  /** Workers whose lock session exists right now (crashes count at once, ADR-073). */
  private async liveWorkers(): Promise<number> {
    const res = await sql<{ n: string }>`
      SELECT count(*) AS n FROM alert_worker_heartbeats h
        JOIN pg_stat_activity a ON a.pid = h.lock_pid AND a.backend_start = h.lock_backend_start
       WHERE h.worker_id <> ${this.id}`.execute(this.opts.db);
    return Number(res.rows[0]!.n) + 1;
  }

  /** A per-worker order, so two workers starting together do not race for the same buckets. */
  private bucketOrder(): number[] {
    const offset = bucketOf(this.id);
    return Array.from({ length: BUCKETS }, (_, i) => (i + offset) % BUCKETS);
  }

  /** Upserts this worker's heartbeat; `end` records a finished cycle. */
  private async heartbeat(end?: { error: string | null; evaluated: boolean; ms: number }) {
    const now = new Date(this.now());
    const pid = this.locks.pid;
    const live = {
      lock_pid: pid,
      lock_backend_start: sql<Date | null>`(SELECT backend_start FROM pg_stat_activity WHERE pid = ${pid})`,
      buckets: this.locks.count,
      updated_at: now,
    };
    const finished = end
      ? {
          last_error: end.error,
          // Only a cycle that evaluated its buckets counts as alerting running (ADR-088).
          ...(end.evaluated ? { last_cycle_at: now, last_cycle_ms: end.ms } : {}),
        }
      : {};
    await this.opts.db
      .insertInto('alert_worker_heartbeats')
      .values({
        worker_id: this.id,
        version: this.opts.version,
        started_at: new Date(this.startedAt),
        ...live,
        ...finished,
      })
      .onConflict((oc) => oc.column('worker_id').doUpdateSet({ ...live, ...finished }))
      .execute();
    // Kept beyond this worker's heartbeat: when alerting ran, for alert timelines.
    if (end?.evaluated) await recordCycle(this.opts.db, now);
  }

  /** The owner's connection, for the work across orgs. */
  private get system(): Database {
    return this.opts.systemDb ?? this.opts.db;
  }

  private async prune(now: number): Promise<void> {
    const cutoff = new Date(now - this.opts.retentionDays * 86_400_000);
    const states = await this.system
      .deleteFrom('alert_states')
      .where('state', '=', 'resolved')
      .where('resolved_at', '<', cutoff)
      .executeTakeFirst();
    const notes = await this.system
      .deleteFrom('notifications')
      .where('status', 'in', ['sent', 'failed', 'dropped'])
      .where('created_at', '<', cutoff)
      .executeTakeFirst();
    await this.opts.db
      .deleteFrom('alert_worker_heartbeats')
      .where('updated_at', '<', new Date(now - 86_400_000))
      .execute();
    await prunePeriods(this.opts.db, cutoff);
    this.opts.log.info(
      { states: Number(states.numDeletedRows), notifications: Number(notes.numDeletedRows) },
      'pruned alert history',
    );
  }

  /** Runs cycles every cycleMs until stop(). */
  start(): void {
    const cycleMs = this.opts.cycleMs ?? CYCLE_MS;
    const loop = async () => {
      const began = Date.now();
      this.running = this.runCycle();
      await this.running;
      this.running = null;
      if (!this.stopped) {
        this.timer = setTimeout(() => void loop(), Math.max(0, cycleMs - (Date.now() - began)));
      }
    };
    void loop();
    for (const task of this.opts.tasks ?? []) this.startTask(task);
  }

  private startTask(task: WorkerTask): void {
    const run = async () => {
      const p = task
        .run(this.now())
        .catch((err: Error) =>
          this.opts.log.error({ task: task.name, err: err.message }, 'worker task failed'),
        );
      this.taskRuns.add(p);
      await p;
      this.taskRuns.delete(p);
      if (this.stopped) return;
      const t = setTimeout(() => {
        this.taskTimers.delete(t);
        void run();
      }, task.everyMs);
      this.taskTimers.add(t);
    };
    void run();
  }

  /** Finishes the current cycle, releases the locks and removes the heartbeat. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const t of this.taskTimers) clearTimeout(t);
    await Promise.all([this.running, ...this.taskRuns]);
    await this.locks.close();
    await this.opts.db
      .deleteFrom('alert_worker_heartbeats')
      .where('worker_id', '=', this.id)
      .execute()
      .catch(() => {});
  }

  /** Liveness: the loop advanced recently. Readiness: the lock session is up. */
  health(): { live: boolean; ready: boolean } {
    return {
      live: this.now() - this.lastLoopAt < STALE_MS,
      ready: this.locks.connected,
    };
  }

  /** `/livez` and `/readyz` for Kubernetes probes and the Compose healthcheck (ADR-088). */
  listen(host: string, port: number): Promise<Server> {
    const server = createServer((req, res) => {
      const h = this.health();
      const ok = req.url === '/livez' ? h.live : req.url === '/readyz' ? h.ready : null;
      if (ok === null) {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok, worker: this.id, version: this.opts.version }));
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server));
    });
  }
}
