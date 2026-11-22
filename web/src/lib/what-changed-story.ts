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

/**
 * A sentence's first letter up, unless it starts with a name ("shop/backend's CPU …",
 * "backup.timer running …"): names keep their case. Our own words are lowercase English.
 */
export function sentenceStart(s: string): string {
  return /^(the|a|an|node|at|and)\b/.test(s) ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s;
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
  return `${sentenceStart(s)}.`;
}

/** The cause box for a linked change: "The rollout of backend at 14:31. The first move …". */
export function changeCauseText(
  c: WhatChangedClause,
  tr: Tr,
  clock: (iso: string) => string,
): string {
  const phrase = changePhrase(c.facts, tr);
  return tr('whatChanged.causeBox.change', {
    change: sentenceStart(phrase),
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
/** Label lanes above the chart. */
export const MARKER_LANES = 3;
/** A label's width, estimated in % of the chart per character (12 px text on a ~700 px chart). */
const LABEL_PCT_PER_CHAR = 1;
/** Past this, a label hangs to the left of its line (WcChart's `right-1.5`). */
export const MARKER_FLIP = 75;

/** The stretch a marker's label covers, in % of the chart: right of its line, or left near the end. */
export function labelSpan(left: number, label: string): [number, number] {
  const w = (label.length + 3) * LABEL_PCT_PER_CHAR;
  return left > MARKER_FLIP ? [left - w, left] : [left, left + w];
}

/**
 * The chart's change markers. Every change is a line; a label only where it fits (three lanes,
 * no two labels' stretches overlapping in one lane), deployments and server changes before
 * scheduled runs, so a busy place (a job
 * every 10 minutes, scaling every 15) stays readable: the rest are lines without words, and
 * each one is listed under "Changed around then" for its episode.
 */
export function chartMarkers(
  changes: WhatChangedChange[],
  range: { from: string; to: string },
  tr: Tr,
): { left: number; label: string; at: string; lane: number | null }[] {
  const a = Date.parse(range.from);
  const b = Date.parse(range.to);
  const out = changes
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
      lane: null as number | null,
      run: c.kind === 'job_run',
    }));
  const lanes: [number, number][][] = Array.from({ length: MARKER_LANES }, () => []);
  const order = out.slice().sort((x, y) => Number(x.run) - Number(y.run) || x.left - y.left);
  for (const m of order) {
    const [a1, b1] = labelSpan(m.left, m.label);
    const lane = lanes.findIndex((l) => l.every(([a2, b2]) => b1 + 1 <= a2 || b2 + 1 <= a1));
    if (lane >= 0) {
      lanes[lane]!.push([a1, b1]);
      m.lane = lane;
    }
  }
  return out.map((m) => ({ left: m.left, label: m.label, at: m.at, lane: m.lane }));
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

/** What a series is about, as the story names it: "shop/backend", "postgres · db-1". */
export function whoOf(o: {
  kind: string;
  name: string;
  namespace?: string;
  host?: string;
  composeService?: string;
}): string {
  if (o.kind === 'workload') {
    if (o.namespace) return `${o.namespace}/${o.name}`;
    return o.host ? `${o.name} · ${o.host}` : o.name;
  }
  if (o.kind === 'container') {
    const name = o.composeService ?? o.name;
    return o.host ? `${name} · ${o.host}` : name;
  }
  return o.name;
}

/** How far out a value is, against its band's edge, as the story's chip says it. */
export function rowFactor(
  value: number,
  low: number,
  high: number,
): { x: number; dir: 'up' | 'down' } {
  const round = (x: number) => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);
  if (value >= high) {
    const edge = high > 0 ? high : Math.max(high - low, 1e-9);
    return { x: Math.min(999, round(value / edge)), dir: 'up' };
  }
  return { x: Math.min(999, value > 0 ? round(low / value) : 999), dir: 'down' };
}
