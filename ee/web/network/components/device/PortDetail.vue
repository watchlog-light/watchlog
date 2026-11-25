<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { ArrowRight } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { RouteLocationRaw } from 'vue-router';
import { chartFailure } from '@/lib/chart-error';
import TimeSeriesChart, { type ChartSeries } from '@/components/charts/TimeSeriesChart.vue';
import { since } from '@/lib/time';
import { networkApi, type DeviceDetail, type DeviceSeries, type Port } from '../../api';
import { speedLong } from '../../lib/format';
import { portState } from '../../lib/front-panel';

// The picked port (ADR-233): its traffic both ways against its speed, its errors and discards,
// what is on the other end (a neighbour, or the endpoints learnt on it), its VLANs and PoE.
const props = defineProps<{
  deviceId: string;
  port: Port;
  endpoints: DeviceDetail['endpoints'];
  range: number;
}>();
const { t } = useI18n();

const series = ref<DeviceSeries | null>(null);
const loading = ref(false);
const failed = ref(false);
/** A refusal's own words without Retry (0.17.1), else the chart's message with Retry. */
const failure = ref<{ text: string | null; retry: boolean }>({ text: null, retry: true });
let seq = 0;
async function load() {
  const mine = ++seq;
  loading.value = true;
  failed.value = false;
  try {
    const s = await networkApi.series(props.deviceId, props.range, props.port.name);
    if (mine === seq) series.value = s;
  } catch (err) {
    if (mine === seq) {
      failed.value = true;
      failure.value = chartFailure(err);
    }
  } finally {
    if (mine === seq) loading.value = false;
  }
}
watch(() => [props.deviceId, props.port.name, props.range], load, { immediate: true });

const windowOf = computed<[number, number]>(() => {
  const to = Math.floor(Date.now() / 1000);
  return [to - props.range, to];
});

// Bits per second as bytes per second: the charts' byte-rate unit.
const toBytes = (pts: [number, number | null][]) =>
  pts.map(([ts, v]) => [ts, v == null ? null : v / 8]);
const traffic = computed<ChartSeries[]>(() => {
  const p = series.value?.port;
  if (!p) return [];
  return [
    { name: t('netDevice.port.in'), points: toBytes(p.inBps), colorToken: '--info' },
    { name: t('netDevice.port.out'), points: toBytes(p.outBps), colorToken: '--ok' },
  ];
});
const speedLine = computed(() =>
  props.port.speedMbps
    ? [
        {
          value: (props.port.speedMbps * 1e6) / 8,
          label: t('netDevice.port.speedLine', { speed: speedLong(props.port.speedMbps) }),
          colorToken: '--text-subtle',
        },
      ]
    : [],
);
const faults = computed<ChartSeries[]>(() => {
  const p = series.value?.port;
  if (!p) return [];
  return [
    { name: t('netDevice.port.errors'), points: p.errors, colorToken: '--critical' },
    { name: t('netDevice.port.discards'), points: p.discards, colorToken: '--warning' },
  ];
});

const state = computed(() =>
  portState(
    props.port,
    props.endpoints.some((e) => e.node),
  ),
);
const PILL = {
  up: 'bg-ok/15 text-ok-text',
  errors: 'bg-warning/15 text-warning-text',
  down: 'bg-critical/15 text-critical-text',
  idle: 'bg-surface-3 text-text-muted',
  'admin-down': 'bg-surface-3 text-text-muted',
} as const;

const facts = computed(() => {
  const p = props.port;
  const out: string[] = [];
  if (p.operUp) out.push(speedLong(p.speedMbps));
  if (p.operUp && p.usualSpeedMbps && p.speedMbps && p.speedMbps < p.usualSpeedMbps) {
    out.push(t('netDevice.port.slower', { usual: speedLong(p.usualSpeedMbps) }));
  }
  if (p.changedAt) out.push(t('netDevice.port.changed', { t: since(p.changedAt) }));
  return out;
});

function nodeLink(n: NonNullable<DeviceDetail['endpoints'][number]['node']>): RouteLocationRaw {
  return n.kind === 'kubernetes'
    ? { name: 'node', params: { name: n.name }, query: { cluster: n.clusterId } }
    : { name: 'server', params: { server: n.name }, query: { cluster: n.clusterId } };
}
</script>

