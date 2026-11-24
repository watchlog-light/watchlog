<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { networkApi, type MapData, type Summary } from '../api';
import DevicesTable from '../components/DevicesTable.vue';
import NetworkMap from '../components/NetworkMap.vue';
import NetworkTabs from '../components/NetworkTabs.vue';

// The network's Overview (ADR-233, Main board): tiles, the map smaller, what needs attention,
// and every device. Refreshed every minute, as the poller polls.
const summary = ref<Summary | null>(null);
const map = ref<MapData | null>(null);
const failed = ref(false);
async function load() {
  try {
    const [s, m] = await Promise.all([networkApi.summary(), networkApi.map()]);
    summary.value = s;
    map.value = m;
    failed.value = false;
  } catch {
    failed.value = true;
  }
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 60_000);
});
onUnmounted(() => clearInterval(timer));

const tiles = computed(() => {
  const t = summary.value?.tiles;
  if (!t) return [];
  return [
    {
      key: 'devices',
      value: `${t.up} / ${t.devices}`,
      sub: t.down ? 'downSub' : t.pending ? 'pendingSub' : 'allUp',
      n: t.down || t.pending,
      tone: t.down ? 'text-critical-text' : 'text-text',
      to: { name: 'network-devices' },
    },
    {
      key: 'ports',
      value: String(t.portsWithProblems),
      sub: t.portsWithProblems ? 'portsSub' : 'portsNone',
      n: t.portsWithProblems,
      tone: t.portsWithProblems ? 'text-warning-text' : 'text-text',
      to: { name: 'network-devices' },
    },
    {
      key: 'busy',
      value: String(t.busyLinks),
      sub: 'busySub',
      n: t.links,
      tone: t.busyLinks ? 'text-warning-text' : 'text-text',
      to: { name: 'network-map' },
    },
    {
      key: 'firmware',
      value: t.oldestFirmware?.firmware ?? '–',
      sub: t.oldestFirmware ? 'firmwareSub' : 'firmwareNone',
      name: t.oldestFirmware?.name,
      n: 0,
      tone: 'text-text',
      to: t.oldestFirmware
        ? { name: 'network-device', params: { id: t.oldestFirmware.deviceId } }
        : { name: 'network-devices' },
    },
  ];
});

const SEV: Record<string, string> = {
  critical: 'border-critical/50 text-critical-text',
  warning: 'border-warning/50 text-warning-text',
};
function age(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}
const pollers = computed(() => [
  ...new Set((summary.value?.devices ?? []).map((d) => d.poller.host || d.poller.name)),
]);
</script>

