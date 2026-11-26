// SPDX-License-Identifier: AGPL-3.0-only
// How a user's own metric is read (1.0.0, ADR-236): one expression per type, built here and
// nowhere else. The user never writes a query; a page, a widget or an alert names a metric and
// at most one label to split by.
//
//   counter    its rate per second, summed (the page words it per second, minute or hour)
//   gauge      as it is: summed when it counts things or bytes, averaged when it is a ratio, a
//              percentage, a temperature or a duration
//   histogram  p95 from its buckets (p50 and p99 on the metric's page)
//   summary    its average: the rate of its sum over the rate of its count
//   timestamp  the time since the newest value, in seconds
//
// Every selector carries wl_own!="" (only own metrics match, never WatchLog's own series) and
// the cluster comes from the scope, as everywhere.
import {
  LABEL_NAME,
  METRIC_NAME,
  OWN_LABEL,
  OWNER_LABELS,
  type OwnType,
  type OwnUnit,
} from './naming.js';
import type { Owner } from './service.js';

export type Stat = 'p50' | 'p95' | 'p99';
const QUANTILE: Record<Stat, string> = { p50: '0.5', p95: '0.95', p99: '0.99' };

/** How a timestamp's last value is found: it may be pushed once a day. */
export const TIMESTAMP_LOOKBACK = '3d';

export interface ExprMetric {
  name: string;
  type: OwnType;
  unit: OwnUnit;
  /** Every source of it is a push: values arrive when something happens, not every 30 s. */
  pushed: boolean;
}

export interface ExprOptions {
  /** Seconds between points (a range query), or undefined for the value now. */
  step?: number;
  /** One label to split by. */
  by?: string;
  /** Only the series that belong to this workload or server. */
  owner?: Owner;
  /** With `by`: leave these values out (the "other" line). */
  exclude?: readonly string[];
  /** With `by`: only this value (an alert on one line of a split). */
  only?: string;
  stat?: Stat;
  /** One line for each workload or server the series belong to (an alert names its owner). */
  perOwner?: boolean;
}

