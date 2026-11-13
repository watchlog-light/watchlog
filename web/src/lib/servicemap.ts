// SPDX-License-Identifier: AGPL-3.0-only
// Words for the service map (SPEC §4.5): rates, latencies, health tones and reasons.
// Shared by the map, the tables and the detail panel so they always agree.
import type { ServiceMapEdge } from '@watchlog/api-types';
import type { Tone } from '@/lib/kube';

type T = (key: string, values?: Record<string, unknown>) => string;

export const HEALTH_TONE: Record<string, Tone> = {
  ok: 'ok',
  warning: 'warning',
  critical: 'critical',
  idle: 'neutral',
  unknown: 'neutral',
};

const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;

/** Per-second rates: "12/s", "0.5/s", "< 0.01/s". */
export function perSecond(v: number): string {
  if (v === 0) return '0/s';
  if (v < 0.01) return '< 0.01/s';
  return `${v < 10 ? v.toFixed(2).replace(/\.?0+$/, '') : Math.round(v)}/s`;
}

export function latency(v: number | null): string {
  if (v === null) return '–';
  return v < 1 ? `${(v * 1000).toFixed(v < 0.01 ? 1 : 0)} ms` : `${v.toFixed(2)} s`;
}

export interface EdgeContext {
  target: { ready: number; desired: number; changedAt: string } | null;
  alert: { id: string; since: string } | null;
}

/**
 * Why an edge is unhealthy, in words: the failed share or the slow p95, and what the
 * target looks like ("catalog has 0 ready pods since 19:21"). Only what was measured:
 * the kernel counts failed connects, not their reason.
 */
export function edgeReason(
  e: ServiceMapEdge,
  target: string,
  ctx: EdgeContext | null,
  t: T,
  time: (iso: string) => string,
): { lead: string; detail: string | null } | null {
  if (e.health !== 'critical' && e.health !== 'warning') return null;
  const failed = e.failedRatio ?? 0;
  const errors = e.http?.serverErrorRatio ?? 0;
  // Requests Traefik answered itself, no server up (ADR-165): eBPF never sees them.
  const answered = e.answeredByProxy?.perSecond ?? 0;
  const lead =
    answered > 0
      ? t('serviceMap.proxy.answered', { rate: perSecond(answered) })
      : failed >= 0.01
        ? t(`serviceMap.reason.failed.${e.health}`, { pct: pct(failed) })
        : errors >= 0.01
          ? t(`serviceMap.reason.errors.${e.health}`, { pct: pct(errors) })
          : t('serviceMap.reason.slow', { p95: latency(e.latencyP95Seconds) });
  const tg = ctx?.target;
  let detail: string | null = null;
  if (tg && tg.desired === 0)
    detail = t('serviceMap.reason.scaledToZero', { name: target, time: time(tg.changedAt) });
  else if (tg && tg.ready === 0)
    detail = t('serviceMap.reason.noneReady', { name: target, time: time(tg.changedAt) });
  else if (tg && tg.ready < tg.desired)
    detail = t('serviceMap.reason.someReady', {
      name: target,
      ready: tg.ready,
      desired: tg.desired,
    });
  return { lead, detail };
}
