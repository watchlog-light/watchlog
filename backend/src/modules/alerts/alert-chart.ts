// SPDX-License-Identifier: AGPL-3.0-only
// The chart of one alert (alert detail page): its object's series over a window around
// the alert (rule-charts.ts), the thresholds the rule had when the alert was evaluated,
// markers (condition started, fired, resolved, silenced, each message sent, OOM kills,
// last data), the firing period, earlier episodes and the times alerting was not
// running.
import type { Database } from '../../db/index.js';
import type { VictoriaQueryClient } from '../../lib/victoria.js';
import { metricUnit } from '../query/catalog.js';
import type { Condition } from './defaults.js';
import type { RuleSnapshot } from './engine.js';
import { alertingGaps } from './periods.js';
import { ruleChart, type ChartPanel } from './rule-charts.js';
import { DEFAULT_RULES } from './rules.js';
import { SILENCE_FIELDS, type SilenceMatchers } from './silences.js';

/** At least this much before the condition started (30 min). */
const MIN_LEAD_S = 1800;
/** A wider range from the picker is honoured up to 30 days. */
const MAX_RANGE_S = 30 * 86_400;

export interface ChartWindow {
  from: number;
  to: number;
}

/**
 * From 2× the rule's duration (at least 30 min) before the condition started until it
 * resolved, or now. A longer range from the time-range picker widens it, ending at the
 * same point.
 */
export function chartWindow(
  a: { startedAt: number; resolvedAt: number | null },
  forSeconds: number,
  now: number,
  rangeSeconds?: number,
  /** The longest window, whatever the alert's length (24 h in the demo, ADR-122). */
  maxSpanSeconds?: number,
): ChartWindow {
  const to = Math.floor((a.resolvedAt ?? now) / 1000);
  let from = Math.floor(a.startedAt / 1000) - Math.max(2 * forSeconds, MIN_LEAD_S);
  const range = Math.min(rangeSeconds ?? 0, MAX_RANGE_S);
  if (range > to - from) from = to - range;
  if (maxSpanSeconds !== undefined && to - from > maxSpanSeconds) from = to - maxSpanSeconds;
  return { from, to };
}

export type MarkerKind =
  'started' | 'fired' | 'resolved' | 'silenced' | 'notification' | 'oom' | 'lastData';

export interface ChartMarkerView {
  ts: number;
  kind: MarkerKind;
  /** Messages: the channel and the delivery status. */
  channel?: string;
  status?: string;
  messageKind?: string;
}

export interface AlertChartView {
  window: ChartWindow;
  panels: ChartPanel[];
  markers: ChartMarkerView[];
  firing: ChartWindow | null;
  episodes: ChartWindow[];
  gaps: ChartWindow[];
  silent: ChartWindow | null;
  /** The rule now, when it differs from the values this alert was evaluated with. */
  ruleChanged: {
    condition: Condition | null;
    forSeconds: number;
    unit: string | null;
  } | null;
}

const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const sameCondition = (a: unknown, b: unknown) => {
  const x = a as Partial<Condition> | null;
  const y = b as Partial<Condition> | null;
  return x?.op === y?.op && x?.value === y?.value && x?.critical === y?.critical;
};

