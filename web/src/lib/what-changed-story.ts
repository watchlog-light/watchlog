// SPDX-License-Identifier: AGPL-3.0-only
// What changed's story in words and shapes (0.14.0, ADR-231): the backend's clauses (codes
// with facts, ADR-147) worded through i18n into one sentence; the change in a phrase; the
// episode's label; the "14× usual" chip; each series' band sparkline; the checks, the ones that
// found something first; the chart's episodes and change markers. Pure: given the answer.
import type {
  WhatChangedChange,
  WhatChangedClause,
  WhatChangedEpisode,
  WhatChangedStory,
} from '@watchlog/api-types';
import { metricText } from './what-changed';

export type Tr = (key: string, values?: Record<string, unknown>, plural?: number) => string;
type Facts = WhatChangedClause['facts'];

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** "14× usual" for a rise, "÷1.5 usual" for a drop (against the band's edge). */
export function factorText(x: unknown, dir: unknown, tr: Tr): string {
  const n = Number(x);
  if (!Number.isFinite(n)) return '';
  const v = n >= 999 ? '999+' : String(n);
  return tr(dir === 'down' ? 'whatChanged.factor.down' : 'whatChanged.factor.up', { x: v });
}

/** A change as a phrase in a sentence: "the rollout of backend", "backup.timer running on db-1". */
export function changePhrase(f: Facts, tr: Tr): string {
  return tr(`whatChanged.change.${str(f.change)}`, {
    target: str(f.target),
    host: str(f.host),
    namespace: str(f.namespace),
    from: str(f.from),
    to: str(f.to),
  });
}

/** A change from the list as a phrase. */
export const changeFactsOf = (c: WhatChangedChange): Facts => ({
  change: c.kind,
  target: c.name,
  host: c.host ?? null,
  namespace: c.namespace ?? null,
  ...c.facts,
});

const minutes = (n: unknown, tr: Tr) => tr('whatChanged.minutes', { n: Number(n) }, Number(n));

/** What moved, in words: "shop/backend's p95 of calls to postgres". */
function whatOf(f: Facts, tr: Tr): { who: string; what: string } {
  return {
    who: str(f.who),
    what: metricText({ key: str(f.key), peer: f.peer === null ? null : str(f.peer) }, tr),
  };
}

export function clauseText(c: WhatChangedClause, tr: Tr): string {
  const f = c.facts;
  switch (c.code) {
    case 'after_change':
      return tr('whatChanged.story.after_change', {
        ...whatOf(f, tr),
        factor: factorText(f.x, f.dir, tr),
        gap: minutes(f.gap, tr),
        change: changePhrase(f, tr),
      });
    case 'first':
    case 'then':
    case 'same_time':
      return tr(`whatChanged.story.${c.code}`, {
        ...whatOf(f, tr),
        factor: factorText(f.x, f.dir, tr),
        and: f.and ? tr('whatChanged.story.and') : '',
      });
    case 'more':
      return tr('whatChanged.story.more', { n: Number(f.n) }, Number(f.n));
    default:
      return '';
  }
}

/** The episode in one sentence: the clauses joined, the first letter up, a full stop. */
export function storyText(clauses: WhatChangedClause[], tr: Tr): string {
  const parts = clauses.map((c) => clauseText(c, tr)).filter(Boolean);
  if (!parts.length) return '';
  const s = parts.reduce((acc, p, i) => {
    if (i === 0) return p;
    const c = clauses[i]!;
    const sep = c.code === 'more' || c.facts.and ? ', ' : '; ';
    return `${acc}${sep}${p}`;
  }, '');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

/** The cause box for a linked change: "The rollout of backend at 14:31. The first move …". */
export function changeCauseText(
  c: WhatChangedClause,
  tr: Tr,
  clock: (iso: string) => string,
): string {
  const phrase = changePhrase(c.facts, tr);
  return tr('whatChanged.causeBox.change', {
    change: `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`,
    at: clock(str(c.facts.at)),
    gap: minutes(c.facts.gap, tr),
    who: str(c.facts.who),
  });
}

/** The day of a moment as the label says it: Today, Yesterday, or the weekday and date. */
export function dayWord(ms: number, nowMs: number, tr: Tr, locale = 'en'): string {
  const d = new Date(ms);
  const n = new Date(nowMs);
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (same(d, n)) return tr('whatChanged.day.today');
  const y = new Date(nowMs - 86_400_000);
  if (same(d, y)) return tr('whatChanged.day.yesterday');
  return d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "Today 14:31 – 15:39 · 3 things moved", "Today since 14:31 · 1 thing moved". */
export function episodeLabel(
  e: Pick<WhatChangedEpisode, 'from' | 'to' | 'count'>,
  nowMs: number,
  tr: Tr,
  clock: (iso: string) => string,
): string {
  const day = dayWord(Date.parse(e.from), nowMs, tr);
  const n = { n: e.count };
  return e.to
    ? tr('whatChanged.episode.range', { day, from: clock(e.from), to: clock(e.to), ...n }, e.count)
    : tr('whatChanged.episode.since', { day, from: clock(e.from), ...n }, e.count);
}

/** The checks the engine ran, the ones that found something first; those it couldn't run last. */
export function orderedChecks<T extends { result: string }>(checks: T[]): T[] {
  const rank: Record<string, number> = {
    explains: 0,
    possible: 1,
    ok: 2,
    not_run: 3,
    not_applicable: 4,
  };
  return checks
    .filter((c) => c.result !== 'not_applicable')
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (rank[a.c.result] ?? 5) - (rank[b.c.result] ?? 5) || a.i - b.i)
    .map((x) => x.c);
}

/** The checks that found something (for "No clear cause"): never a count without names. */
export const foundChecks = <T extends { result: string }>(checks: T[]) =>
  checks.filter((c) => c.result === 'explains' || c.result === 'possible');

export interface Spark {
  path: string;
  /** The usual band, as a rect in the sparkline's coordinates. */
  band: { y: number; h: number };
  /** Where the series left its band (dashed), or null when outside the drawn minutes. */
  exitX: number | null;
}

/**
 * A 210×44 sparkline: the series over the episode, its usual band shaded, a dashed line where
 * it left it. The scale fits both the series and the band.
 */
export function sparkOf(
  s: { from: string; step: number; values: (number | null)[] },
  low: number,
  high: number,
  sinceIso: string,
  w = 210,
  h = 44,
): Spark | null {
  const vals = s.values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (vals.length < 2) return null;
  const min = Math.min(low, ...vals);
  const max = Math.max(high, ...vals);
  const span = max - min || 1;
  const pad = 3;
  const y = (v: number) => pad + (h - 2 * pad) * (1 - (v - min) / span);
  const n = s.values.length;
  const x = (i: number) => (n === 1 ? 0 : (i / (n - 1)) * w);
  let path = '';
  let pen = false;
  s.values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    pen = true;
  });
  const t0 = Date.parse(s.from);
  const i = (Date.parse(sinceIso) - t0) / (s.step * 1000);
  return {
    path: path.trim(),
    band: { y: y(high), h: Math.max(1, y(low) - y(high)) },
    exitX: i >= 0 && i <= n - 1 ? x(i) : null,
  };
}