<template>
  <div
    class="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface-2 p-4"
    data-testid="port-detail"
  >
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h3 class="font-mono text-16 text-text">{{ port.name }}</h3>
      <span
        class="inline-flex h-6 items-center rounded-full px-2.5 text-12 font-semibold"
        :class="PILL[state]"
        >{{ $t(`netDevice.portState.${state}`) }}</span
      >
    </div>
    <p v-if="port.alias || port.descr" class="text-14 text-text">{{ port.alias || port.descr }}</p>
    <p class="text-13 text-text-muted">
      <span v-for="(f, i) in facts" :key="i"><template v-if="i"> · </template>{{ f }}</span>
    </p>

    <TimeSeriesChart
      :title="$t('netDevice.port.traffic')"
      unit="bytes_per_second"
      :series="traffic"
      :thresholds="speedLine"
      :window="windowOf"
      :loading="loading"
      :error="failed"
      :empty-text="$t('netDevice.charts.empty')"
      :error-text="failure.text ?? $t('netDevice.charts.error')"
      :no-retry="!failure.retry"
      plain
      @retry="load"
    />
    <TimeSeriesChart
      :title="$t('netDevice.port.faults')"
      unit="load"
      :series="faults"
      :window="windowOf"
      :loading="loading"
      :error="failed"
      :empty-text="$t('netDevice.charts.empty')"
      :error-text="failure.text ?? $t('netDevice.charts.error')"
      :no-retry="!failure.retry"
      :zero-text="$t('netDevice.port.noFaults')"
      plain
      @retry="load"
    />

    <dl class="grid gap-3 text-13 sm:grid-cols-2">
      <div class="flex flex-col gap-1">
        <dt class="text-11 tracking-[0.08em] text-text-subtle uppercase">
          {{ $t('netDevice.port.vlans') }}
        </dt>
        <dd class="font-mono text-text">{{ port.vlans.length ? port.vlans.join(', ') : '–' }}</dd>
      </div>
      <div class="flex flex-col gap-1">
        <dt class="text-11 tracking-[0.08em] text-text-subtle uppercase">
          {{ $t('netDevice.port.poe') }}
        </dt>
        <dd class="text-text">
          {{
            port.poeWatts
              ? $t('netDevice.port.poeDraw', { w: port.poeWatts.toFixed(1) })
              : $t('netDevice.port.noPoe')
          }}
        </dd>
      </div>
    </dl>

    <div class="flex flex-col gap-2">
      <h4 class="text-11 tracking-[0.08em] text-text-subtle uppercase">
        {{ $t('netDevice.port.otherEnd') }}
      </h4>
      <RouterLink
        v-if="port.neighbour"
        :to="{
          name: 'network-device',
          params: { id: port.neighbour.deviceId },
          query: { port: port.neighbour.port },
        }"
        class="flex items-center gap-2 rounded-control border border-border bg-surface-1 px-3 py-2 text-13 hover:bg-surface-3 max-lg:min-h-11"
        data-testid="port-neighbour"
      >
        <span class="font-mono">{{ port.name }}</span>
        <ArrowRight class="size-4 text-text-muted" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate text-text">{{ port.neighbour.device }}</span>
        <span class="font-mono text-text-muted">{{ port.neighbour.port }}</span>
      </RouterLink>
      <div
        v-else-if="endpoints.length"
        class="overflow-x-auto rounded-control border border-border"
      >
        <table class="w-full min-w-[480px] text-13" data-testid="port-endpoints">
          <thead class="text-11 tracking-[0.08em] text-text-subtle uppercase">
            <tr class="border-b border-border text-left">
              <th class="px-3 py-2 font-normal">{{ $t('netDevice.endpoints.mac') }}</th>
              <th class="px-3 py-2 font-normal">{{ $t('netDevice.endpoints.ip') }}</th>
              <th class="px-3 py-2 font-normal">{{ $t('netDevice.endpoints.vendor') }}</th>
              <th class="px-3 py-2 font-normal">{{ $t('netDevice.endpoints.watchlog') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in endpoints" :key="e.mac" class="border-b border-border last:border-0">
              <td class="px-3 py-2 font-mono">{{ e.mac }}</td>
              <td class="px-3 py-2 font-mono text-text-muted">{{ e.ip ?? '–' }}</td>
              <td class="px-3 py-2 text-text-muted">{{ e.vendor || '–' }}</td>
              <td class="px-3 py-2">
                <RouterLink
                  v-if="e.node"
                  :to="nodeLink(e.node)"
                  class="text-link hover:underline max-lg:inline-flex max-lg:min-h-11 max-lg:items-center max-lg:gap-1"
                >
                  {{ e.node.name }}
                  <span class="text-text-muted">· {{ e.node.cluster }}</span>
                </RouterLink>
                <span v-else class="text-text-subtle">–</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="text-13 text-text-muted">{{ $t('netDevice.port.nothing') }}</p>
    </div>
  </div>
</template>