<template>
  <div class="flex flex-col gap-5 p-6 max-md:p-4" data-testid="network-overview">
    <NetworkTabs :devices="summary?.devices.length ?? null" />
    <ErrorState v-if="failed && !summary" :message="$t('net.loadError')" @retry="load" />
    <template v-else-if="!summary">
      <div class="grid grid-cols-4 gap-3 max-lg:grid-cols-2">
        <Skeleton v-for="i in 4" :key="i" class="h-24 rounded-card" />
      </div>
      <Skeleton class="h-80 rounded-card" />
    </template>
    <template v-else>
      <p
        v-if="summary.devices.length"
        class="text-13 text-text-muted"
        data-testid="network-polling"
      >
        {{
          $t(
            'net.overview.polling',
            { n: summary.devices.length, from: pollers.join(', ') },
            summary.devices.length,
          )
        }}
      </p>
      <section
        v-if="summary.devices.length === 0"
        class="rounded-card border border-border bg-surface-1 px-6 py-8 text-center"
        data-testid="network-empty"
      >
        <h2 class="text-16 font-semibold text-text">{{ $t('net.overview.emptyTitle') }}</h2>
        <p class="mt-1 text-14 text-text-muted">{{ $t('net.overview.emptyBody') }}</p>
        <RouterLink
          :to="{ name: 'network-add' }"
          class="mt-4 inline-flex h-10 items-center rounded-lg bg-primary px-4 text-14 font-semibold text-on-primary hover:bg-primary-hover"
          >{{ $t('net.addDevices') }}</RouterLink
        >
      </section>
      <template v-else>
        <div class="grid grid-cols-4 gap-3 max-lg:grid-cols-2" data-testid="network-tiles">
          <RouterLink
            v-for="t in tiles"
            :key="t.key"
            :to="t.to"
            class="flex flex-col gap-1 rounded-card border border-border bg-surface-1 px-4 py-3 hover:bg-surface-2"
            :data-testid="`network-tile-${t.key}`"
          >
            <span class="font-mono text-11 tracking-[0.1em] text-text-muted uppercase">{{
              $t(`net.overview.tile.${t.key}`)
            }}</span>
            <span class="font-mono text-24 font-semibold tabular max-md:text-20" :class="t.tone">{{
              t.value
            }}</span>
            <span class="text-12 text-text-subtle">{{
              $t(`net.overview.tile.${t.sub}`, { n: t.n, name: t.name ?? '' }, t.n)
            }}</span>
          </RouterLink>
        </div>

        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="text-16 font-semibold text-text">
            {{ $t('net.overview.mapTitle') }}
            <span class="text-13 font-normal text-text-muted">{{
              $t('net.overview.mapHint')
            }}</span>
          </h2>
          <RouterLink
            :to="{ name: 'network-map' }"
            class="text-13 font-semibold text-link hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center"
            >{{ $t('net.overview.openMap') }}</RouterLink
          >
        </div>
        <NetworkMap v-if="map" :data="map" compact />

        <section
          class="rounded-card border border-border bg-surface-1"
          aria-labelledby="net-attention"
          data-testid="network-attention"
        >
          <div class="flex items-center gap-2 border-b border-border px-4 py-3">
            <h2 id="net-attention" class="text-14 font-semibold text-text">
              {{ $t('net.overview.attention') }}
            </h2>
            <span class="rounded-full bg-surface-2 px-1.5 text-12 text-text-muted tabular">{{
              summary.attention.length
            }}</span>
          </div>
          <p v-if="!summary.attention.length" class="px-4 py-4 text-13 text-text-muted">
            {{ $t('net.overview.allGood') }}
          </p>
          <RouterLink
            v-for="a in summary.attention"
            :key="a.alertId"
            :to="{
              name: 'network-device',
              params: { id: a.deviceId },
              query: a.port ? { port: a.port } : {},
            }"
            class="grid grid-cols-[88px_1fr_auto] items-center gap-3 border-t border-border px-4 py-2.5 first:border-t-0 hover:bg-surface-2"
            data-testid="network-attention-row"
          >
            <span>
              <span
                class="inline-flex h-5 items-center rounded-full border px-2 text-11 font-semibold uppercase"
                :class="SEV[a.severity]"
                >{{ $t(`net.severity.${a.severity}`) }}</span
              >
            </span>
            <span class="flex min-w-0 flex-col">
              <span class="truncate text-13 font-medium text-text">{{ a.what }}</span>
              <span class="truncate text-12 text-text-muted">{{
                a.why ? `${a.where} · ${a.why}` : a.where
              }}</span>
            </span>
            <span class="font-mono text-12 text-text-subtle" :title="a.since">{{
              age(a.since)
            }}</span>
          </RouterLink>
        </section>

        <section
          class="overflow-hidden rounded-card border border-border bg-surface-1"
          aria-labelledby="net-devices"
        >
          <div
            class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3"
          >
            <h2 id="net-devices" class="text-14 font-semibold text-text">
              {{ $t('net.tabs.devices') }}
            </h2>
            <span class="text-12 text-text-subtle">{{ $t('net.overview.anySnmp') }}</span>
          </div>
          <DevicesTable :devices="summary.devices" />
        </section>
      </template>
    </template>
  </div>
</template>
