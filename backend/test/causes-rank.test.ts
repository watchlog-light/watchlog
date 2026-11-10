// SPDX-License-Identifier: AGPL-3.0-only
// Ranking and strength in words (ADR-146, ADR-147): likely, possible or no clear cause; at
// most one likely; ties marked possible; at most three causes; the catalog breaks ties.
import { describe, expect, it } from 'vitest';
import { markChecks, rank, timing, Timing } from '../src/modules/causes/rank.js';
import type { Check } from '../src/modules/causes/types.js';
import { candidate } from './support/causes.js';

const SYMPTOM = '2026-11-10T10:00:00.000Z';
const FROM = '2026-11-10T09:00:00.000Z';
const before = (min: number) => new Date(Date.parse(SYMPTOM) - min * 60_000).toISOString();

describe('timing', () => {
  it('places a cause against the symptom and its window', () => {
    expect(timing(before(10), SYMPTOM, FROM)).toBe(Timing.before);
    expect(timing(before(0.5), SYMPTOM, FROM)).toBe(Timing.same);
    expect(timing(before(-0.5), SYMPTOM, FROM)).toBe(Timing.same);
    expect(timing(before(-5), SYMPTOM, FROM)).toBe(Timing.after);
    expect(timing(before(90), SYMPTOM, FROM)).toBe(Timing.old);
    expect(timing(null, SYMPTOM, FROM)).toBe(Timing.unknown);
    // No symptom time: nothing to be before or after.
    expect(timing(before(10), null, FROM)).toBe(Timing.same);
  });
});

describe('rank', () => {
  it('no candidate: no clear cause', () => {
    expect(rank([], SYMPTOM, FROM)).toMatchObject({ state: 'none', causes: [] });
  });

  it('one complete cause that began before the symptom is likely', () => {
    const r = rank([candidate({ since: before(5) })], SYMPTOM, FROM);
    expect(r.state).toBe('likely');
    expect(r.causes).toEqual([expect.objectContaining({ rule: 'oom_limit', strength: 'likely' })]);
  });

  it('a partial chain, or a cause that began after the symptom, is only possible', () => {
    expect(rank([candidate({ complete: false })], SYMPTOM, FROM).state).toBe('possible');
    const late = rank([candidate({ since: before(-10) })], SYMPTOM, FROM);
    expect(late.state).toBe('possible');
    expect(late.causes[0]!.strength).toBe('possible');
  });

  it('two causes as strong as each other are both possible, in the catalog order', () => {
    const r = rank(
      [
        candidate({ rule: 'crash_exit', code: 'crash_exit', since: before(5) }),
        candidate({ rule: 'bad_change', code: 'bad_change', since: before(8) }),
      ],
      SYMPTOM,
      FROM,
    );
    expect(r.state).toBe('possible');
    expect(r.causes.map((c) => [c.rule, c.strength])).toEqual([
      ['bad_change', 'possible'],
      ['crash_exit', 'possible'],
    ]);
  });

  it('at most one likely: the stronger first, the rest possible', () => {
    const r = rank(
      [
        candidate({ rule: 'dependency_down', since: before(-5) }), // after the symptom
        candidate({ rule: 'crash_exit', complete: false, since: before(3) }), // partial
        candidate({ rule: 'oom_limit', since: before(2) }), // complete, before
      ],
      SYMPTOM,
      FROM,
    );
    expect(r.state).toBe('likely');
    expect(r.causes.map((c) => [c.rule, c.strength])).toEqual([
      ['oom_limit', 'likely'],
      ['crash_exit', 'possible'],
      ['dependency_down', 'possible'],
    ]);
    expect(r.causes.filter((c) => c.strength === 'likely')).toHaveLength(1);
  });

  it('before the symptom ranks above with it, which ranks above an unknown start', () => {
    const r = rank(
      [
        candidate({ rule: 'dependency_down', since: null }),
        candidate({ rule: 'crash_exit', since: SYMPTOM }),
        candidate({ rule: 'job_failed', since: before(20) }),
      ],
      SYMPTOM,
      FROM,
    );
    expect(r.causes.map((c) => c.rule)).toEqual(['job_failed', 'crash_exit', 'dependency_down']);
    expect(r.causes[0]!.strength).toBe('likely');
  });

  it('fewer hops first; a deeper cause that is complete beats a shallow partial one', () => {
    const r = rank(
      [
        candidate({ rule: 'dns_nxdomain', hops: 1, since: before(4) }),
        candidate({ rule: 'bad_change', hops: 2, since: before(4) }),
        candidate({ rule: 'crash_exit', hops: 0, complete: false, since: before(4) }),
      ],
      SYMPTOM,
      FROM,
    );
    expect(r.causes.map((c) => [c.rule, c.strength])).toEqual([
      ['dns_nxdomain', 'likely'],
      ['bad_change', 'possible'],
      ['crash_exit', 'possible'],
    ]);
  });

  it('returns at most three causes and three steps each', () => {
    const many = ['dependency_down', 'bad_change', 'oom_limit', 'crash_exit', 'job_failed'].map(
      (rule) => candidate({ rule, complete: false }),
    );
    const r = rank(many, SYMPTOM, FROM);
    expect(r.causes.map((c) => c.rule)).toEqual(['dependency_down', 'bad_change', 'oom_limit']);
    const long = candidate({ chain: Array.from({ length: 5 }, () => candidate().chain[0]!) });
    expect(rank([long], SYMPTOM, FROM).causes[0]!.chain).toHaveLength(3);
  });
});

describe('markChecks', () => {
  const checks: Check[] = [
    { topic: 'self', code: 'self_oom_killed', facts: {}, result: 'possible' },
    { topic: 'changes', code: 'changes_own', facts: {}, result: 'possible' },
    { topic: 'node', code: 'node_ok', facts: {}, result: 'ok' },
  ];

  it('marks what the likely cause explains, and leaves the rest', () => {
    const r = rank([candidate({ since: before(1), explains: ['self'] })], SYMPTOM, FROM);
    expect(markChecks(checks, r).map((c) => c.result)).toEqual(['explains', 'possible', 'ok']);
  });

  it('a possible cause makes its checks possible, never explains', () => {
    const r = rank([candidate({ complete: false, explains: ['self', 'node'] })], SYMPTOM, FROM);
    expect(markChecks(checks, r).map((c) => c.result)).toEqual([
      'possible',
      'possible',
      'possible',
    ]);
  });
});
