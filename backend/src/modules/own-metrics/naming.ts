// SPDX-License-Identifier: AGPL-3.0-only
// A user's own metric from its name (1.0.0, ADR-236): its family, its type, its unit, the words
// it is shown with, and whether it is off the default list. Pure: no I/O.
//
//   type   from the scrape's TYPE line; for remote write and pushes from the name's suffix:
//          _total a counter, _bucket (with `le`) a histogram with its _sum and _count,
//          _timestamp or _timestamp_seconds a timestamp, anything else a gauge. The user can
//          correct it on the metric's page.
//   shown  a counter as a rate, a histogram as p95 (p50 and p99 in the detail), a gauge as it
//          is, a timestamp as "time since". Never a query the user writes.
//   unit   from the suffix (_seconds, _bytes, _celsius, _ratio, _percent), correctable.

export const OWN_TYPES = ['counter', 'gauge', 'histogram', 'summary', 'timestamp'] as const;
export type OwnType = (typeof OWN_TYPES)[number];

export const OWN_UNITS = ['seconds', 'bytes', 'celsius', 'ratio', 'percent', 'count'] as const;
export type OwnUnit = (typeof OWN_UNITS)[number];

/** A valid Prometheus metric name. */
export const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
export const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export const MAX_NAME = 200;
export const MAX_LABEL_VALUE = 512;
export const MAX_LABELS = 30;

/** Names WatchLog keeps for itself: a metric starting with this is refused. */
export const RESERVED_PREFIX = 'watchlog_';
/**
 * The label every own-metric series carries (ADR-236): its value is the source's id. WatchLog's
 * own series never have it, and its own metrics are never named without `watchlog_`, so neither
 * can be taken for the other in a query.
 */
export const OWN_LABEL = 'wl_own';
/** What a series belongs to, set by the server: never trusted from the sender. */
export const OWNER_LABELS = ['wl_ns', 'wl_wkind', 'wl_workload', 'wl_server'] as const;
/** Labels the server sets; a sender's label of the same name is kept as `exported_<name>`. */
export const SERVER_LABELS = new Set<string>([
  'cluster_id',
  'tenant_id',
  OWN_LABEL,
  ...OWNER_LABELS,
]);

/**
 * Stored within the caps, but off the default list (behind "Show all"): the Go runtime's, the
 * process's and the scrape's own metrics, which every exporter has and almost nobody asks for.
 */
const HIDDEN = /^(go_|process_|promhttp_|scrape_)/;
export const hiddenByDefault = (name: string): boolean => HIDDEN.test(name) || name === 'up';

const HISTOGRAM_PARTS = ['_bucket', '_sum', '_count'] as const;

/** `checkout_duration_seconds_bucket` → `checkout_duration_seconds` when it is a part's name. */
export function stripPart(name: string): { base: string; part: string } | null {
  for (const part of HISTOGRAM_PARTS) {
    if (name.length > part.length && name.endsWith(part))
      return { base: name.slice(0, -part.length), part };
  }
  return null;
}

/** The type a name's suffix says, for a series that came without a TYPE line. */
export function typeFromName(name: string): OwnType {
  if (/_timestamp(_seconds)?$/.test(name)) return 'timestamp';
  if (name.endsWith('_total')) return 'counter';
  return 'gauge';
}

/**
 * A declared type against the name: a gauge whose name says it is a timestamp is one (a TYPE
 * line has no "timestamp"; `backup_last_success_timestamp_seconds` is declared a gauge).
 */
export function resolveType(name: string, declared: OwnType | undefined): OwnType {
  const byName = typeFromName(name);
  if (!declared) return byName;
  return declared === 'gauge' && byName === 'timestamp' ? 'timestamp' : declared;
}

export interface Family {
  /** The metric's name: a histogram's without `_bucket`, `_sum` or `_count`. */
  name: string;
  type: OwnType;
}

