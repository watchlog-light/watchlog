// SPDX-License-Identifier: AGPL-3.0-only
// The expiry timeline's placement (0.13.0, ADR-230): days to percent, expired at the left
// edge, the colours, three lanes so labels don't overlap, the flip near the right end, the
// "+N later" count, and same-day clustering past 15 certificates.
import { describe, expect, it } from 'vitest';
import {
  CLUSTER_OVER,
  placeCerts,
  ticksFor,
  ticksThatFit,
  timelineText,
  toneOf,
  type TimelineCert,
} from '@/lib/expiry-timeline';

const cert = (name: string, daysLeft: number, problem = false): TimelineCert => ({
  id: `${name}-id`,
  name,
  where: 'Ingress shop/api',
  daysLeft,
  problem,
});

describe('placeCerts', () => {
  it('puts each certificate on its day; expired ones at the left edge; later ones counted', () => {
    const p = placeCerts(
      [
        cert('a.acme.com', 9),
        cert('b.acme.com', 45),
        cert('old.acme.com', -3),
        cert('c.acme.com', 140),
      ],
      90,
    );
    expect(p.marks.map((m) => [m.items[0]!.name, Math.round(m.pct * 10) / 10, m.tone])).toEqual([
      ['old.acme.com', 0, 'crit'],
      ['a.acme.com', 10, 'warn'],
      ['b.acme.com', 50, 'info'],
    ]);
    expect(p.later).toBe(1);
    expect(p.windowEnd).toBeCloseTo(33.33, 1);
  });

  it('colours: red under 3 days (and expired), amber under 14, blue otherwise', () => {
    expect([toneOf(-1), toneOf(2), toneOf(3), toneOf(13), toneOf(14)]).toEqual([
      'crit',
      'crit',
      'warn',
      'warn',
      'info',
    ]);
  });

  it('gives overlapping labels different lanes, and reuses a lane once it is free', () => {
    const p = placeCerts(
      [
        cert('one.acme.com', 10),
        cert('two.acme.com', 12),
        cert('three.acme.com', 14),
        cert('far.acme.com', 80),
      ],
      90,
      { widthPx: 900 },
    );
    const lane = (n: string) => p.marks.find((m) => m.items[0]!.name === n)!.lane;
    expect([lane('one.acme.com'), lane('two.acme.com'), lane('three.acme.com')]).toEqual([0, 1, 2]);
    // far.acme.com is past the others' labels: lane 0 again.
    expect(lane('far.acme.com')).toBe(0);
  });

  it('leaves a label out when no lane is free, instead of overlapping', () => {
    const p = placeCerts(
      ['a', 'b', 'c', 'd'].map((n, i) => cert(`${n}.acme.com`, 10 + i)),
      90,
      { widthPx: 900 },
    );
    expect(p.marks.map((m) => m.lane)).toEqual([0, 1, 2, null]);
  });

  it('flips a label to the left of its dot near the right end', () => {
    const p = placeCerts([cert('near.acme.com', 20), cert('end.acme.com', 85)], 90);
    expect(p.marks.map((m) => m.flip)).toEqual([false, true]);
  });

  it('the strip has dots and no labels', () => {
    const p = placeCerts([cert('a.acme.com', 9)], 90, { labels: false });
    expect(p.marks[0]!.lane).toBeNull();
  });

  it('past 15 certificates, same-day dots become one with a count; labels for the soonest and problems', () => {
    const many = Array.from({ length: CLUSTER_OVER + 5 }, (_, i) =>
      cert(`svc-${i}.internal`, 30 + Math.floor(i / 4) * 10),
    );
    many.push(cert('broken.acme.com', 70, true));
    const p = placeCerts(many, 90);
    // 20 certificates on 5 days (4 a day) and the problem on its own day.
    expect(p.marks.length).toBeLessThan(many.length);
    const day30 = p.marks.find((m) => Math.round(m.pct) === 33)!;
    expect(day30.items).toHaveLength(4);
    const labelled = p.marks.filter((m) => m.lane !== null).map((m) => m.items[0]!.name);
    expect(labelled).toContain('broken.acme.com');
    expect(labelled.length).toBeLessThanOrEqual(7);
  });

  it('leaves out ticks closer than 56 px on a phone, keeping the end', () => {
    const ticks = ticksFor(90).map((days) => ({ days, pct: (days / 90) * 100 }));
    expect(ticksThatFit(ticks, 900).map((t) => t.days)).toEqual([0, 14, 30, 60, 90]);
    expect(ticksThatFit(ticks, 320).map((t) => t.days)).toEqual([0, 30, 60, 90]);
  });

  it('ticks per range', () => {
    expect(ticksFor(30)).toEqual([0, 7, 14, 21, 30]);
    expect(ticksFor(90)).toEqual([0, 14, 30, 60, 90]);
    expect(ticksFor(365)).toEqual([0, 30, 90, 180, 365]);
  });

  it('has a text equivalent naming each certificate and its days', () => {
    const say = (k: string, v: Record<string, unknown>) => `${k}:${JSON.stringify(v)}`;
    const text = timelineText([cert('a', 9), cert('b', -2), cert('c', 200)], 90, say);
    expect(text).toContain('certTimeline.a11y.left:{"name":"a","n":9}');
    expect(text).toContain('certTimeline.a11y.expired:{"name":"b","n":2}');
    expect(text).toContain('certTimeline.a11y.later:{"n":1}');
  });
});
