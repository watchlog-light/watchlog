// SPDX-License-Identifier: AGPL-3.0-only
// Why a container is in a bad state (ADR-047): exit-code meanings and one-line reasons.
import type { DockerContainer } from '@watchlog/api-types';
import { since } from './time';

export type BadState = 'unhealthy' | 'exited' | 'dead' | 'restarting';

/** The state worth explaining, most severe first; null for a healthy or running container. */
export function badState(c: Pick<DockerContainer, 'state' | 'health'>): BadState | null {
  if (c.state === 'restarting') return 'restarting';
  if (c.state === 'dead') return 'dead';
  if (c.state === 'exited') return 'exited';
  if (c.health === 'unhealthy') return 'unhealthy';
  return null;
}

/** Codes with a fixed meaning; 128+n is "terminated by signal n" (POSIX shells, Docker). */
const KNOWN_EXIT_CODES = [0, 1, 2, 125, 126, 127, 130, 134, 137, 139, 143] as const;

export interface Translated {
  key: string;
  params?: Record<string, string | number>;
}

/** i18n key (under docker.exit) for an exit code's plain meaning. */
export function exitMeaning(code: number): Translated {
  if ((KNOWN_EXIT_CODES as readonly number[]).includes(code)) return { key: `docker.exit.${code}` };
  if (code > 128 && code < 160) return { key: 'docker.exit.signal', params: { n: code - 128 } };
  return { key: 'docker.exit.other' };
}

type Container = Pick<
  DockerContainer,
  'state' | 'health' | 'exitCode' | 'oomKilled' | 'restartCount' | 'healthDetail'
>;

/** One-line reason for a bad state (pill tooltip, containers list), or null. */
export function reasonLine(
  c: Container,
  t: (key: string, params?: Record<string, unknown>, plural?: number) => string,
  now = Date.now(),
): string | null {
  const meaning = (code: number) => {
    const m = exitMeaning(code);
    return t(m.key, m.params);
  };
  const oom = c.oomKilled ? ` · ${t('docker.diagnosis.oom')}` : '';
  switch (badState(c)) {
    case 'restarting':
      return (
        t('docker.reason.restarting', {
          restarts: t('docker.diagnosis.restarts', { n: c.restartCount }, c.restartCount),
          code: c.exitCode,
          meaning: meaning(c.exitCode),
        }) + oom
      );
    case 'exited':
    case 'dead':
      return (
        t(`docker.reason.${c.state}`, { code: c.exitCode, meaning: meaning(c.exitCode) }) + oom
      );
    case 'unhealthy':
      return unhealthySummary(c, t, now);
    default:
      return null;
  }
}

/** "Health check failing for 9m · 3 consecutive failures". */
export function unhealthySummary(
  c: Pick<DockerContainer, 'healthDetail'>,
  t: (key: string, params?: Record<string, unknown>, plural?: number) => string,
  now = Date.now(),
): string {
  const d = c.healthDetail;
  const failures = d ? t('docker.diagnosis.failures', { n: d.failingStreak }, d.failingStreak) : '';
  const head = !d?.since
    ? t('docker.reason.unhealthy')
    : d.sinceEstimated
      ? t('docker.reason.unhealthyAtLeast', { duration: since(d.since, now) })
      : t('docker.reason.unhealthyFor', { duration: since(d.since, now) });
  return failures ? `${head} · ${failures}` : head;
}

/**
 * CPU as a fraction of the container's limit, or of one core without a limit. The
 * limit series is matched by timestamp, falling back to its latest value.
 */
export function cpuShare(
  usage: (number | null)[][],
  limit: (number | null)[][] | undefined,
): { points: (number | null)[][]; limitCores: number | null } {
  const byTime = new Map((limit ?? []).map(([ts, v]) => [ts, v]));
  const latest = [...(limit ?? [])].reverse().find(([, v]) => v !== null && v! > 0)?.[1] ?? null;
  const points = usage.map(([ts, v]) => {
    const l = byTime.get(ts) ?? latest ?? 1;
    return [ts!, v === null || v === undefined ? null : v / (l > 0 ? l : 1)];
  });
  return { points, limitCores: latest };
}