/** A label value inside a double-quoted PromQL string. */
export const quote = (v: string): string =>
  `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

/** A value as an RE2 literal inside a quoted string. */
const literal = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a gauge of this unit is summed over its series (else averaged). */
export const summed = (unit: OwnUnit): boolean => unit === 'count' || unit === 'bytes';

/** The window a rate is taken over: four scrapes at least; ten minutes for pushes. */
export function window(m: Pick<ExprMetric, 'pushed'>, step?: number): number {
  return Math.max(m.pushed ? 600 : 120, 4 * (step ?? 0));
}

/** How far back a gauge's last value is looked for. */
function lookback(m: ExprMetric, step?: number): string {
  if (m.type === 'timestamp') return TIMESTAMP_LOOKBACK;
  return `${Math.max(m.pushed ? 1800 : 300, 2 * (step ?? 0))}s`;
}

function selector(name: string, o: ExprOptions): string {
  if (!METRIC_NAME.test(name)) throw new Error(`not a metric name: ${name}`);
  const parts = [`__name__=${quote(name)}`, `${OWN_LABEL}!=""`];
  const owner = o.owner;
  if (owner?.kind === 'workload') {
    parts.push(
      `wl_ns=${quote(owner.namespace)}`,
      `wl_wkind=${quote(owner.workloadKind)}`,
      `wl_workload=${quote(owner.name)}`,
    );
  } else if (owner?.kind === 'server') {
    parts.push(`wl_server=${quote(owner.name)}`);
  }
  if (o.by) {
    if (!LABEL_NAME.test(o.by)) throw new Error(`not a label name: ${o.by}`);
    if (o.only !== undefined) parts.push(`${o.by}=${quote(o.only)}`);
    else if (o.exclude?.length) parts.push(`${o.by}!~${quote(o.exclude.map(literal).join('|'))}`);
  }
  return `{${parts.join(',')}}`;
}

/** The expression that shows a metric: its value now, or its line over a range. */
export function exprFor(m: ExprMetric, o: ExprOptions = {}): string {
  // "Other" and "only" are one line: no grouping by the label.
  const groups = [
    ...(o.perOwner ? OWNER_LABELS : []),
    ...(o.by && o.only === undefined && !o.exclude?.length ? [o.by] : []),
  ];
  const split = groups.join(', ');
  const by = split ? ` by (${split})` : '';
  const w = `${window(m, o.step)}s`;
  switch (m.type) {
    case 'counter':
      return `sum${by} (rate(${selector(m.name, o)}[${w}]))`;
    case 'histogram': {
      const le = split ? `le, ${split}` : 'le';
      const q = QUANTILE[o.stat ?? 'p95'];
      return `histogram_quantile(${q}, sum by (${le}) (rate(${selector(`${m.name}_bucket`, o)}[${w}])))`;
    }
    case 'summary':
      return (
        `sum${by} (rate(${selector(`${m.name}_sum`, o)}[${w}]))` +
        ` / sum${by} (rate(${selector(`${m.name}_count`, o)}[${w}]))`
      );
    case 'timestamp':
      return `clamp_min(time() - max${by} (last_over_time(${selector(m.name, o)}[${lookback(m, o.step)}])), 0)`;
    default:
      return `${summed(m.unit) ? 'sum' : 'avg'}${by} (last_over_time(${selector(m.name, o)}[${lookback(m, o.step)}]))`;
  }
}

/** The label a batched histogram answer names its metric in. */
export const MANY_NAME = 'wl_metric';

/**
 * The value now of many metrics of one kind in one query: the answer's `wl_metric`
 * label says which (a histogram's with its `_bucket` name). Summaries are read one by one (two series each).
 */
export function exprForMany(
  kind: { type: Exclude<OwnType, 'summary'>; sum: boolean; pushed: boolean },
  names: readonly string[],
): string {
  for (const n of names) if (!METRIC_NAME.test(n)) throw new Error(`not a metric name: ${n}`);
  const suffix = kind.type === 'histogram' ? '_bucket' : '';
  const sel = `{__name__=~${quote(names.map((n) => literal(n + suffix)).join('|'))},${OWN_LABEL}!=""}`;
  const w = `${window({ pushed: kind.pushed })}s`;
  // An operator or histogram_quantile drops the name: it is carried in a label of its own.
  const named = (rollup: string) =>
    `label_copy(${rollup} keep_metric_names, "__name__", "${MANY_NAME}")`;
  const by = `by (${MANY_NAME})`;
  switch (kind.type) {
    case 'counter':
      return `sum ${by} (${named(`rate(${sel}[${w}])`)})`;
    case 'histogram':
      return `histogram_quantile(0.95, sum by (${MANY_NAME}, le) (${named(`rate(${sel}[${w}])`)}))`;
    case 'timestamp':
      return `clamp_min(time() - max ${by} (${named(`last_over_time(${sel}[${TIMESTAMP_LOOKBACK}])`)}), 0)`;
    default:
      return `${kind.sum ? 'sum' : 'avg'} ${by} (${named(`last_over_time(${sel}[${kind.pushed ? 1800 : 300}s])`)})`;
  }
}

/** How far back an alert looks for a metric's last report or newest timestamp. */
export const ALERT_LOOKBACK = '7d';

/**
 * Seconds since each owner's series of a metric last reported: for "not reported for". A
 * histogram is watched by its buckets, a summary by its sum.
 */
export function lagExpr(m: ExprMetric, o: Pick<ExprOptions, 'owner'> = {}): string {
  const name =
    m.type === 'histogram' ? `${m.name}_bucket` : m.type === 'summary' ? `${m.name}_sum` : m.name;
  return `min by (${OWNER_LABELS.join(', ')}) (lag(${selector(name, o)}[${ALERT_LOOKBACK}]))`;
}

/** The age of a timestamp metric per owner, looked for a week back: for "older than". */
export function ageExpr(m: ExprMetric, o: Pick<ExprOptions, 'owner'> = {}): string {
  return `clamp_min(time() - max by (${OWNER_LABELS.join(', ')}) (last_over_time(${selector(m.name, o)}[${ALERT_LOOKBACK}])), 0)`;
}

/** The unit of what is shown: a timestamp's "time since" is seconds; a summary keeps its own. */
export function shownUnit(m: Pick<ExprMetric, 'type' | 'unit'>): OwnUnit {
  return m.type === 'timestamp' ? 'seconds' : m.unit;
}
