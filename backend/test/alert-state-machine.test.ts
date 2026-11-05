// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  FLAP_QUIET_MS,
  step,
  type Episode,
  type Observation,
  type StepContext,
  type StepResult,
} from '../src/modules/alerts/state-machine.js';
import { isSilenced } from '../src/modules/alerts/silences.js';

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const CYCLE = 30_000;
const obs = (over: Partial<Observation> = {}): Observation => ({
  fingerprint: 'fp',
  severity: 'warning',
  labels: { namespace: 'wl-test', workload: 'web' },
  details: {},
  ...over,
});

/** Drives one fingerprint through cycles; `true`/Observation means the condition holds. */
function run(
  cycles: (boolean | Observation)[],
  opts: Partial<Omit<StepContext, 'now'>> & { start?: number; prev?: Episode | null } = {},
) {
  let ep: Episode | null = opts.prev ?? null;
  const notes: { at: number; kind: string }[] = [];
  const results: StepResult[] = [];
  cycles.forEach((c, i) => {
    const now = (opts.start ?? T0) + i * CYCLE;
    const res = step(ep, c === false ? null : c === true ? obs() : c, {
      now,
      forMs: opts.forMs ?? 0,
      renotifyMs: opts.renotifyMs ?? 0,
      silenced: opts.silenced ?? (() => false),
      recentFirings: opts.recentFirings ?? 0,
    });
    results.push(res);
    if (res.action === 'delete') ep = null;
    if (res.action === 'insert' || res.action === 'update') {
      ep = res.episode;
      if (res.notify) notes.push({ at: i, kind: res.notify });
    }
  });
  return { ep: ep as Episode | null, notes, results };
}

describe('alert state machine (ADR-076)', () => {
  it('stays pending until the duration has elapsed, then fires once', () => {
    const { ep, notes } = run([true, true, true, true, true], { forMs: 2 * 60_000 });
    expect(notes).toEqual([{ at: 4, kind: 'firing' }]);
    expect(ep).toMatchObject({ state: 'firing', firedAt: T0 + 4 * CYCLE, notifySeq: 1 });
  });

  it('counts the duration from the time the data gives', () => {
    const { notes } = run([obs({ since: T0 - 5 * 60_000 })], { forMs: 60_000 });
    expect(notes).toEqual([{ at: 0, kind: 'firing' }]);
  });

  it('drops a pending alert whose condition clears, without a message', () => {
    const { ep, notes, results } = run([true, false], { forMs: 120_000 });
    expect(results.map((r) => r.action)).toEqual(['insert', 'delete']);
    expect(ep).toBeNull();
    expect(notes).toEqual([]);
  });

  it('resolves after two false cycles and notifies once', () => {
    const { ep, notes } = run([true, false, true, false, false, false]);
    expect(notes).toEqual([
      { at: 0, kind: 'firing' },
      { at: 4, kind: 'resolved' },
    ]);
    expect(ep).toMatchObject({ state: 'resolved', resolvedAt: T0 + 4 * CYCLE });
  });

  it('re-notifies at the interval while firing', () => {
    const { notes } = run(Array<boolean>(9).fill(true), { renotifyMs: 2 * 60_000 });
    expect(notes).toEqual([
      { at: 0, kind: 'firing' },
      { at: 4, kind: 'renotify' },
      { at: 8, kind: 'renotify' },
    ]);
  });

  it('sends a firing message again when the severity rises, not when it falls', () => {
    const { notes, ep } = run([
      obs({ severity: 'warning' }),
      obs({ severity: 'critical' }),
      obs({ severity: 'warning' }),
    ]);
    expect(notes.map((n) => n.kind)).toEqual(['firing', 'escalated']);
    expect(ep!.severity).toBe('warning');
  });

  it('marks the third firing within 30 min as flapping and stays quiet until 15 min false', () => {
    const quiet = FLAP_QUIET_MS / CYCLE;
    const { notes, ep } = run([true, false, true, ...Array<boolean>(quiet + 1).fill(false)], {
      recentFirings: 2,
    });
    expect(notes).toEqual([
      { at: 0, kind: 'flapping' },
      { at: 3 + quiet, kind: 'resolved' },
    ]);
    expect(ep).toMatchObject({ state: 'resolved', flapping: true });
  });
});

describe('silences (ADR-077)', () => {
  it('sends nothing while silenced and one firing message when the silence ends', () => {
    let silenced = true;
    let ep: Episode | null = null;
    const kinds: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      if (i === 2) silenced = false;
      const res = step(ep, obs(), {
        now: T0 + i * CYCLE,
        forMs: 0,
        renotifyMs: 0,
        silenced: () => silenced,
        recentFirings: 0,
      });
      if (res.action === 'insert' || res.action === 'update') {
        ep = res.episode;
        kinds.push(res.notify);
      }
    }
    expect(kinds).toEqual([null, null, 'firing', null]);
  });

  it('sends no resolve when the firing message was never sent', () => {
    const { notes, ep } = run([true, false, false], {
      silenced: (labels) => labels.workload === 'web',
    });
    expect(notes).toEqual([]);
    expect(ep!.state).toBe('resolved');
  });

  it('matches every set field by equality and ignores expired silences', () => {
    const target = { rule: 'r1', cluster: 'c1', namespace: 'wl-test', severity: 'warning' };
    const s = (matchers: Record<string, string>, endsAt = T0 + 1000) => [
      { matchers, startsAt: T0 - 1000, endsAt },
    ];
    expect(isSilenced(s({ namespace: 'wl-test' }), target, T0)).toBe(true);
    expect(isSilenced(s({ namespace: 'wl-test', rule: 'r2' }), target, T0)).toBe(false);
    expect(isSilenced(s({ namespace: 'wl-test' }, T0), target, T0)).toBe(false);
    expect(isSilenced(s({}), target, T0)).toBe(false);
  });
});
