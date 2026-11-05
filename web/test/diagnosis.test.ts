// SPDX-License-Identifier: AGPL-3.0-only
import type { DockerContainer } from '@watchlog/api-types';
import { describe, expect, it } from 'vitest';
import { createAppI18n } from '@/i18n';
import { badState, cpuShare, exitMeaning, reasonLine } from '@/lib/diagnosis';
import { container, CRASHLOOP, OOM, UNHEALTHY, UNHEALTHY_DETAIL } from './docker-fixtures';

const { t } = createAppI18n().global as unknown as {
  t: (key: string, params?: Record<string, unknown>, plural?: number) => string;
};
const NOW = Date.parse('2026-10-31T06:29:16.696Z'); // 9 minutes after fx-unhealthy turned
const C = (x: object) => x as DockerContainer;

describe('exit code meanings', () => {
  it.each([
    [0, 'completed normally'],
    [1, 'application error'],
    [126, 'command is not executable'],
    [127, 'command not found'],
    [137, 'killed (SIGKILL)'],
    [139, 'segmentation fault (SIGSEGV)'],
    [143, 'stopped (SIGTERM)'],
    [130, 'interrupted (SIGINT)'],
    [129, 'terminated by signal 1'],
    [3, 'application-specific exit code'],
    [255, 'application-specific exit code'],
  ])('%i → %s', (code, text) => {
    const m = exitMeaning(code);
    expect(t(m.key, m.params)).toBe(text);
  });
});

describe('bad state and one-line reason', () => {
  it('ranks restarting, dead, exited and unhealthy; healthy has none', () => {
    expect(badState(CRASHLOOP)).toBe('restarting');
    expect(badState({ state: 'dead', health: null })).toBe('dead');
    expect(badState(OOM)).toBe('exited');
    expect(badState(UNHEALTHY)).toBe('unhealthy');
    expect(badState({ state: 'running', health: 'healthy' })).toBeNull();
    expect(reasonLine(C(container('ok')), t, NOW)).toBeNull();
  });

  it('explains each state in one line', () => {
    expect(reasonLine(C(UNHEALTHY), t, NOW)).toBe(
      'Health check failing for 9m · 3 consecutive failures',
    );
    expect(reasonLine(C(OOM), t, NOW)).toBe(
      'Exited with code 137 · killed (SIGKILL) · out of memory (OOM killed)',
    );
    expect(reasonLine(C(CRASHLOOP), t, NOW)).toBe(
      'Restarting · 4 restarts · last exit 2 (invalid usage or shell error)',
    );
    const estimated = {
      ...UNHEALTHY,
      healthDetail: { ...UNHEALTHY_DETAIL, sinceEstimated: true, failingStreak: 1 },
    };
    expect(reasonLine(C(estimated), t, NOW)).toBe(
      'Health check failing for at least 9m · 1 consecutive failure',
    );
    expect(reasonLine(C({ ...UNHEALTHY, healthDetail: null }), t, NOW)).toBe(
      'Health check failing',
    );
  });
});

describe('cpuShare', () => {
  it('divides by the CPU limit when set, else by one core', () => {
    const usage = [
      [100, 0.25],
      [115, null],
      [130, 0.5],
    ];
    expect(cpuShare(usage, [[100, 0.5]])).toEqual({
      points: [
        [100, 0.5],
        [115, null],
        [130, 1],
      ],
      limitCores: 0.5,
    });
    expect(cpuShare(usage, undefined)).toEqual({ points: usage, limitCores: null });
  });
});
