// SPDX-License-Identifier: AGPL-3.0-only
// The service page's contract (ADR-135): an integration describes its tabs and panels;
// the backend fills each panel with data; the web draws it by kind. Titles, labels and
// notes are i18n keys (integrations.<type>.…); names from the service are data.
import type { Database } from '../../../db/index.js';
import type { ClusterScope, VictoriaQueryClient } from '../../../lib/victoria.js';
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

/** A link on a panel (1.1.0): a workload or container page, a queue's page, a tab, the docs. */
export type Link =
  | { kind: 'workload' | 'container'; id: string; name: string }
  | { kind: 'queue'; vhost: string; queue: string; name: string }
  | { kind: 'tab'; tab: string; filter?: string; name: string }
  | { kind: 'docs'; href: string; name: string };

export interface SeriesPanel extends Base {
  kind: 'line' | 'stack';
  unit: Unit;
  /** Events drawn as vertical lines (a consumer OOM-killed), unix seconds. */
  markers?: { at: number; text: Text; severity?: Severity }[];
  /** The usual range of the first series (What changed's statistics), drawn as a band. */
  band?: { low: Point[]; high: Point[] };
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
/** RabbitMQ's message flow (1.1.0): publishers → exchanges → queues → consumers. */
export interface FlowPanel extends Base {
  kind: 'flow';
  columns: {
    id: string;
    /** "Publishers · {n} services" */
    title: Text;
    value: number | null;
    unit: Unit;
    /** A word after the value ("ready", "in"); WatchLog's words. */
    valueKey?: string;
    severity?: Severity;
    rows: {
      name: string;
      nameKey?: string;
      value: number | null;
      unit: Unit;
      /** A word instead of the value ("gone 14:02"). */
      text?: Text;
      severity?: Severity;
      link?: Link;
    }[];
    /** The rate into the next column (/s); none after the last. */
    next?: number | null;
  }[];
}

/** Pass/fail checks (RabbitMQ's health checks). */
export interface ChecksPanel extends Base {
  kind: 'checks';
  items: {
    id: string;
    labelKey: string;
    state: 'pass' | 'warn' | 'fail';
    value: Text;
    /** Where a failed check is explained or fixed. */
    link?: Link;
  }[];
}

/** One queue's row (RabbitMQ's Queues tab and its Overview). */
export interface QueueRow {
  vhost: string;
  queue: string;
  /** "orders", or "billing/orders" outside the default vhost. */
  name: string;
  type: 'classic' | 'quorum' | 'stream' | null;
  ready: number;
  unacked: number;
  /** Published into it, and delivered from it, per second (5 min). */
  in: number | null;
  out: number | null;
  consumers: number | null;
  /** Consumer utilisation, 0–1 (the share of time the queue could deliver at once). */
  busy: number | null;
  /** ready ÷ (out − in) when positive; otherwise why it doesn't drain. */
  drain: { state: 'eta'; seconds: number } | { state: 'growing' | 'never' | 'empty' | 'stream' };
  severity?: Severity;
}
export interface QueuesPanel extends Base {
  kind: 'queues';
  rows: QueueRow[];
  /** The whole table (sort, search, "no consumers") or a short list with a link to it. */
  full: boolean;
  /** How many queues there are in all (the short list's "All 42 queues →"). */
  total: number;
}

/** A workload that connects to a service (RabbitMQ's Clients tab). */
export interface ClientsPanel extends Base {
  kind: 'clients';
  rows: {
    name: string;
    link?: Link;
    /** "shop · Deployment", "web-01 · container", or WatchLog's words. */
    where: Text;
    /** Connections opened in the last 24 hours. */
    connections: number;
    /** Bytes a second each way, now (5 min). */
    sends: number | null;
    receives: number | null;
    /** A guess from the traffic's direction, shown only when one way clearly dominates. */
    mostly: 'publishes' | 'consumes' | null;
    state: Text;
    severity?: Severity;
  }[];
}

/** Each node of a cluster against its limits (RabbitMQ's Nodes tab). */
export interface NodesPanel extends Base {
  kind: 'nodes';
  items: {
    name: string;
    version: string | null;
    uptime: number | null;
    connections: number | null;
    /** Queue leaders on it; null where the version doesn't say (3.13). */
    leaders: number | null;
    severity?: Severity;
    limits: {
      labelKey: string;
      value: number;
      max: number;
      unit: Unit;
      /** Free disk counts down to its limit, so a short bar is the bad one. */
      inverse?: boolean;
    }[];
  }[];
}

/** What happened around something, oldest first (a queue's page). */
export interface TimelinePanel extends Base {
  kind: 'timeline';
  events: { at: number; text: Text; sourceKey: string; severity?: Severity; link?: Link }[];
}

/** Facts as label and value (a queue's page). */
export interface FactsPanel extends Base {
  kind: 'facts';
  rows: { labelKey: string; value: string | number | null; unit?: Unit; text?: Text }[];
}

/** The probable cause in words, with what it links to and what it can't know. */
export interface CausePanel extends Base {
  kind: 'cause';
  text: Text | null;
  caveat: Text;
  links: Link[];
}

/** The alerts on one queue, and the ones a user can add from its page. */
export interface QueueAlertsPanel extends Base {
  kind: 'queue_alerts';
  vhost: string;
  queue: string;
  rules: { id: string; name: string; state: 'firing' | 'quiet' | 'off' }[];
  presets: {
    key: string;
    nameKey: string;
    metric: string;
    op: '>' | '<';
    value: number;
    forSeconds: number;
    severity: 'warning' | 'critical';
  }[];
}

export type Panel =
  | SeriesPanel
  | BarsPanel
  | HistPanel
  | GaugePanel
  | HeatPanel
  | TablePanel
  | StatPanel
  | FlowPanel
  | ChecksPanel
  | QueuesPanel
  | ClientsPanel
  | NodesPanel
  | TimelinePanel
  | FactsPanel
  | CausePanel
  | QueueAlertsPanel;

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
  /** The row's cluster, authorised for the caller's org (ADR-174). */
  scope: ClusterScope;
  row: ApplicationRow;
  collector: CollectorRow | undefined;
  /** Seconds back from now. */
  range: number;
  now: number;
  /** A sub-page's parameters (1.1.0): RabbitMQ's queue page has `vhost` and `queue`. */
  params?: Record<string, string>;
  /** The org has What changed (Pro): pages may say what is usual for this hour. */
  usual?: boolean;
}

export interface TabDef {
  id: string;
  /** An i18n key. */
  title: string;
  panels(ctx: PageContext): Promise<Panel[]>;
  /** A sub-page with its own address (a queue), not a tab of its own. */
  hidden?: boolean;
  /** The web draws its own view in it ('alerts': the service's alerts). */
  view?: 'alerts';
  /** A number beside the title ("Queues · 42"), when it is cheap to know. */
  count?(ctx: PageContext): Promise<number | null>;
}

export interface ListContext {
  vm: VictoriaQueryClient;
  /** The cluster of these services, authorised for the caller's org (ADR-174). */
  scope: ClusterScope;
  /** The services of this type in this cluster. */
  ids: string[];
  /** Their rows, for pages whose series are found by target (Nginx's eBPF). */
  rows?: ApplicationRow[];
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
