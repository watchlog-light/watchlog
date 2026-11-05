// SPDX-License-Identifier: AGPL-3.0-only
// An alert's chart in the web: markers, shaded ranges, thresholds, state timelines and
// dates (never a raw ISO timestamp).
import { mount } from '@vue/test-utils';
import type { AlertChart } from '@watchlog/api-types';
import { describe, expect, it } from 'vitest';
import StateTimeline from '@/components/alerts/StateTimeline.vue';
import { createAppI18n } from '@/i18n';
import { chartAreas, chartMarkers, conditionThresholds, markerLegend } from '@/lib/alert-chart';
import { formatWhen } from '@/lib/format';

const i18n = createAppI18n();
const t = i18n.global.t as (k: string, v?: Record<string, unknown>) => string;
const at = (hhmm: string) => Date.parse(`2026-11-01T${hhmm}:00`) / 1000;

describe('dates on the alert page', () => {
  it('shows the time for today and the date with it for another day', () => {
    const now = Date.parse('2026-11-01T23:00:00');
    expect(formatWhen(new Date('2026-11-01T21:42:00').toISOString(), now)).toBe('21:42');
    expect(formatWhen(new Date('2026-10-31T21:42:00').toISOString(), now)).toBe('Oct 31, 21:42');
  });
});

describe('chart decorations', () => {
  const chart = {
    window: { from: at('20:00'), to: at('23:00') },
    panels: [],
    markers: [
      { ts: at('21:45'), kind: 'started' },
      { ts: at('21:45'), kind: 'fired' },
      {
        ts: at('21:46'),
        kind: 'notification',
        channel: 'ops slack',
        status: 'failed',
        messageKind: 'firing',
      },
      { ts: at('22:10'), kind: 'oom' },
      { ts: at('21:42'), kind: 'lastData' },
    ],
    firing: { from: at('21:45'), to: at('23:00') },
    episodes: [{ from: at('20:10'), to: at('20:20') }],
    gaps: [{ from: at('21:00'), to: at('21:30') }],
    silent: { from: at('21:42'), to: at('23:00') },
    ruleChanged: null,
  } as AlertChart;
  const now = Date.parse('2026-11-01T23:00:00');

  it('names every marker in words, with a colour that agrees', () => {
    const m = chartMarkers(chart, 'warning', t, now);
    expect(m.map((x) => x.label)).toEqual([
      'Condition started 21:45',
      'Fired 21:45',
      'Firing to ops slack · Failed 21:46',
      'OOM kill 22:10',
      'Last data 21:42',
    ]);
    expect(m.map((x) => x.colorToken)).toEqual([
      '--text-subtle',
      '--warning',
      '--critical',
      '--critical',
      '--warning',
    ]);
  });

  it('shades the firing period in its severity, earlier episodes faintly, gaps and silence', () => {
    const a = chartAreas(chart, 'critical', t);
    expect(a.map((x) => [x.label, x.colorToken])).toEqual([
      ['Earlier episode', '--text-subtle'],
      ['Firing', '--critical'],
      ['No data', '--critical'],
      ['Alerting not running', '--text-subtle'],
    ]);
    expect(a[0]!.opacity).toBeLessThan(a[1]!.opacity);
  });

  it('lists repeated OOM kills as one line, the chart still marks each', () => {
    const many = {
      ...chart,
      markers: [
        { ts: at('17:00'), kind: 'started' },
        ...['17:41', '18:00', '18:30', '20:06'].map((hm) => ({ ts: at(hm), kind: 'oom' })),
      ],
    } as AlertChart;
    const markers = chartMarkers(many, 'warning', t, now);
    expect(markers).toHaveLength(5);
    expect(markerLegend(many, markers, t, now)).toEqual([
      'Condition started 17:00',
      '4 OOM kills, 17:41–20:06',
    ]);
  });

  it('labels thresholds in the rule unit, the same in the editor and on alert pages', () => {
    expect(conditionThresholds({ value: 0.85, critical: 0.95 }, 'ratio', t)).toEqual([
      { value: 0.85, label: 'Warning 85%', colorToken: '--warning' },
      { value: 0.95, label: 'Critical 95%', colorToken: '--critical' },
    ]);
    expect(conditionThresholds({ value: 512 * 2 ** 20 }, 'bytes', t)[0]!.label).toBe(
      'Warning 512 MiB',
    );
  });
});

describe('StateTimeline', () => {
  it('places segments on the window with an icon, words and a legend', () => {
    const w = mount(StateTimeline, {
      props: {
        window: { from: 0, to: 1000 },
        rows: [
          {
            name: 'Ready',
            segments: [
              { from: -100, to: 250, state: 'True', tone: 'ok' },
              { from: 250, to: 1000, state: 'False', tone: 'critical' },
            ],
          },
        ],
      },
      global: { plugins: [i18n] },
    });
    const segs = w.findAll('[data-testid="state-segment"]');
    // Clipped to the window: 0–25 % and 25–100 %.
    expect(segs.map((s) => s.attributes('style'))).toEqual([
      'left: 0%; width: 25%;',
      'left: 25%; width: 75%;',
    ]);
    expect(segs[1]!.attributes('title')).toMatch(/^False /);
    expect(segs.every((s) => s.find('svg').exists())).toBe(true);
    expect(w.get('[data-testid="state-legend"]').text()).toBe('True False');
  });
});
