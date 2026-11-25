<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { ArrowRight } from '@lucide/vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import TimeSeriesChart from '@/components/charts/TimeSeriesChart.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SkeletonChart from '@/components/ui/SkeletonChart.vue';
import SkeletonDetailHeader from '@/components/ui/SkeletonDetailHeader.vue';
import { ApiError } from '@/api/client';
import { chartFailure } from '@/lib/chart-error';
import { offeredRanges } from '@/lib/ranges';
import { useAuthStore } from '@/stores/auth';
import { networkApi, type DeviceDetail, type DeviceSeries } from '../api';
import DeviceElsewhere from '../components/device/DeviceElsewhere.vue';
import DeviceEvents from '../components/device/DeviceEvents.vue';
import DeviceHardware from '../components/device/DeviceHardware.vue';
import DeviceHeader from '../components/device/DeviceHeader.vue';
import DeviceSettings from '../components/device/DeviceSettings.vue';
import FrontPanel from '../components/device/FrontPanel.vue';
import PortDetail from '../components/device/PortDetail.vue';
import PortsTable from '../components/device/PortsTable.vue';
import NetworkTabs from '../components/NetworkTabs.vue';
import { pct } from '../lib/format';
import { servedPorts } from '../lib/front-panel';
import { chartPoints, deviceCharts, deviceTiles, type ChartKey } from '../lib/device-view';

// A network device (ADR-233): its facts, its ports as on its front, the picked port's traffic and
// what is on its other end, CPU, memory and temperature, its hardware, events and alerts; and
// for Owners and Admins, renaming, moving and removing it. Access points, NASes, recorders and
// UPSes (ADR-234) have no front panel: a line points to the Wireless or Storage page instead.
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const { t } = useI18n();

const id = computed(() => String(route.params.id ?? ''));
const detail = ref<DeviceDetail | null>(null);
const loading = ref(true);
const error = ref('');
const notFound = ref(false);

async function load() {
  error.value = '';
  try {
    detail.value = await networkApi.device(id.value);
    notFound.value = false;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound.value = true;
    else error.value = err instanceof Error ? err.message : t('netDevice.loadError');
  } finally {
    loading.value = false;
  }
}

const RANGES = [
  { key: '1h', seconds: 3600 },
  { key: '24h', seconds: 86400 },
  { key: '7d', seconds: 7 * 86400 },
] as const;
// The demo answers at most its limit (ADR-122): longer ranges aren't offered there.
const ranges = computed(() => offeredRanges(RANGES, auth.demoMaxRangeS));
const range = ref<number>(86400);

const series = ref<DeviceSeries | null>(null);
const seriesLoading = ref(false);
const seriesFailed = ref(false);
/** A refusal's own words (no Retry), or null for the chart's message with Retry. */
const seriesFailure = ref<{ text: string | null; retry: boolean }>({ text: null, retry: true });
async function loadSeries() {
  seriesLoading.value = true;
  seriesFailed.value = false;
  try {
    series.value = await networkApi.series(id.value, range.value);
  } catch (err) {
    seriesFailed.value = true;
    seriesFailure.value = chartFailure(err);
  } finally {
    seriesLoading.value = false;
  }
}

watch(
  id,
  () => {
    detail.value = null;
    loading.value = true;
    void load();
    void loadSeries();
  },
  { immediate: true },
);
watch(range, () => void loadSeries());

// The page follows the device as it is polled (every 30 s).
const timer = setInterval(() => void load(), 30_000);
onBeforeUnmount(() => clearInterval(timer));

// The picked port: ?port=, else the first one with a neighbour, else the first one up.
const selected = computed<string | null>(() => {
  const ports = detail.value?.ports ?? [];
  const q = typeof route.query.port === 'string' ? route.query.port : null;
  if (q && ports.some((p) => p.name === q)) return q;
  const onPanel = ports.filter((p) => p.kind === 'ethernet' || p.kind === 'sfp');
  return (
    (onPanel.find((p) => p.neighbour) ?? onPanel.find((p) => p.operUp) ?? onPanel[0])?.name ?? null
  );
});
const selectedPort = computed(
  () => detail.value?.ports.find((p) => p.name === selected.value) ?? null,
);
const served = computed(() => servedPorts(detail.value?.endpoints ?? []));
const portEndpoints = computed(() =>
  (detail.value?.endpoints ?? []).filter((e) => e.port === selected.value),
);
function select(name: string) {
  void router.replace({ query: { ...route.query, port: name } });
}

const ELSEWHERE = new Set(['ap', 'nas', 'nvr', 'ups']);
const elsewhere = computed(() => !!detail.value && ELSEWHERE.has(detail.value.device.kind));

