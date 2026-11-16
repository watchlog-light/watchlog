// SPDX-License-Identifier: AGPL-3.0-only
// The upgrade page (ADR-201): what Cloud Free and Community see in place of What changed.
// Which button it offers, the price as the plans config gives it, the org's own last alerts,
// and the live demo's example (static: the demo's own scenario, never another org's data).
import type { Alert, WhatChanged, WhatChangedRow } from '@watchlog/api-types';

/**
 * The page's button:
 * - `checkout`: a Cloud Free Owner while billing is live opens Stripe Checkout (ADR-178);
 * - `plan`: a Cloud Free Owner while billing is off (or out of reach) opens Settings › Plan &
 *   billing, where the Pro beta switch is (Checkout would answer `billing-not-live`);
 * - `ask-owner`: an Admin or a Viewer in Cloud Free: only Owners start Checkout;
 * - `cloud`: Community, "Try WatchLog Cloud".
 */
export type UpgradeAction = 'checkout' | 'plan' | 'ask-owner' | 'cloud';

export function upgradeAction(
  access: 'free' | 'community',
  role: string | undefined,
  billing: { available: boolean; live: boolean } | null,
): UpgradeAction {
  if (access === 'community') return 'cloud';
  if (role !== 'owner') return 'ask-owner';
  return billing?.available && billing.live ? 'checkout' : 'plan';
}

/** "$1", "$10": whole amounts in the plans config's currency. */
export function money(amount: number, currency: string, locale = 'en'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** How many of the org's own alerts the page lists. */
export const LAST_ALERTS = 3;

/**
 * The org's last alerts in the cluster: firing ones and the history merged, newest start
 * first, each once.
 */
export function lastAlerts(firing: Alert[], history: Alert[], n = LAST_ALERTS): Alert[] {
  const seen = new Set<string>();
  return [...firing, ...history]
    .filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, n);
}

/** "Tue 14:02": the weekday and time an alert started, in the viewer's time zone. */
export function alertWhen(iso: string, locale = 'en'): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

export interface DemoExample {
  chart: Pick<WhatChanged, 'chart' | 'window'>;
  rows: WhatChangedRow[];
}

/**
 * The live demo's example, in the viewer's platform. Static and labelled as the demo: on
 * Kubernetes the demo's `nightly-export` job holding PostgreSQL's connections (its :20
 * scenario); on Docker the demo host's `worker` reading a batch past its 64 MiB limit (:00,
 * :20, :40). Times are 14:xx in the viewer's own day, as on the screen.
 */
export function demoExample(platform: 'kubernetes' | 'docker', now = Date.now()): DemoExample {
  const day = new Date(now);
  const at = (h: number, m: number) => {
    const d = new Date(day);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const from = at(12, 50);
  const minutes = 110;
  // A quiet morning, then the incident: a few series at most, rising sharply from 14:18.
  const counts = Array.from({ length: minutes }, (_, i) => {
    const x = i / (minutes - 1);
    const base = 1 + Math.round(Math.sin(i * 0.55) + 0.6 * Math.sin(i * 1.9));
    return Math.max(0, base + Math.round(9 * Math.exp(-(((x - 0.79) / 0.06) ** 2))));
  });
  const chart: DemoExample['chart'] = {
    chart: { from, to: at(14, 40), step: 60, counts },
    window: { from: at(14, 10), to: at(14, 35), alert: null },
  };
  const row = (r: Partial<WhatChangedRow> & Pick<WhatChangedRow, 'id' | 'key' | 'unit'>) =>
    ({
      until: null,
      subject: {},
      peer: null,
      peakAt: r.since,
      ...r,
    }) as WhatChangedRow;
  if (platform === 'docker') {
    return {
      chart,
      rows: [
        row({
          id: 'demo-d1',
          since: at(14, 20),
          key: 'container.memory.working_set',
          unit: 'bytes',
          object: {
            kind: 'container',
            name: 'storefront-worker-1',
            host: 'demo-docker',
            composeProject: 'storefront',
            composeService: 'worker',
          },
          usualLow: 18 * 2 ** 20,
          usualHigh: 26 * 2 ** 20,
          value: 64 * 2 ** 20,
          peakScore: 40,
        } as WhatChangedRow),
        row({
          id: 'demo-d2',
          since: at(14, 21),
          key: 'container.cpu.usage',
          unit: 'cores',
          object: {
            kind: 'container',
            name: 'storefront-worker-1',
            host: 'demo-docker',
            composeProject: 'storefront',
            composeService: 'worker',
          },
          usualLow: 0.01,
          usualHigh: 0.03,
          value: 0.4,
          peakScore: 30,
        } as WhatChangedRow),
        row({
          id: 'demo-d3',
          since: at(14, 22),
          key: 'workload.http.errors.ratio',
          unit: 'ratio',
          object: {
            kind: 'container',
            name: 'storefront-orders-1',
            host: 'demo-docker',
            composeProject: 'storefront',
            composeService: 'orders',
          },
          usualLow: 0,
          usualHigh: 0.01,
          value: 0.18,
          peakScore: 22,
        } as WhatChangedRow),
      ],
    };
  }
  return {
    chart,
    rows: [
      row({
        id: 'demo-k1',
        since: at(14, 20),
        key: 'postgres.connections',
        unit: 'count',
        object: { kind: 'service', name: 'postgres' },
        usualLow: 18,
        usualHigh: 30,
        value: 97,
        peakScore: 40,
      } as WhatChangedRow),
      row({
        id: 'demo-k2',
        since: at(14, 21),
        key: 'workload.http.latency.p95',
        unit: 'seconds',
        object: {
          kind: 'workload',
          name: 'backend',
          namespace: 'shop',
          workloadKind: 'Deployment',
        },
        usualLow: 0.04,
        usualHigh: 0.09,
        value: 2.1,
        peakScore: 34,
      } as WhatChangedRow),
      row({
        id: 'demo-k3',
        since: at(14, 22),
        key: 'workload.http.latency.p95',
        unit: 'seconds',
        object: { kind: 'workload', name: 'api', namespace: 'shop', workloadKind: 'Deployment' },
        usualLow: 0.12,
        usualHigh: 0.18,
        value: 2.4,
        peakScore: 30,
      } as WhatChangedRow),
    ],
  };
}
