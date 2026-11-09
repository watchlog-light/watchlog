// SPDX-License-Identifier: AGPL-3.0-only
// The page every monitored service has before its own integration lands (ADR-135):
// whether its collector reaches each member, and how fast it connects. The series come
// from the collector's TCP check and scrape timing (agent/internal/integrations).
import { one, pointsOf, range, some, SPARK_RANGE, valueOf, instant } from './query.js';
import type { IntegrationPage, PageContext, Panel, RowMetrics } from './types.js';

const P = 'integrations.generic.panels';

async function overview(ctx: PageContext): Promise<Panel[]> {
  const s = one(ctx.row.id);
  const [connectNow, upNow, totalNow, scrapeNow, connect, up, total] = await Promise.all([
    instant(ctx, `avg(watchlog_integration_connect_seconds{${s}})`),
    instant(ctx, `sum(watchlog_integration_up{${s}})`),
    instant(ctx, `count(watchlog_integration_up{${s}})`),
    instant(ctx, `max(watchlog_integration_scrape_seconds{${s}})`),
    range(ctx, `max by (member) (watchlog_integration_connect_seconds{${s}})`),
    range(ctx, `sum(watchlog_integration_up{${s}})`),
    range(ctx, `count(watchlog_integration_up{${s}})`),
  ]);
  const upValue = valueOf(upNow);
  const totalValue = valueOf(totalNow);
  const anyData = connect.length > 0 || up.length > 0;
  return [
    {
      id: 'summary',
      title: `${P}.summary`,
      kind: 'stat',
      span: 2,
      state: totalValue === null ? 'empty' : 'ok',
      tiles: [
        {
          id: 'members',
          labelKey: `${P}.membersUp`,
          value: totalValue === null ? null : `${upValue ?? 0}/${totalValue}`,
          severity:
            totalValue === null
              ? undefined
              : (upValue ?? 0) === 0
                ? 'critical'
                : (upValue ?? 0) < totalValue
                  ? 'warning'
                  : 'ok',
        },
        {
          id: 'connect',
          labelKey: `${P}.connectTime`,
          value: valueOf(connectNow),
          unit: 'seconds',
        },
        {
          id: 'scrape',
          labelKey: `${P}.scrapeTime`,
          value: valueOf(scrapeNow),
          unit: 'seconds',
        },
      ],
    },
    {
      id: 'connect',
      title: `${P}.connect`,
      kind: 'line',
      span: 1,
      unit: 'seconds',
      state: connect.length ? 'ok' : 'empty',
      series: connect
        .map((c) => ({ name: c.labels.member ?? '', points: pointsOf(c) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    },
    {
      id: 'reachable',
      title: `${P}.reachable`,
      kind: 'line',
      span: 1,
      unit: 'count',
      state: anyData ? 'ok' : 'empty',
      series: [
        { nameKey: `${P}.series.reachable`, points: pointsOf(up[0]), severity: 'ok' },
        { nameKey: `${P}.series.members`, points: pointsOf(total[0]), dashed: true },
      ],
    },
  ];
}

export const genericPage: IntegrationPage = {
  id: 'generic',
  tabs: [{ id: 'overview', title: 'integrations.tabs.overview', panels: overview }],

  async listMetrics({ vm, clusterId, ids, now }) {
    const scope = { clusterId };
    const s = some(ids);
    const end = Math.floor(now / 1000 / 300) * 300;
    const [connect, up, total, spark] = await Promise.all([
      vm.query(scope, `avg by (service) (watchlog_integration_connect_seconds{${s}})`),
      vm.query(scope, `sum by (service) (watchlog_integration_up{${s}})`),
      vm.query(scope, `count by (service) (watchlog_integration_up{${s}})`),
      vm.queryRange(
        scope,
        `avg by (service) (watchlog_integration_connect_seconds{${s}})`,
        end - SPARK_RANGE,
        end,
        300,
      ),
    ]);
    const at = (rows: typeof connect, id: string) =>
      rows.find((r) => r.labels.service === id)?.points[0]?.[1] ?? null;
    const out = new Map<string, RowMetrics>();
    for (const id of ids) {
      const u = at(up, id);
      const t = at(total, id);
      out.set(id, {
        keyMetrics: [
          {
            id: 'connect',
            labelKey: 'integrations.generic.panels.connectTime',
            value: at(connect, id),
            unit: 'seconds',
          },
          {
            id: 'reachable',
            labelKey: 'integrations.generic.panels.series.reachable',
            value: u,
            unit: 'count',
            severity: t !== null && u !== null && u < t ? 'warning' : undefined,
          },
        ],
        spark: spark.find((r) => r.labels.service === id)?.points ?? [],
      });
    }
    return out;
  },

  async reasons() {
    return [];
  },
};