const neighbours = computed(() =>
  (detail.value?.ports ?? [])
    .filter((p) => p.neighbour)
    .map((p) => ({ ...p.neighbour!, local: p.name })),
);

const runtimeText = (sec: number) =>
  sec >= 3600
    ? t('netDevice.tiles.hoursMinutes', {
        h: Math.floor(sec / 3600),
        m: Math.round((sec % 3600) / 60),
      })
    : t('netDevice.tiles.minutes', { m: Math.round(sec / 60) });

// Only what the device reports (0.17.1, lib/device-view.ts).
const tiles = computed(() => {
  const d = detail.value;
  if (!d) return [];
  return deviceTiles(d).map((x) => {
    const label = t(`netDevice.tiles.${x.key}`);
    const n = (v: unknown) => (typeof v === 'number' ? v : null);
    switch (x.key) {
      case 'cpu':
      case 'memory':
        return { key: x.key, label, value: pct(n(x.value)), sub: '' };
      case 'temperature':
        return {
          key: x.key,
          label,
          value: `${Math.round(n(x.value) ?? 0)} °C`,
          sub: x.extra != null ? t('netDevice.tiles.limit', { c: x.extra }) : '',
        };
      case 'ports':
        return {
          key: x.key,
          label,
          value: `${x.value} / ${x.of}`,
          sub: t('netDevice.tiles.portsSub'),
        };
      case 'power':
      case 'fans':
        return { key: x.key, label, value: `${x.value} / ${x.of}`, sub: t('netDevice.tiles.ok') };
      case 'poe':
        return {
          key: x.key,
          label,
          value: `${Math.round(n(x.value) ?? 0)} W`,
          sub: t('netDevice.tiles.poeSub'),
        };
      case 'routes':
        return { key: x.key, label, value: String(x.value), sub: String(x.extra ?? '') };
      case 'clients':
        return {
          key: x.key,
          label,
          value: x.value == null ? '–' : String(x.value),
          sub: t('netDevice.tiles.clientsSub'),
        };
      case 'radios':
        return {
          key: x.key,
          label,
          value: x.value == null ? '–' : String(x.value),
          sub: '',
          small: true,
        };
      case 'weak':
        return {
          key: x.key,
          label,
          value: x.value == null ? '–' : String(x.value),
          sub: t('netDevice.tiles.weakSub', { dbm: x.extra ?? -75 }),
        };
      case 'charge':
      case 'load':
        return {
          key: x.key,
          label,
          value: x.value == null ? '–' : `${Math.round(n(x.value) ?? 0)}%`,
          sub: '',
        };
      case 'runtime':
        return {
          key: x.key,
          label,
          value: x.value == null ? '–' : runtimeText(n(x.value) ?? 0),
          sub: '',
        };
      case 'recording':
        return {
          key: x.key,
          label,
          value:
            x.value === true
              ? t('netDevice.tiles.recordingYes')
              : x.value === false
                ? t('netDevice.tiles.recordingNo')
                : t('netDevice.tiles.recordingUnknown'),
          sub: '',
          small: true,
        };
      case 'cameras':
        return {
          key: x.key,
          label,
          value: `${x.value} / ${x.of}`,
          sub: t('netDevice.tiles.camerasSub'),
        };
      case 'daysLeft':
        return {
          key: x.key,
          label,
          value:
            x.value === 'full'
              ? t('netDevice.tiles.full')
              : x.value == null
                ? '–'
                : t('netDevice.tiles.days', { n: Math.floor(n(x.value) ?? 0) }),
          sub: '',
          small: x.value === 'full',
        };
    }
  });
});

const windowOf = computed<[number, number]>(() => {
  const to = Math.floor(Date.now() / 1000);
  return [to - range.value, to];
});
const CHART_UNIT: Record<ChartKey, 'ratio' | 'count' | 'seconds'> = {
  cpu: 'ratio',
  memory: 'ratio',
  temperature: 'count',
  clients: 'count',
  charge: 'ratio',
  load: 'ratio',
  runtime: 'seconds',
  camerasOnline: 'count',
};
const charts = computed(() =>
  detail.value
    ? deviceCharts(detail.value).map((key) => ({
        key,
        title: t(`netDevice.charts.${key}`),
        unit: CHART_UNIT[key],
        series: [{ name: t(`netDevice.charts.${key}`), points: chartPoints(series.value, key) }],
      }))
    : [],
);
</script>