/** The chart of alert `alertId` in `orgId`, or null when there is no such alert. */
export async function alertChart(
  deps: { db: Database; victoria?: VictoriaQueryClient },
  orgId: string,
  alertId: string,
  opts: { now?: number; rangeSeconds?: number; maxSpanSeconds?: number } = {},
): Promise<AlertChartView | null> {
  const { db, victoria } = deps;
  const now = opts.now ?? Date.now();
  const row = await db
    .selectFrom('alert_states as s')
    .innerJoin('alert_rules as r', 'r.id', 's.rule_id')
    .innerJoin('clusters as c', 'c.id', 's.cluster_id')
    .select([
      's.id',
      's.rule_id',
      's.cluster_id',
      's.fingerprint',
      's.severity',
      's.labels',
      's.details',
      's.started_at',
      's.fired_at',
      's.resolved_at',
      's.rule_snapshot',
      'r.rule_key',
      'r.metric',
      'r.condition',
      'r.for_seconds',
      'r.severity as rule_severity',
      'c.kind as cluster_kind',
    ])
    .where('s.id', '=', alertId)
    .where('s.org_id', '=', orgId)
    .executeTakeFirst();
  if (!row) return null;

  const snap = row.rule_snapshot as RuleSnapshot | null;
  const kind = row.cluster_kind as 'kubernetes' | 'docker';
  const def = row.rule_key ? DEFAULT_RULES.find((d) => d.key === row.rule_key) : undefined;
  const condition = (snap ? snap.condition : row.condition) as Condition | null;
  const forSeconds = snap?.forSeconds ?? row.for_seconds;
  const metric = def ? (def.metrics?.[kind] ?? null) : (snap?.metric ?? row.metric);
  const labels = row.labels as Record<string, string>;
  const window = chartWindow(
    { startedAt: +row.started_at, resolvedAt: row.resolved_at ? +row.resolved_at : null },
    forSeconds,
    now,
    opts.rangeSeconds,
    opts.maxSpanSeconds,
  );
  const clip = (w: { from: number; to: number }) => ({
    from: Math.max(window.from, w.from),
    to: Math.min(window.to, w.to),
  });
  const inWindow = (ts: number) => ts >= window.from && ts <= window.to;

  const [chart, notes, silences, episodes, gaps] = await Promise.all([
    victoria
      ? ruleChart(
          { victoria, clusterId: row.cluster_id, ...window },
          {
            ruleKey: row.rule_key,
            metric,
            clusterKind: kind,
            labels,
            details: row.details as Record<string, unknown>,
            condition:
              condition && typeof condition === 'object' && 'value' in condition ? condition : null,
            severity: snap?.severity ?? row.rule_severity,
          },
        )
      : Promise.resolve({ panels: [], marks: [], silent: null }),
    db
      .selectFrom('notification_alerts as na')
      .innerJoin('notifications as n', 'n.id', 'na.notification_id')
      .leftJoin('alert_channels as ch', 'ch.id', 'n.channel_id')
      .select(['n.kind', 'n.status', 'n.created_at', 'n.sent_at', 'ch.name as channel'])
      .where('na.alert_state_id', '=', row.id)
      .execute(),
    db
      .selectFrom('silences')
      .select(['matchers', 'starts_at', 'ends_at'])
      .where('org_id', '=', orgId)
      .where('starts_at', '<=', row.resolved_at ?? new Date(now))
      .where('ends_at', '>=', row.started_at)
      .execute(),
    db
      .selectFrom('alert_states')
      .select(['started_at', 'fired_at', 'resolved_at'])
      .where('rule_id', '=', row.rule_id)
      .where('cluster_id', '=', row.cluster_id)
      .where('fingerprint', '=', row.fingerprint)
      .where('id', '<>', row.id)
      .where('fired_at', 'is not', null)
      .where('fired_at', '<=', new Date(window.to * 1000))
      .where((eb) =>
        eb.or([
          eb('resolved_at', 'is', null),
          eb('resolved_at', '>=', new Date(window.from * 1000)),
        ]),
      )
      .execute(),
    alertingGaps(db, new Date(window.from * 1000), new Date(window.to * 1000), now),
  ]);

  const markers: ChartMarkerView[] = [];
  const mark = (ts: number, k: MarkerKind, extra: Partial<ChartMarkerView> = {}) => {
    if (inWindow(ts)) markers.push({ ts, kind: k, ...extra });
  };
  mark(sec(row.started_at), 'started');
  if (row.fired_at) mark(sec(row.fired_at), 'fired');
  if (row.resolved_at) mark(sec(row.resolved_at), 'resolved');
  const target: Record<string, string> = {
    ...labels,
    rule: row.rule_id,
    cluster: row.cluster_id,
    severity: row.severity,
  };
  for (const s of silences) {
    const m = s.matchers as SilenceMatchers;
    const matches =
      SILENCE_FIELDS.some((f) => m[f] !== undefined) &&
      SILENCE_FIELDS.every((f) => m[f] === undefined || m[f] === target[f]);
    if (matches) mark(Math.max(sec(s.starts_at), sec(row.started_at)), 'silenced');
  }
  for (const n of notes) {
    mark(sec(n.sent_at ?? n.created_at), 'notification', {
      channel: n.channel ?? '',
      status: n.status,
      messageKind: n.kind,
    });
  }
  for (const m of chart.marks) mark(m.ts, m.kind);
  markers.sort((a, b) => a.ts - b.ts);

  const current = row.condition as Condition | null;
  const changed =
    snap !== null &&
    (!sameCondition(snap.condition, current) || snap.forSeconds !== row.for_seconds);

  return {
    window,
    panels: chart.panels,
    markers,
    firing: row.fired_at
      ? clip({ from: sec(row.fired_at), to: row.resolved_at ? sec(row.resolved_at) : window.to })
      : null,
    episodes: episodes.map((e) =>
      clip({ from: sec(e.fired_at!), to: e.resolved_at ? sec(e.resolved_at) : window.to }),
    ),
    gaps: gaps.map((g) => clip({ from: sec(g.from), to: g.to ? sec(g.to) : window.to })),
    silent: chart.silent ? clip(chart.silent) : null,
    ruleChanged: changed
      ? {
          condition: current && 'value' in current ? current : null,
          forSeconds: row.for_seconds,
          unit: metric ? metricUnit(metric) : (def?.unit ?? null),
        }
      : null,
  };
}
