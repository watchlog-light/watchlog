// SPDX-License-Identifier: AGPL-3.0-only
// The anomaly-worker's loop (ADR-197): the minute's scoring every minute, and the hour's
// baselines and housekeeping once the hour has ended (5 minutes after it, so late samples
// are in). A run that takes longer delays the next; nothing runs twice at once. /livez
// restarts a stuck loop; /readyz says the database answered on the last run.
import { createServer, type Server } from 'node:http';
import { HOUR_MS } from './stats.js';
import { runAnomalyHour, runAnomalyMinute, type AnomalyDeps, type AnomalyReport } from './jobs.js';

const MINUTE_MS = 60_000;
/** The hour's recompute waits this long after the hour, for samples still arriving. */
export const HOUR_LAG_MS = 5 * MINUTE_MS;
/** A loop that has not advanced for this long is not live. */
const STALE_MS = 10 * MINUTE_MS;

export interface AnomalyWorkerLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface AnomalyWorkerOptions {
  deps: AnomalyDeps;
  version: string;
  log: AnomalyWorkerLogger;
  now?: () => number;
}

export class AnomalyWorker {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = false;
  /** The end of the last hour whose bucket was recomputed. */
  private lastHourDone = 0;
  lastLoopAt: number;
  private ready = false;

  constructor(private readonly opts: AnomalyWorkerOptions) {
    this.now = opts.now ?? Date.now;
    this.lastLoopAt = this.now();
  }

  /** One tick: the minute's scoring, then the hour's work when an hour has ended. */
  async tick(): Promise<{ minute: AnomalyReport; hour: AnomalyReport | null }> {
    const now = this.now();
    let minute: AnomalyReport;
    let hour: AnomalyReport | null = null;
    try {
      minute = await runAnomalyMinute(this.opts.deps, now);
      const hourEnd = Math.floor((now - HOUR_LAG_MS) / HOUR_MS) * HOUR_MS;
      if (hourEnd > this.lastHourDone) {
        hour = await runAnomalyHour(this.opts.deps, now - HOUR_LAG_MS);
        this.lastHourDone = hourEnd;
        this.opts.log.info(
          { clusters: hour.clusters, series: hour.series, ms: this.now() - now },
          'anomaly baselines recomputed',
        );
      }
      this.ready = true;
    } catch (err) {
      this.ready = false;
      this.opts.log.error({ err: (err as Error).message }, 'anomaly run failed');
      minute = { orgs: 0, clusters: 0, series: 0, opened: 0, ended: 0, errors: [] };
    }
    if (minute.errors.length) {
      this.opts.log.warn({ errors: minute.errors.slice(0, 10) }, 'anomaly run had errors');
    }
    this.lastLoopAt = this.now();
    return { minute, hour };
  }

  start(): void {
    const loop = async () => {
      const began = Date.now();
      this.running = this.tick();
      await this.running;
      this.running = null;
      if (!this.stopped) {
        this.timer = setTimeout(() => void loop(), Math.max(0, MINUTE_MS - (Date.now() - began)));
      }
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  health(): { live: boolean; ready: boolean } {
    return { live: this.now() - this.lastLoopAt < STALE_MS, ready: this.ready };
  }

  /** `/livez` and `/readyz`, as the alert-worker's (ADR-088). */
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
        .end(JSON.stringify({ ok, version: this.opts.version }));
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server));
    });
  }
}
