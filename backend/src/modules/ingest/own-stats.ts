// SPDX-License-Identifier: AGPL-3.0-only
// What ingest did with the calls that carry an own-metrics token (1.0.3): how many it took,
// refused for the token's or the org's rate limit, and shed under pressure, for pushes and for
// remote write. Counted in memory since the process started; `render` gives them in the
// Prometheus text format. The log gets one line a minute at most while calls are refused,
// never one per call.
import type { FastifyBaseLogger } from 'fastify';

export const OWN_CALL_KINDS = ['push', 'remote_write'] as const;
export type OwnCallKind = (typeof OWN_CALL_KINDS)[number];
/** `accepted`: passed the limits (its body may still be refused). */
export const OWN_CALL_RESULTS = ['accepted', 'limited_token', 'limited_org', 'shed'] as const;
export type OwnCallResult = (typeof OWN_CALL_RESULTS)[number];

export type OwnCallCounts = Record<OwnCallKind, Record<OwnCallResult, number>>;

declare module 'fastify' {
  interface FastifyInstance {
    /** What ingest did with own-metrics calls: taken, limited, shed (1.0.3). */
    ownIngestStats: OwnIngestStats;
  }
}

const zero = (): OwnCallCounts => ({
  push: { accepted: 0, limited_token: 0, limited_org: 0, shed: 0 },
  remote_write: { accepted: 0, limited_token: 0, limited_org: 0, shed: 0 },
});

const LOG_EVERY_MS = 60_000;
export const OWN_CALLS_METRIC = 'watchlog_backend_own_metric_calls_total';

export class OwnIngestStats {
  private readonly total = zero();
  /** Since the last log line. */
  private recent = zero();
  private shedReason: string | null = null;
  private loggedAt = -Infinity;

  constructor(
    private readonly log: Pick<FastifyBaseLogger, 'warn' | 'info'>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one call; `reason` is the pressure's, for a shed one. */
  count(kind: OwnCallKind, result: OwnCallResult, reason?: string): void {
    this.total[kind][result]++;
    this.recent[kind][result]++;
    if (result === 'accepted') return;
    if (result === 'shed') this.shedReason = reason ?? null;
    this.report();
  }

  /**
   * Says in the log what was refused since the last line, a minute apart at most. Called on
   * each refusal and once a minute, so the last refusals of a burst are reported too.
   */
  report(): void {
    const { push, remote_write: write } = this.recent;
    const shed = push.shed + write.shed;
    const limited = push.limited_token + push.limited_org + write.limited_token + write.limited_org;
    if (shed + limited === 0 || this.now() - this.loggedAt < LOG_EVERY_MS) return;
    this.loggedAt = this.now();
    const counts = { pushes: { ...push }, remoteWrites: { ...write } };
    if (shed > 0) {
      this.log.warn(
        { reason: this.shedReason, ...counts },
        'under pressure: shedding own-metric pushes and remote write; agents and collectors are still taken',
      );
    } else {
      this.log.info(counts, 'own-metric calls over a rate limit were refused');
    }
    this.recent = zero();
    this.shedReason = null;
  }

  /** The counts since the process started. */
  snapshot(): OwnCallCounts {
    return { push: { ...this.total.push }, remote_write: { ...this.total.remote_write } };
  }

  /** The counts as Prometheus text. */
  render(): string {
    const lines = [
      `# HELP ${OWN_CALLS_METRIC} Calls with an own-metrics token, by what ingest did with them.`,
      `# TYPE ${OWN_CALLS_METRIC} counter`,
    ];
    for (const kind of OWN_CALL_KINDS)
      for (const result of OWN_CALL_RESULTS)
        lines.push(
          `${OWN_CALLS_METRIC}{kind="${kind}",result="${result}"} ${this.total[kind][result]}`,
        );
    return lines.join('\n') + '\n';
  }
}
