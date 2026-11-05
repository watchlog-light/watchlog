// SPDX-License-Identifier: AGPL-3.0-only
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createAppI18n } from '@/i18n';

const setOption = vi.fn();
vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => ({ setOption, resize: vi.fn(), dispose: vi.fn() })),
}));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
);

const { default: TimeSeriesChart } = await import('@/components/charts/TimeSeriesChart.vue');
type ChartSeries = { name: string; points: (number | null)[][] };

const props = { title: 'CPU', unit: 'cores' as const, emptyText: 'No data', errorText: 'Failed' };
const i18n = createAppI18n();
const mountChart = (
  extra: Partial<InstanceType<typeof TimeSeriesChart>['$props']> & { series: ChartSeries[] },
) => mount(TimeSeriesChart, { props: { ...props, ...extra }, global: { plugins: [i18n] } });
const POINTS: ChartSeries = { name: 'usage', points: [[1793400000, 0.5]] };

setActivePinia(createPinia());
afterEach(() => vi.useRealTimers());

describe('TimeSeriesChart', () => {
  it('shows the empty text without data', () => {
    const w = mountChart({ series: [] });
    expect(w.text()).toContain('No data');
  });

  it('shows the error text with a Retry button on errors', async () => {
    const w = mountChart({ series: [], error: true });
    expect(w.get('[role="alert"]').text()).toContain('Failed');
    await w.get('[data-testid="chart-retry"]').trigger('click');
    expect(w.emitted('retry')).toHaveLength(1);
  });

  it('shows a skeleton only when the first load takes longer than 150 ms', async () => {
    vi.useFakeTimers();
    const w = mountChart({ series: [], loading: true });
    await vi.advanceTimersByTimeAsync(140);
    expect(w.find('[data-testid="chart-skeleton"]').exists()).toBe(false);
    expect(w.text()).not.toContain('No data');
    await vi.advanceTimersByTimeAsync(20);
    expect(w.find('[data-testid="chart-skeleton"]').exists()).toBe(true);

    await w.setProps({ loading: false, series: [POINTS] });
    expect(w.find('[data-testid="chart-skeleton"]').exists()).toBe(false);
  });

  it('never flashes a skeleton for a fast response', async () => {
    vi.useFakeTimers();
    const w = mountChart({ series: [], loading: true });
    await vi.advanceTimersByTimeAsync(80);
    await w.setProps({ loading: false, series: [POINTS] });
    await vi.advanceTimersByTimeAsync(500);
    expect(w.find('[data-testid="chart-skeleton"]').exists()).toBe(false);
  });

  it('keeps the chart on refetch and shows a small indicator instead', async () => {
    vi.useFakeTimers();
    const w = mountChart({ series: [POINTS], loading: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(w.find('[data-testid="chart-skeleton"]').exists()).toBe(false);
    expect(w.find('[data-testid="refreshing"]').exists()).toBe(true);
    expect(w.get('[data-testid="chart"]').classes()).not.toContain('invisible');
  });

  it('passes series to ECharts with timestamps in milliseconds and token colours', () => {
    document.documentElement.style.setProperty('--chart-1', 'var-chart-1');
    mount(TimeSeriesChart, {
      global: { plugins: [i18n] },
      props: {
        ...props,
        series: [
          {
            name: 'usage',
            points: [
              [1793400000, 0.5],
              [1793400015, null],
            ],
          },
        ],
      },
    });
    const option = setOption.mock.calls.at(-1)![0];
    expect(option.series[0]).toMatchObject({
      name: 'usage',
      data: [
        [1793400000000, 0.5],
        [1793400015000, null],
      ],
    });
    expect(option.color[0]).toBe('var-chart-1');
    expect(option.yAxis.axisLabel.formatter(0.25)).toBe('0.25');
    expect(option.yAxis.interval).toBeUndefined();
    // The x axis spans the selected range (1 h by default), whatever the data covers.
    expect(option.xAxis.max - option.xAxis.min).toBe(3_600_000);
    expect(option.series[0].showSymbol).toBe(true); // a single point stays visible
  });

  it('draws change markers in range and dotted request lines that are not data', () => {
    const now = Math.floor(Date.now() / 1000);
    const w = mount(TimeSeriesChart, {
      global: { plugins: [i18n] },
      props: {
        ...props,
        series: [
          { name: 'usage', points: [[now - 60, 0.2]] },
          {
            name: 'request',
            points: [
              [now - 3600, 0.5],
              [now, 0.5],
            ],
            dotted: true,
          },
        ],
        markers: [
          { ts: now - 120, label: 'Rollout Deployment web: revision 1 → 2' },
          { ts: now - 7200, label: 'outside the range' },
        ],
      },
    });
    const option = setOption.mock.calls.at(-1)![0];
    expect(
      option.series[0].markLine.data.map((d: { xAxis: number; name: string }) => [d.xAxis, d.name]),
    ).toEqual([[(now - 120) * 1000, 'Rollout Deployment web: revision 1 → 2']]);
    expect(option.series[1].lineStyle.type).toBe('dotted');
    expect(option.series[1].markLine).toBeUndefined();
    expect(w.get('[data-testid="chart-markers"]').text()).toBe(
      'Rollout Deployment web: revision 1 → 2',
    );

    // A request line alone is not data: the chart says "No data".
    const only = mount(TimeSeriesChart, {
      global: { plugins: [i18n] },
      props: { ...props, series: [{ name: 'request', points: [[now, 0.5]], dotted: true }] },
    });
    expect(only.text()).toContain('No data');
  });

  it('gives byte axes binary-round ticks', () => {
    const MiB = 1024 ** 2;
    mount(TimeSeriesChart, {
      global: { plugins: [i18n] },
      props: {
        ...props,
        unit: 'bytes',
        series: [{ name: 'memory', points: [[1793400000, 19.2 * MiB]] }],
      },
    });
    const option = setOption.mock.calls.at(-1)![0];
    expect(option.yAxis).toMatchObject({ interval: 5 * MiB, max: 20 * MiB });
    expect(option.yAxis.axisLabel.formatter(10 * MiB)).toBe('10 MiB');
  });

  it('shows a calm note instead of a flat zero line, and draws limits dashed', () => {
    const w = mount(TimeSeriesChart, {
      global: { plugins: [i18n] },
      props: {
        ...props,
        unit: 'bytes',
        zeroText: 'No disk activity in this range',
        note: 'No memory limit',
        series: [
          {
            name: 'read',
            points: [
              [1793400000, 0],
              [1793400015, 0],
            ],
          },
        ],
      },
    });
    expect(w.get('[data-testid="chart-zero"]').text()).toBe('No disk activity in this range');
    expect(w.get('[data-testid="chart"]').classes()).toContain('invisible');
    expect(w.get('[data-testid="chart-note"]').text()).toContain('No memory limit');

    document.documentElement.style.setProperty('--warning', 'warning-token');
    mount(TimeSeriesChart, {
      global: { plugins: [i18n] },
      props: {
        ...props,
        unit: 'bytes',
        series: [
          { name: 'working set', points: [[1793400000, 5]] },
          { name: 'limit', points: [[1793400000, 10]], dashed: true },
          { name: 'Warning', points: [[1793400000, 8]], dotted: true, colorToken: '--warning' },
        ],
      },
    });
    const option = setOption.mock.calls.at(-1)![0];
    document.documentElement.style.removeProperty('--warning');
    expect(option.series[1].lineStyle.type).toBe('dashed');
    expect(option.series[0].lineStyle.type).toBe('solid');
    // Threshold lines take their severity's token, not the next palette colour.
    expect(option.series[2].color).toBe('warning-token');
    expect(option.series[0].color).toBeUndefined();
  });

  it('draws an alert window: steps, labelled thresholds, shaded ranges and coloured markers', () => {
    document.documentElement.style.setProperty('--critical', 'critical-token');
    mountChart({
      unit: 'count',
      window: [1793400000, 1793403600],
      series: [
        {
          name: 'restarts',
          points: [
            [1793400000, 1],
            [1793401000, 4],
          ],
          step: true,
        },
      ],
      thresholds: [{ value: 3, label: 'Warning 3', colorToken: '--critical' }],
      areas: [
        {
          from: 1793401000,
          to: 1793409999,
          label: 'Firing',
          colorToken: '--critical',
          opacity: 0.1,
        },
        {
          from: 1793300000,
          to: 1793300100,
          label: 'outside',
          colorToken: '--critical',
          opacity: 0.1,
        },
      ],
      markers: [
        { ts: 1793401000, label: 'Fired', colorToken: '--critical' },
        { ts: 1793300000, label: 'Before the window' },
      ],
    });
    document.documentElement.style.removeProperty('--critical');
    const option = setOption.mock.calls.at(-1)![0];
    // The alert's window, not the top bar's range.
    expect([option.xAxis.min, option.xAxis.max]).toEqual([1793400000000, 1793403600000]);
    expect(option.series[0].step).toBe('end');
    const lines = option.series[0].markLine.data;
    expect(lines.map((d: { name: string }) => d.name)).toEqual(['Fired', 'Warning 3']);
    expect(lines[0].lineStyle.color).toBe('critical-token');
    expect(lines[1]).toMatchObject({ yAxis: 3, label: { show: true } });
    // Shaded ranges are clipped to the window; ranges outside it are dropped.
    expect(option.series[0].markArea.data).toEqual([
      [
        {
          xAxis: 1793401000000,
          name: 'Firing',
          itemStyle: { color: 'critical-token', opacity: 0.1 },
        },
        { xAxis: 1793403600000 },
      ],
    ]);
    // A threshold above the data stays inside the axis, on round ticks.
    const { max, interval } = option.yAxis;
    expect(max).toBeGreaterThanOrEqual(3 * 1.05);
    expect(Number.isInteger(+(max / interval).toFixed(9))).toBe(true);
    expect([1, 2, 5]).toContain(+(interval / 10 ** Math.floor(Math.log10(interval))).toFixed(9));
  });

  it('gives an all-zero byte series a 0–1 B axis', () => {
    mountChart({ unit: 'bytes', series: [{ name: 'read', points: [[1793400000, 0]] }] });
    const yAxis = setOption.mock.calls.at(-1)![0].yAxis;
    expect(yAxis).toMatchObject({ interval: 1, max: 1 });
  });
});
