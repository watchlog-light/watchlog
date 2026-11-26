// SPDX-License-Identifier: AGPL-3.0-only
// What each edition allows for a user's own metrics (1.0.0, ADR-236 and ADR-237): the one place
// these numbers live. Four editions: Cloud Free, Cloud Pro (and a Cloud Enterprise contract, as
// Pro), self-hosted Community, and self-hosted with a licence that lists `pro`.
//
//                         Cloud Free   Cloud Pro                  Community           Licence (pro)
//   series in the org     200          200 per billed node or     the installation's  the same
//                                      server, at least 1,000     cap (20,000)        setting
//   series from a source  100          500                        500                 500
//     (a scraped endpoint, or a token's pushes. A token's remote write has no cap of its
//     own since 1.0.1, ADR-240: it is a whole Prometheus, and the org's series limit it.)
//   kept for              3 days       30 days                    the installation's retention
//   sources               3            no limit                   no limit            no limit
//   dashboards            1 × 8        50 × 24                    50 × 24             50 × 24
//   pin to a page         yes          yes                        yes                 yes
//   alerts                none         all                        threshold           all
//   usual range, What     no           yes                        no                  yes
//   changed
//
// Nothing here is billed: Pro's allowance follows the nodes and servers it already pays for.
import type { CloudPlan } from './plans.js';

/** Which alert conditions on own metrics an edition may create. */
export type OwnAlerts = 'none' | 'threshold' | 'all';

export interface OwnMetricLimits {
  /** Own-metric series the org may have active at once. */
  series: number;
  /** Series one scraped endpoint or one token's pushes may bring (sourceSeriesCap). */
  seriesPerSource: number;
  /** Sources the org may have; null is no limit. */
  sources: number | null;
  dashboards: number;
  widgetsPerDashboard: number;
  /** Pinning to a workload's or a server's page: every edition. */
  pin: true;
  alerts: OwnAlerts;
  /** The usual range, "outside its usual range" alerts and What changed on own metrics. */
  usualRange: boolean;
  /** Metrics that may be watched with What changed at once (Pro). */
  watched: number;
}

/** Cloud Free's numbers. */
export const OWN_FREE = {
  series: 200,
  seriesPerSource: 100,
  sources: 3,
  dashboards: 1,
  widgetsPerDashboard: 8,
} as const;

/** Pro's, and every self-hosted installation's. */
export const OWN_PAID = {
  /** Cloud Pro: for each billed node or server. */
  seriesPerNode: 200,
  /** Cloud Pro's floor: the 5 nodes its minimum bill covers (ADR-215). */
  seriesFloor: 1000,
  seriesPerSource: 500,
  dashboards: 50,
  widgetsPerDashboard: 24,
} as const;

/** A self-hosted installation's cap unless WATCHLOG_OWN_METRIC_SERIES sets another. */
export const OWN_SELF_HOSTED_SERIES = 20_000;
/** Metrics watched with What changed at once, per org (ADR-238). */
export const OWN_WATCHED = 50;
/** A label with more values than this on one metric makes the metric refused. */
export const OWN_LABEL_VALUES = 100;
/** Metrics pinned to one workload's or server's page. */
export const OWN_PINS_PER_PAGE = 6;
/** Active own-metrics tokens (`wl_mt_`) one cluster or fleet may have. */
export const OWN_TOKENS_PER_CLUSTER = 20;
/**
 * Active own-metrics tokens an org may have over all its clusters and fleets (1.0.3: the
 * owner's number). Tokens made before it keep working; a new one is refused at the limit.
 */
export const OWN_TOKENS_PER_ORG = 20;
/** Values in one push (POST /ingest/v1/metrics). */
export const OWN_PUSH_VALUES = 500;
/** The body of one push, in bytes: room for 500 values of about 250 bytes each. */
export const OWN_PUSH_BYTES = 128 * 1024;

/**
 * The series one source may bring, or null when only the org's allowance limits it: a token's
 * remote write (1.0.1, ADR-240). One Prometheus sends thousands of series through one token,
 * so the cap that fits an endpoint cut it at 500; the org's allowance already bounds it.
 */
export function sourceSeriesCap(kind: string, limits: OwnMetricLimits): number | null {
  return kind === 'remote_write' ? null : limits.seriesPerSource;
}

export interface OwnMetricEdition {
  edition: 'community' | 'cloud';
  /** Cloud: the org's plan. */
  plan?: CloudPlan;
  /** Cloud Pro: the nodes and servers the org is billed for now. */
  billedNodes?: number;
  /** Self-hosted: the installation's cap (config.ownMetricSeries). */
  installationSeries?: number;
  /** Whether the org has the Pro features (Cloud's plan, the demo, or a licence with `pro`). */
  pro: boolean;
}

/** The limits of one org, from its edition and plan. */
export function ownMetricLimits(e: OwnMetricEdition): OwnMetricLimits {
  const paid = {
    seriesPerSource: OWN_PAID.seriesPerSource,
    sources: null,
    dashboards: OWN_PAID.dashboards,
    widgetsPerDashboard: OWN_PAID.widgetsPerDashboard,
    pin: true as const,
    watched: OWN_WATCHED,
  };
  if (e.edition === 'cloud') {
    if (!e.plan || e.plan === 'free') {
      return {
        ...OWN_FREE,
        pin: true,
        alerts: 'none',
        usualRange: false,
        watched: 0,
      };
    }
    return {
      ...paid,
      series: Math.max(
        OWN_PAID.seriesFloor,
        OWN_PAID.seriesPerNode * Math.max(0, e.billedNodes ?? 0),
      ),
      alerts: 'all',
      usualRange: true,
    };
  }
  // Self-hosted: the installation's cap; a licence with `pro` adds the usual range.
  return {
    ...paid,
    series: e.installationSeries ?? OWN_SELF_HOSTED_SERIES,
    alerts: e.pro ? 'all' : 'threshold',
    usualRange: e.pro,
    watched: e.pro ? OWN_WATCHED : 0,
  };
}
