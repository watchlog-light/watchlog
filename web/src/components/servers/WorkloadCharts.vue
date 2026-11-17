<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { MetricKey, RangeQueryResponse } from '@watchlog/api-types';
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import TimeSeriesChart, {
  type ChartMarker,
  type ChartSeries,
} from '@/components/charts/TimeSeriesChart.vue';
import { useRangeQuery } from '@/composables/useRangeQuery';

// A server workload's charts over the top bar's time range (the pod and container pages'
// layout and window, the demo's 24-hour cap included): a service's unit.* series or a
// process group's process.* series, with its releases marked. Mounted per workload (keyed),
// so it runs only its own kind's queries. Containers have their own page.
const props = defineProps<{
  clusterId: string;
  host: string;
  source: 'service' | 'process';
  name: string;
  /** A process group's systemd unit: its MemoryMax is the group's memory limit line. */
  unit: string | null;
  /** When the executable changed on disk (unix seconds), within the page's last hour. */
  releases: number[];
}>();
const emit = defineEmits<{
  /** The latest values the page's tiles show (a service's throttling and disk I/O). */
  latest: [v: { throttled: number | null; ioRead: number | null; ioWrite: number | null }];
}>();
const { t } = useI18n();

const own = computed(() =>
  props.source === 'service'
    ? { host: props.host, unit: props.name }
    : { host: props.host, group: props.name },
);
const unitScope = computed(() => ({ host: props.host, unit: props.unit ?? props.name }));
const q = (key: MetricKey, scope = own) => useRangeQuery(() => props.clusterId, key, scope);
const service = props.source === 'service';
// A process group outside a unit has no MemoryMax to draw; the query isn't run.
const hasUnitLimit = service || !!props.unit;

const cpu = q(service ? 'unit.cpu.usage' : 'process.cpu.usage');
const cpuLimit = service ? q('unit.cpu.limit') : null;
const throttled = service ? q('unit.cpu.throttled_share') : null;
const memory = q(service ? 'unit.memory.working_set' : 'process.memory.rss');
const memoryLimit = hasUnitLimit ? q('unit.memory.limit', unitScope) : null;
const tasks = service ? q('unit.tasks') : null;
const io = service ? q('unit.io') : null;
const instances = service ? null : q('process.instances');
const threads = service ? null : q('process.threads');
const files = service ? null : q('process.open_files');
const events = service
  ? [
      { key: 'restarts', q: q('unit.restarts.step'), color: '--warning' },
      { key: 'crashes', q: q('unit.exits.failed.step'), color: '--critical' },
      { key: 'oom', q: q('unit.oom_kills.step'), color: '--chart-4' },
    ]
  : [
      { key: 'starts', q: q('process.starts.step'), color: '--info' },
      { key: 'exits', q: q('process.exits.failed.step'), color: '--critical' },
      { key: 'oom', q: q('process.oom_kills.step'), color: '--chart-4' },
    ];

/** One series per answer, summed per timestamp (a group can span units). */
function total(data: RangeQueryResponse | null | undefined): (number | null)[][] {
  const by = new Map<number, number>();
  for (const s of data?.series ?? [])
    for (const [ts, v] of s.points) if (ts != null && v != null) by.set(ts, (by.get(ts) ?? 0) + v);
  return [...by.entries()].sort((a, b) => a[0] - b[0]);
}
const line = (name: string, data: RangeQueryResponse | null | undefined, extra = {}) => {
  const points = total(data);
  return points.length ? [{ name, points, ...extra } as ChartSeries] : [];
};
const markers = computed<ChartMarker[]>(() =>
  props.releases.map((ts) => ({
    ts,
    label: t('servers.workload.charts.release'),
    colorToken: '--info',
  })),
);

const cpuSeries = computed(() => [
  ...line(t('servers.workload.charts.usage'), cpu.data.value),
  ...line(t('servers.workload.charts.limit'), cpuLimit?.data.value, { dashed: true }),
]);
const memorySeries = computed(() => [
  ...line(
    service ? t('servers.workload.charts.workingSet') : t('servers.workload.charts.rss'),
    memory.data.value,
  ),
  ...line(t('servers.workload.charts.memoryMax'), memoryLimit?.data.value, { dashed: true }),
]);
const memoryNote = computed(() => {
  if (!memory.data.value?.series.length) return undefined;
  if (!props.unit && !service) return t('servers.workload.charts.noUnit');
  return memoryLimit?.data.value && memoryLimit.data.value.series.length === 0
    ? t('servers.workload.charts.noMemoryMax')
    : undefined;
});
const ioSeries = computed(() =>
  (io?.data.value?.series ?? []).map((s) => ({
    name: t(`servers.workload.charts.io.${s.labels.dir === 'write' ? 'write' : 'read'}`),
    points: s.points,
  })),
);
const fileSeries = computed(() => [
  ...line(t('servers.workload.charts.threads'), threads?.data.value, { step: true }),
  ...line(t('servers.workload.charts.openFiles'), files?.data.value, { step: true }),
]);
const eventSeries = computed(() =>
  events.flatMap((e) =>
    line(t(`servers.workload.charts.events.${e.key}`), e.q.data.value, {
      step: true,
      colorToken: e.color,
    }),
  ),
);
const eventsLoading = computed(() => events.some((e) => e.q.loading.value));
const eventsError = computed(() => events.every((e) => e.q.error.value));
const retryEvents = () => events.forEach((e) => e.q.refresh());

