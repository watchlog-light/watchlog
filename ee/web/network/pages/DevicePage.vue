<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { ArrowRight } from '@lucide/vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import TimeSeriesChart, { type ChartSeries } from '@/components/charts/TimeSeriesChart.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SkeletonChart from '@/components/ui/SkeletonChart.vue';
import SkeletonDetailHeader from '@/components/ui/SkeletonDetailHeader.vue';
import { ApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { networkApi, type DeviceDetail, type DeviceSeries } from '../api';
import DeviceEvents from '../components/device/DeviceEvents.vue';
import DeviceHardware from '../components/device/DeviceHardware.vue';
import DeviceHeader from '../components/device/DeviceHeader.vue';
import DeviceSettings from '../components/device/DeviceSettings.vue';
import FrontPanel from '../components/device/FrontPanel.vue';
import PortDetail from '../components/device/PortDetail.vue';
import PortsTable from '../components/device/PortsTable.vue';
import NetworkTabs from '../components/NetworkTabs.vue';
import { pct } from '../lib/format';
import { healthTone, servedPorts } from '../lib/front-panel';

// A network device (ADR-233): its facts, its ports as on its front, the picked port's traffic and
// what is on its other end, CPU, memory and temperature, its hardware, events and alerts; and
// for Owners and Admins, renaming, moving and removing it.
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
  { key: '1h', s: 3600 },
  { key: '24h', s: 86400 },
  { key: '7d', s: 7 * 86400 },
] as const;
const range = ref<number>(86400);

const series = ref<DeviceSeries | null>(null);
const seriesLoading = ref(false);
const seriesFailed = ref(false);
async function loadSeries() {
  seriesLoading.value = true;
  seriesFailed.value = false;
  try {
    series.value = await networkApi.series(id.value, range.value);
  } catch {
    seriesFailed.value = true;
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

const neighbours = computed(() =>
  (detail.value?.ports ?? [])
    .filter((p) => p.neighbour)
    .map((p) => ({ ...p.neighbour!, local: p.name })),
);

const tiles = computed(() => {
  const d = detail.value;
  if (!d) return [];
  const hot = d.health.sensors.find((s) => s.threshold != null);
  const okCount = (xs: { state: string }[]) =>
    xs.filter((x) => healthTone(x.state) === 'ok').length;
  const poe = d.ports.reduce((n, p) => n + (p.poeWatts ?? 0), 0);
  const out = [
    { label: t('netDevice.tiles.cpu'), value: pct(d.device.cpu), sub: '' },
    { label: t('netDevice.tiles.memory'), value: pct(d.device.memory), sub: '' },
    {
      label: t('netDevice.tiles.temperature'),
      value: d.device.temperature == null ? '–' : `${Math.round(d.device.temperature)} °C`,
      sub: hot?.threshold != null ? t('netDevice.tiles.limit', { c: hot.threshold }) : '',
    },
    {
      label: t('netDevice.tiles.ports'),
      value:
        d.device.portsTotal == null ? '–' : `${d.device.portsUp ?? 0} / ${d.device.portsTotal}`,
      sub: t('netDevice.tiles.portsSub'),
    },
  ];
  if (d.health.psus.length) {
    out.push({
      label: t('netDevice.tiles.power'),
      value: `${okCount(d.health.psus)} / ${d.health.psus.length}`,
      sub: t('netDevice.tiles.ok'),
    });
  }
  if (d.health.fans.length) {
    out.push({
      label: t('netDevice.tiles.fans'),
      value: `${okCount(d.health.fans)} / ${d.health.fans.length}`,
      sub: t('netDevice.tiles.ok'),
    });
  }
  if (poe > 0)
    out.push({
      label: t('netDevice.tiles.poe'),
      value: `${Math.round(poe)} W`,
      sub: t('netDevice.tiles.poeSub'),
    });
  if (d.device.routes != null)
    out.push({
      label: t('netDevice.tiles.routes'),
      value: String(d.device.routes),
      sub: d.device.gateway ?? '',
    });
  return out;
});

const windowOf = computed<[number, number]>(() => {
  const to = Math.floor(Date.now() / 1000);
  return [to - range.value, to];
});
const charts = computed(() => {
  const s = series.value;
  const one = (name: string, pts: DeviceSeries['cpu'] | undefined): ChartSeries[] => [
    { name, points: pts ?? [] },
  ];
  return [
    {
      key: 'cpu',
      title: t('netDevice.charts.cpu'),
      unit: 'ratio' as const,
      series: one(t('netDevice.charts.cpu'), s?.cpu),
    },
    {
      key: 'mem',
      title: t('netDevice.charts.memory'),
      unit: 'ratio' as const,
      series: one(t('netDevice.charts.memory'), s?.memory),
    },
    {
      key: 'temp',
      title: t('netDevice.charts.temperature'),
      unit: 'count' as const,
      series: one(t('netDevice.charts.temperature'), s?.temperature),
    },
  ];
});
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
            v-for="r in RANGES"
            :key="r.key"
            type="button"
            class="rounded-control px-3 py-1.5 max-lg:min-h-11 max-lg:min-w-11"
            :class="
              range === r.s
                ? 'bg-surface-3 font-semibold text-text'
                : 'text-text-muted hover:text-text'
            "
            :aria-pressed="range === r.s"
            @click="range = r.s"
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
          :key="tile.label"
          class="flex flex-col gap-1 rounded-card border border-border bg-surface-1 px-4 py-3"
        >
          <span class="text-13 text-text-muted">{{ tile.label }}</span>
          <span class="font-mono text-20 text-text tabular">{{ tile.value }}</span>
          <span class="min-h-4 truncate text-12 text-text-muted">{{ tile.sub }}</span>
        </div>
      </div>

      <section
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

      <PortsTable :ports="detail.ports" :selected="selected" :served="served" @select="select" />

      <div class="grid gap-4 lg:grid-cols-3">
        <TimeSeriesChart
          v-for="c in charts"
          :key="c.key"
          :title="c.title"
          :unit="c.unit"
          :series="c.series"
          :window="windowOf"
          :loading="seriesLoading"
          :error="seriesFailed"
          :empty-text="$t('netDevice.charts.empty')"
          :error-text="$t('netDevice.charts.error')"
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