export interface ChartBand {
  index: number;
  left: number;
  width: number;
  selected: boolean;
}

/** The episodes as shaded stretches on the chart, in percent of its range. */
export function chartBands(
  episodes: Pick<WhatChangedEpisode, 'from' | 'to'>[],
  selected: number,
  range: { from: string; to: string },
  nowMs: number,
): ChartBand[] {
  const a = Date.parse(range.from);
  const b = Date.parse(range.to);
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - a) / (b - a)) * 100));
  return episodes.map((e, index) => {
    const l = pct(Date.parse(e.from));
    const r = pct(e.to ? Date.parse(e.to) : nowMs);
    return { index, left: l, width: Math.max(0.6, r - l), selected: index === selected };
  });
}

/** The changes as markers on the chart's time line, with their short labels. */
export function chartMarkers(
  changes: WhatChangedChange[],
  range: { from: string; to: string },
  tr: Tr,
): { left: number; label: string; at: string }[] {
  const a = Date.parse(range.from);
  const b = Date.parse(range.to);
  return changes
    .filter((c) => {
      const t = Date.parse(c.at);
      return t >= a && t <= b;
    })
    .map((c) => ({
      left: ((Date.parse(c.at) - a) / (b - a)) * 100,
      label: tr(`whatChanged.marker.${c.kind}`, {
        target: c.name,
        from: str(c.facts.from),
        to: str(c.facts.to),
      }),
      at: c.at,
    }));
}

/** The story's rows by first move (the default) or the furthest out. */
export function sortedMoved<T extends { since: string; peakScore: number; id: string }>(
  rows: T[],
  sort: 'first' | 'furthest',
): T[] {
  return rows
    .slice()
    .sort((a, b) =>
      sort === 'first'
        ? a.since.localeCompare(b.since) || b.peakScore - a.peakScore || a.id.localeCompare(b.id)
        : b.peakScore - a.peakScore || a.since.localeCompare(b.since) || a.id.localeCompare(b.id),
    );
}

/** The story as text, for "Copy as text": the label, the sentence, the cause, how it spread. */
export function storyAsText(
  story: WhatChangedStory,
  label: string,
  sentence: string,
  cause: string,
  tr: Tr,
): string {
  const chain = story.chain.nodes
    .map((n) => `${n.gapMin !== null ? `+${n.gapMin} min ` : ''}${n.who}`)
    .join(' → ');
  const changes = story.changes.map((c) => `- ${c.at}: ${changePhrase(changeFactsOf(c), tr)}`);
  return [
    label,
    sentence,
    cause,
    chain && `${tr('whatChanged.spread.title')}: ${chain}`,
    ...changes,
  ]
    .filter(Boolean)
    .join('\n');
}