/**
 * The family each series name of one batch belongs to. `declared` are the scrape's TYPE lines
 * (by family name); `known` the types of families already in the registry. A histogram is
 * recognised by a `_bucket` series with an `le` label; its `_sum` and `_count` then belong to
 * it. A summary only when declared (its parts look like any counter's).
 */
export function familiesOf(
  series: readonly { name: string; labels: Readonly<Record<string, string>> }[],
  declared: ReadonlyMap<string, OwnType> = new Map(),
  known: ReadonlyMap<string, OwnType> = new Map(),
): Map<string, Family> {
  const histograms = new Set<string>();
  for (const s of series) {
    const p = stripPart(s.name);
    if (p?.part === '_bucket' && 'le' in s.labels) histograms.add(p.base);
  }
  const multi = (base: string) =>
    declared.get(base) === 'histogram' ||
    declared.get(base) === 'summary' ||
    histograms.has(base) ||
    known.get(base) === 'histogram' ||
    known.get(base) === 'summary';
  const out = new Map<string, Family>();
  for (const s of series) {
    if (out.has(s.name)) continue;
    const p = stripPart(s.name);
    if (p && multi(p.base)) {
      out.set(s.name, {
        name: p.base,
        type: declared.get(p.base) ?? known.get(p.base) ?? 'histogram',
      });
      continue;
    }
    // A summary's quantile series carry the family's own name.
    const type = declared.has(s.name)
      ? resolveType(s.name, declared.get(s.name))
      : (known.get(s.name) ?? typeFromName(s.name));
    out.set(s.name, { name: s.name, type });
  }
  return out;
}

/** The unit a name's suffix says; a timestamp is always seconds. */
export function unitFromName(name: string, type: OwnType): OwnUnit {
  if (type === 'timestamp') return 'seconds';
  const base = name.replace(/_total$/, '');
  if (/_seconds$/.test(base)) return 'seconds';
  if (/_bytes$/.test(base)) return 'bytes';
  if (/_celsius$/.test(base)) return 'celsius';
  if (/_ratio$/.test(base)) return 'ratio';
  if (/_percent$/.test(base)) return 'percent';
  return 'count';
}

/** How a type is shown (the page words it: "shown per minute", "shown as p95", …). */
export type Shown = 'rate' | 'p95' | 'as_is' | 'time_since';
export function shownAs(type: OwnType): Shown {
  if (type === 'counter') return 'rate';
  if (type === 'histogram') return 'p95';
  if (type === 'timestamp') return 'time_since';
  return 'as_is';
}

const UNIT_SUFFIX = /_(seconds|bytes|celsius|ratio|percent)$/;

/**
 * A few words for a metric, from its name: "orders_created_total" → "Orders created",
 * "checkout_duration_seconds" → "Checkout duration", "backup_last_success_timestamp" → "Backup
 * last success". A widget's title starts as these and can be renamed.
 */
export function wordsOf(name: string): string {
  const base = name
    .replace(/_total$/, '')
    .replace(/_timestamp(_seconds)?$/, '')
    .replace(UNIT_SUFFIX, '');
  const words = (base || name).split(/[_:]+/).filter(Boolean).join(' ');
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** A sender's labels made safe to store: names checked, the server's own kept apart. */
export function cleanLabels(
  labels: Readonly<Record<string, string>>,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(labels)) {
    if (k === '__name__' || v === '') continue;
    // Prometheus's own internal labels never arrive from a well-behaved sender.
    if (k.startsWith('__')) continue;
    if (!LABEL_NAME.test(k) || k.length > MAX_NAME) return null;
    if (++n > MAX_LABELS) return null;
    const name = SERVER_LABELS.has(k) || k.startsWith('wl_') ? `exported_${k}` : k;
    out[name] = v.length > MAX_LABEL_VALUE ? v.slice(0, MAX_LABEL_VALUE) : v;
  }
  return out;
}
