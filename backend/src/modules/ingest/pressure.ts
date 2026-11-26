// SPDX-License-Identifier: AGPL-3.0-only
// Whether the backend is under pressure now (1.0.3). While it is, ingest refuses a user's
// own-metric pushes and remote write (503 with Retry-After) and keeps taking what the agents
// and collectors send: WatchLog's own monitoring is never what gives way.
//
// Three signals, each with a threshold that is a setting (0 turns one off):
//
//   event loop lag     how late the loop ran its timers, the mean of the last second
//   writes in flight   remote-write calls to VictoriaMetrics that have not answered yet
//   queries waiting    for a free PostgreSQL connection
//
// They are read once a second, never per request; a request only reads the last verdict.
import { monitorEventLoopDelay } from 'node:perf_hooks';

export interface Pressure {
  /** Why own-metric calls are shed now ("event loop lag 412 ms"), or null when they aren't. */
  shedding(): string | null;
}

/** No signal is read: nothing is ever shed (tests, and the workers' in-process apps). */
export const NO_PRESSURE: Pressure = { shedding: () => null };

export interface PressureThresholds {
  eventLoopLagMs: number;
  metricWritesInFlight: number;
  dbWaiting: number;
}

export type PressureSignals = { [K in keyof PressureThresholds]: () => number };

/** One reading against the thresholds: the first signal over its threshold, in words. */
export function judge(t: PressureThresholds, s: PressureSignals): string | null {
  const lag = s.eventLoopLagMs();
  if (t.eventLoopLagMs > 0 && lag >= t.eventLoopLagMs) {
    return `event loop lag ${Math.round(lag)} ms`;
  }
  const writes = s.metricWritesInFlight();
  if (t.metricWritesInFlight > 0 && writes >= t.metricWritesInFlight) {
    return `${writes} writes to the metrics storage in flight`;
  }
  const waiting = s.dbWaiting();
  if (t.dbWaiting > 0 && waiting >= t.dbWaiting) {
    return `${waiting} queries waiting for a database connection`;
  }
  return null;
}

const RESOLUTION_MS = 20;

/**
 * Reads the signals every `everyMs` until stopped. The event loop's lag is measured here
 * unless `signals` brings its own; the other two come from the caller, which has the pools.
 */
export function watchPressure(
  thresholds: PressureThresholds,
  signals: Omit<PressureSignals, 'eventLoopLagMs'> & Partial<PressureSignals>,
  everyMs = 1000,
): Pressure & { stop(): void } {
  const loop = signals.eventLoopLagMs ? null : monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  loop?.enable();
  const all: PressureSignals = {
    metricWritesInFlight: signals.metricWritesInFlight,
    dbWaiting: signals.dbWaiting,
    eventLoopLagMs:
      signals.eventLoopLagMs ??
      (() => {
        // The histogram holds the time between two ticks: the resolution plus the lag.
        const mean = loop!.mean / 1e6 - RESOLUTION_MS;
        loop!.reset();
        return Number.isFinite(mean) ? Math.max(0, mean) : 0;
      }),
  };
  let reason: string | null = null;
  const timer = setInterval(() => {
    reason = judge(thresholds, all);
  }, everyMs);
  timer.unref();
  return {
    shedding: () => reason,
    stop() {
      clearInterval(timer);
      loop?.disable();
    },
  };
}