/** The window's events in one sentence, under the chart (the canvas). */
const eventsLine = computed(() => {
  const n = (key: string) =>
    Math.round(
      total(events.find((e) => e.key === key)?.q.data.value).reduce((s, p) => s + (p[1] ?? 0), 0),
    );
  const parts = events
    .map((e) => ({ key: e.key, n: n(e.key) }))
    .filter((e) => e.n > 0)
    .map((e) => t(`servers.workload.charts.eventCount.${e.key}`, { n: e.n }, e.n));
  if (props.releases.length)
    parts.push(
      t(
        'servers.workload.charts.eventCount.release',
        { n: props.releases.length },
        props.releases.length,
      ),
    );
  return parts.length
    ? t('servers.workload.charts.eventsIn', { list: parts.join(', ') })
    : t('servers.workload.charts.noEventsLine');
});

// The service's tiles: its throttled share and disk I/O, now (the last point of each).
const last = (data: RangeQueryResponse | null | undefined) => {
  const pts = total(data);
  return pts.length ? (pts[pts.length - 1]![1] ?? null) : null;
};
watch(
  () => [throttled?.data.value, io?.data.value],
  () => {
    if (!service) return;
    const dir = (d: string) =>
      last({
        ...io!.data.value!,
        series: (io!.data.value?.series ?? []).filter((x) => x.labels.dir === d),
      });
    emit('latest', {
      throttled: last(throttled?.data.value),
      ioRead: io?.data.value ? dir('read') : null,
      ioWrite: io?.data.value ? dir('write') : null,
    });
  },
  { immediate: true },
);

const empty = computed(() => t('servers.workload.charts.empty'));
const error = computed(() => t('servers.workload.charts.error'));
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-2" data-testid="workload-charts">
    <TimeSeriesChart
      :title="$t('servers.workload.charts.cpu')"
      unit="cores"
      :series="cpuSeries"
      :markers="markers"
      :loading="cpu.loading.value"
      :error="cpu.error.value"
      :empty-text="empty"
      :error-text="error"
      @retry="
        cpu.refresh();
        cpuLimit?.refresh();
      "
    />
    <TimeSeriesChart
      :title="$t('servers.workload.charts.memory')"
      unit="bytes"
      :series="memorySeries"
      :note="memoryNote"
      :markers="markers"
      :loading="memory.loading.value"
      :error="memory.error.value"
      :empty-text="empty"
      :error-text="error"
      @retry="
        memory.refresh();
        memoryLimit?.refresh();
      "
    />
    <template v-if="service">
      <TimeSeriesChart
        :title="$t('servers.workload.charts.tasks')"
        unit="count"
        :series="line($t('servers.workload.charts.tasks'), tasks?.data.value, { step: true })"
        :loading="tasks!.loading.value"
        :error="tasks!.error.value"
        :empty-text="empty"
        :error-text="error"
        @retry="tasks?.refresh()"
      />
      <TimeSeriesChart
        :title="$t('servers.workload.charts.diskIo')"
        unit="bytes_per_second"
        :series="ioSeries"
        :zero-text="$t('servers.workload.charts.noDiskActivity')"
        :loading="io!.loading.value"
        :error="io!.error.value"
        :empty-text="empty"
        :error-text="error"
        @retry="io?.refresh()"
      />
    </template>
    <template v-else>
      <TimeSeriesChart
        :title="$t('servers.workload.charts.instances')"
        unit="count"
        :series="
          line($t('servers.workload.charts.instances'), instances?.data.value, { step: true })
        "
        :markers="markers"
        :loading="instances!.loading.value"
        :error="instances!.error.value"
        :empty-text="empty"
        :error-text="error"
        @retry="instances?.refresh()"
      />
      <TimeSeriesChart
        :title="$t('servers.workload.charts.threadsFiles')"
        unit="count"
        :series="fileSeries"
        :loading="threads!.loading.value"
        :error="threads!.error.value"
        :empty-text="empty"
        :error-text="error"
        @retry="
          threads?.refresh();
          files?.refresh();
        "
      />
    </template>
    <div class="flex flex-col gap-2 lg:col-span-2" data-testid="events-chart">
      <TimeSeriesChart
        :title="
          service
            ? $t('servers.workload.charts.serviceEvents')
            : $t('servers.workload.charts.groupEvents')
        "
        unit="count"
        :series="eventSeries"
        :markers="markers"
        :zero-text="$t('servers.workload.charts.noEvents')"
        :loading="eventsLoading"
        :error="eventsError"
        :empty-text="$t('servers.workload.charts.noEvents')"
        :error-text="error"
        @retry="retryEvents"
      />
      <p class="text-13 text-text-muted" data-testid="events-line">{{ eventsLine }}</p>
    </div>
  </div>
</template>