<template>
  <div class="mx-auto flex w-full max-w-[1200px] min-w-0 flex-col gap-4 p-6 max-md:p-4">
    <NetworkTabs />

    <template v-if="loading && !detail">
      <SkeletonDetailHeader :label="$t('common.loading')" />
      <SkeletonChart framed />
    </template>
    <ErrorState v-else-if="notFound" :message="$t('netDevice.notFound')" @retry="load" />
    <ErrorState v-else-if="error && !detail" :message="error" @retry="load" />

    <template v-else-if="detail">
      <DeviceHeader :detail="detail" @changed="load" />

      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 class="text-14 font-semibold text-text">{{ $t('netDevice.now') }}</h3>
        <div
          class="flex gap-0.5 rounded-control border border-border bg-surface-2 p-0.5 text-13"
          role="group"
          :aria-label="$t('netDevice.range')"
        >
          <button
            v-for="r in ranges"
            :key="r.key"
            type="button"
            class="rounded-control px-3 py-1.5 max-lg:min-h-11 max-lg:min-w-11"
            :class="
              range === r.seconds
                ? 'bg-surface-3 font-semibold text-text'
                : 'text-text-muted hover:text-text'
            "
            :aria-pressed="range === r.seconds"
            :data-testid="`device-range-${r.key}`"
            @click="range = r.seconds"
          >
            {{ $t(`netDevice.ranges.${r.key}`) }}
          </button>
        </div>
      </div>

      <div
        class="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3"
        data-testid="device-tiles"
      >
        <div
          v-for="tile in tiles"
          :key="tile.key"
          class="flex flex-col gap-1 rounded-card border border-border bg-surface-1 px-4 py-3"
          :data-testid="`device-tile-${tile.key}`"
        >
          <span class="text-13 text-text-muted">{{ tile.label }}</span>
          <span
            class="text-text tabular"
            :class="'small' in tile && tile.small ? 'text-15 font-medium' : 'font-mono text-20'"
            >{{ tile.value }}</span
          >
          <span class="min-h-4 truncate text-12 text-text-muted">{{ tile.sub }}</span>
        </div>
      </div>

      <DeviceElsewhere v-if="elsewhere" :device="detail.device" />
      <section
        v-else
        class="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-surface-1 p-4"
        aria-labelledby="fp-h"
      >
        <h3 id="fp-h" class="text-14 font-semibold text-text">
          {{ $t('netDevice.panel.title') }}
          <span class="font-normal text-text-muted">· {{ $t('netDevice.panel.sub') }}</span>
        </h3>
        <FrontPanel
          :model="detail.device.model"
          :ports="detail.ports"
          :selected="selected"
          :served="served"
          @select="select"
        />
        <div class="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:items-start">
          <PortDetail
            v-if="selectedPort"
            :device-id="detail.device.id"
            :port="selectedPort"
            :endpoints="portEndpoints"
            :range="range"
          />
          <div class="flex min-w-0 flex-col gap-2">
            <h4 class="text-11 tracking-[0.08em] text-text-subtle uppercase">
              {{ $t('netDevice.panel.neighbours') }}
            </h4>
            <p v-if="!neighbours.length" class="text-13 text-text-muted">
              {{ $t('netDevice.panel.noNeighbours') }}
            </p>
            <RouterLink
              v-for="n in neighbours"
              :key="n.local"
              :to="{ name: 'network-device', params: { id: n.deviceId }, query: { port: n.port } }"
              class="flex items-center gap-2 rounded-control border border-border px-3 py-2 text-13 hover:bg-surface-2 max-lg:min-h-11"
            >
              <span class="font-mono">{{ n.local }}</span>
              <ArrowRight class="size-4 shrink-0 text-text-muted" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-text">{{ n.device }}</span>
              <span class="font-mono text-text-muted">{{ n.port }}</span>
            </RouterLink>
          </div>
        </div>
      </section>

      <PortsTable
        v-if="!elsewhere || detail.ports.length"
        :ports="detail.ports"
        :selected="selected"
        :served="served"
        @select="select"
      />

      <div v-if="charts.length" class="grid gap-4 lg:grid-cols-3" data-testid="device-charts">
        <TimeSeriesChart
          v-for="c in charts"
          :key="c.key"
          :title="c.title"
          :unit="c.unit"
          :series="c.series"
          :window="windowOf"
          :loading="seriesLoading"
          :error="seriesFailed"
          :no-retry="!seriesFailure.retry"
          :empty-text="$t('netDevice.charts.empty')"
          :error-text="seriesFailure.text ?? $t('netDevice.charts.error')"
          :data-testid="`device-chart-${c.key}`"
          @retry="loadSeries"
        />
      </div>

      <DeviceHardware :health="detail.health" />
      <DeviceEvents :events="detail.events" :alerts="detail.alerts" @port="select" />
      <DeviceSettings
        v-if="auth.canManage"
        :key="detail.device.id"
        :device="detail.device"
        @changed="load"
      />
    </template>
  </div>
</template>
