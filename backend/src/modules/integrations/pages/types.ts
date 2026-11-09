// SPDX-License-Identifier: AGPL-3.0-only
// The service page's contract (ADR-135): an integration describes its tabs and panels;
// the backend fills each panel with data; the web draws it by kind. Titles, labels and
// notes are i18n keys (integrations.<type>.…); names from the service are data.
import type { Database } from '../../../db/index.js';
import type { VictoriaQueryClient } from '../../../lib/victoria.js';
import type { ApplicationRow, CollectorRow } from '../service.js';

/** The web's units (web/src/lib/units.ts). */
export type Unit =
  'ratio' | 'bytes' | 'bytes_per_second' | 'cores' | 'load' | 'count' | 'seconds' | 'per_second';

export type Severity = 'ok' | 'info' | 'warning' | 'critical';
export type Point = [number, number | null];
export type Text = { key: string; values?: Record<string, string | number | null> };

interface Base {
  /** Stable within its tab. */
  id: string;
  /** An i18n key (integrations.<type>.panels.<id>). */
  title: string;
  /** Columns of the two-column grid. */
  span: 1 | 2;
  /** needs_permission: a privilege or setting is missing (ADR-134); empty: no data yet. */
  state: 'ok' | 'empty' | 'needs_permission' | 'error';
  /** What is missing and how to fix it, for needs_permission. */
  missing?: Text;
  /** A short note beside the title ("top 100 of 340 tables"). */
  note?: Text;
}

export interface SeriesPanel extends Base {
  kind: 'line' | 'stack';
  unit: Unit;
  series: {
    /** A name from the service (a member, a queue), or a key for WatchLog's own words. */
    name?: string;
    nameKey?: string;
    points: Point[];
    /** A limit drawn dashed (max_connections, maxmemory). */
    dashed?: boolean;
    severity?: Severity;
  }[];
}
export interface BarsPanel extends Base {
  kind: 'bars';
  unit: Unit;
  items: { label: string; value: number; severity?: Severity }[];
}
export interface HistPanel extends Base {
  kind: 'hist';
  /** Share of the total, 0–1, per bucket. */
  buckets: { label: string; share: number }[];
}
export interface GaugePanel extends Base {
  kind: 'gauge';
  items: {
    label?: string;
    labelKey?: string;
    value: number;
    max: number;
    unit: Unit;
    /** Where the bar turns warning, as a share of max (default 0.8). */
    warnAt?: number;
    note?: Text;
  }[];
}
export interface HeatPanel extends Base {
  kind: 'heat';
  unit: Unit;
  /** Hourly values over the last 7 days; the web buckets them by its local day and hour. */
  points: Point[];
}
export interface TablePanel extends Base {
  kind: 'table';
  /** Column header keys. */
  columns: string[];
  rows: { cells: (string | number | null)[]; severity?: Severity }[];
}
export interface StatPanel extends Base {
  kind: 'stat';
  tiles: {
    id: string;
    labelKey: string;
    value: string | number | null;
    unit?: Unit;
    sub?: Text;
    severity?: Severity;
  }[];
}
export type Panel =
  SeriesPanel | BarsPanel | HistPanel | GaugePanel | HeatPanel | TablePanel | StatPanel;

/** A fact about the service, rendered from its code (integrations.reasons.<code>). */
export interface Reason {
  severity: Severity;
  code: string;
  facts: Record<string, string | number | null>;
  /** Workloads, containers or alerts it points to (ADR-137), for v0.4's probable cause. */
  links?: { kind: 'workload' | 'container' | 'alert'; id: string; name: string }[];
}

/** One of the three numbers on the list row. */
export interface KeyMetric {
  id: string;
  labelKey: string;
  value: number | null;
  unit: Unit;
  severity?: Severity;
}

export interface PageContext {
  db: Database;
  vm: VictoriaQueryClient | undefined;
  row: ApplicationRow;
  collector: CollectorRow | undefined;
  /** Seconds back from now. */
  range: number;
  now: number;
}

export interface TabDef {
  id: string;
  /** An i18n key. */
  title: string;
  panels(ctx: PageContext): Promise<Panel[]>;
}

export interface ListContext {
  vm: VictoriaQueryClient;
  clusterId: string;
  /** The services of this type in this cluster. */
  ids: string[];
  now: number;
}

/** A list row's numbers and its 6-hour sparkline. */
export interface RowMetrics {
  keyMetrics: KeyMetric[];
  spark: Point[];
}

export interface IntegrationPage {
  /** 'generic' until the service's own integration lands; the web says so. */
  id: string;
  tabs: TabDef[];
  /** The list rows' numbers, for many services of one cluster at once (one query each). */
  listMetrics(ctx: ListContext): Promise<Map<string, RowMetrics>>;
  /** What WatchLog sees beyond reachability, from the integration's own metrics. */
  reasons(ctx: PageContext): Promise<Reason[]>;
}
