// SPDX-License-Identifier: AGPL-3.0-only
// An alert's chart (alert detail page and the rule editor's preview) turned into what
// TimeSeriesChart draws: labelled threshold lines, shaded ranges and coloured markers.
// Colours are token names; every marker and range also has words, so severity and
// state are never colour only.
import type { AlertChart, AlertChartPanel } from '@watchlog/api-types';
import type {
  ChartArea,
  ChartMarker,
  ChartSeries,
  ChartThreshold,
} from '@/components/charts/TimeSeriesChart.vue';
import { formatWhen } from '@/lib/format';
import { formatValue, type Unit } from '@/lib/units';

type T = (key: string, values?: Record<string, unknown>) => string;

const SEVERITY_TOKEN: Record<string, string> = { warning: '--warning', critical: '--critical' };
const THRESHOLD_TOKEN: Record<string, string> = {
  warning: '--warning',
  critical: '--critical',
  limit: '--critical',
};
const iso = (ts: number) => new Date(ts * 1000).toISOString();

export function panelThresholds(p: AlertChartPanel, t: T): ChartThreshold[] {
  return p.thresholds.map((th) => ({
    value: th.value,
    label: t(`alerts.chart.threshold.${th.kind}`, {
      value: formatValue(th.value, (p.unit ?? 'count') as Unit),
    }),
    colorToken: THRESHOLD_TOKEN[th.kind]!,
  }));
}

export function panelSeries(p: AlertChartPanel, t: T): ChartSeries[] {
  return p.lines.map((l) => ({
    // Replica lines are named by their state ("desired", "ready").
    name: p.id === 'replicas' ? t(`alerts.chart.replicas.${l.name}`) : l.name,
    points: l.points as (number | null)[][],
    ...(l.step ? { step: true } : {}),
  }));
}

/** Vertical markers with the words shown on hover ("Fired 21:45", "ops slack · failed"). */
export function chartMarkers(
  c: AlertChart,
  severity: string,
  t: T,
  now = Date.now(),
): ChartMarker[] {
  return c.markers.map((m) => {
    const at = formatWhen(iso(m.ts), now);
    if (m.kind === 'notification') {
      return {
        ts: m.ts,
        label: t('alerts.chart.marker.notification', {
          kind: t(`alerts.kinds.${m.messageKind ?? 'firing'}`),
          channel: m.channel || t('alerts.detail.deletedChannel'),
          status: t(`alerts.delivery.${m.status ?? 'pending'}`),
          at,
        }),
        colorToken:
          m.status === 'failed' ? '--critical' : m.status === 'sent' ? '--ok' : '--text-subtle',
      };
    }
    const token: Record<string, string> = {
      started: '--text-subtle',
      fired: SEVERITY_TOKEN[severity] ?? '--critical',
      resolved: '--ok',
      silenced: '--text-muted',
      oom: '--critical',
      lastData: '--warning',
    };
    return {
      ts: m.ts,
      label: t(`alerts.chart.marker.${m.kind}`, { at }),
      colorToken: token[m.kind],
    };
  });
}

/** The firing period, earlier episodes (faint), alerting gaps and an agent's silence. */
export function chartAreas(c: AlertChart, severity: string, t: T): ChartArea[] {
  const out: ChartArea[] = [];
  for (const e of c.episodes) {
    out.push({
      ...e,
      label: t('alerts.chart.area.episode'),
      colorToken: '--text-subtle',
      opacity: 0.08,
    });
  }
  if (c.firing) {
    out.push({
      ...c.firing,
      label: t('alerts.chart.area.firing'),
      colorToken: SEVERITY_TOKEN[severity] ?? '--critical',
      opacity: 0.14,
    });
  }
  if (c.silent) {
    out.push({
      ...c.silent,
      label: t('alerts.chart.area.silent'),
      colorToken: '--critical',
      opacity: 0.06,
    });
  }
  for (const g of c.gaps) {
    out.push({
      ...g,
      label: t('alerts.chart.area.gap'),
      colorToken: '--text-subtle',
      opacity: 0.08,
    });
  }
  return out;
}

/** The rule editor's condition as the same labelled lines ("Warning 85%", "Critical 95%"). */
export function conditionThresholds(
  c: { value: number; critical?: number } | null,
  unit: Unit,
  t: T,
): ChartThreshold[] {
  if (!c) return [];
  const panel = {
    unit,
    thresholds: [
      { kind: 'warning' as const, value: c.value },
      ...(c.critical !== undefined ? [{ kind: 'critical' as const, value: c.critical }] : []),
    ],
  } as unknown as AlertChartPanel;
  return panelThresholds(panel, t);
}

/**
 * The visible marker list: repeated OOM kills collapse into one line ("31 OOM kills,
 * 17:41–20:06") so the list stays short; the chart still draws every one.
 */
export function markerLegend(
  c: AlertChart,
  markers: ChartMarker[],
  t: T,
  now = Date.now(),
): string[] {
  const ooms = c.markers.filter((m) => m.kind === 'oom');
  if (ooms.length <= 3) return markers.map((m) => m.label);
  const out: string[] = [];
  let summarised = false;
  c.markers.forEach((m, i) => {
    if (m.kind !== 'oom') {
      out.push(markers[i]!.label);
    } else if (!summarised) {
      summarised = true;
      out.push(
        t('alerts.chart.marker.oomMany', {
          n: ooms.length,
          from: formatWhen(iso(ooms[0]!.ts), now),
          to: formatWhen(iso(ooms.at(-1)!.ts), now),
        }),
      );
    }
  });
  return out;
}
