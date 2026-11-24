<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { networkApi, type Wireless } from '../api';
import { dbmText } from '../lib/wireless';
import NetworkTabs from '../components/NetworkTabs.vue';
import ApsTable from '../components/wireless/ApsTable.vue';
import AttentionList from '../components/wireless/AttentionList.vue';
import ClientsTable from '../components/wireless/ClientsTable.vue';
import TrafficChart from '../components/wireless/TrafficChart.vue';

// Network → Wireless (ADR-234): the access points a CAPsMAN controller runs, their clients, the
// mesh links between them and the traffic through them against its usual band. Refreshed
// every 30 s, as the poller polls.
const data = ref<Wireless | null>(null);
const failed = ref(false);
async function load() {
  try {
    data.value = await networkApi.wireless();
    failed.value = false;
  } catch {
    failed.value = true;
  }
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 30_000);
});
onUnmounted(() => clearInterval(timer));

const tiles = computed(() => {
  const w = data.value;
  if (!w) return [];
  const t = w.tiles;
  const down = t.aps - t.apsUp;
  return [
    {
      key: 'aps',
      value: `${t.apsUp} / ${t.aps}`,
      sub: down ? { k: 'apsDown', n: down, v: {} } : { k: 'apsAllUp', n: t.aps, v: {} },
      tone: down ? 'text-critical-text' : 'text-text',
    },
    {
      key: 'clients',
      value: String(t.clients),
      sub: { k: 'clientsSub', n: t.apsUp, v: {} },
      tone: 'text-text',
    },
    {
      key: 'weak',
      value: String(t.weak),
      sub: { k: 'weakSub', n: t.weak, v: { dbm: dbmText(w.weakDbm) } },
      tone: t.weak ? 'text-warning-text' : 'text-text',
    },
    {
      key: 'busiest',
      value: t.busiest?.name ?? '–',
      sub: t.busiest
        ? { k: 'busiestSub', n: t.busiest.clients, v: {} }
        : { k: 'busiestNone', n: 0, v: {} },
      tone: 'text-text',
      to: t.busiest ? { name: 'network-device', params: { id: t.busiest.id } } : undefined,
    },
  ];
});
</script>

<template>
  <div class="flex flex-col gap-5 p-6 max-md:p-4" data-testid="network-wireless">
    <NetworkTabs />
    <ErrorState v-if="failed && !data" :message="$t('net.loadError')" @retry="load" />
    <template v-else-if="!data">
      <div class="grid grid-cols-4 gap-3 max-lg:grid-cols-2">
        <Skeleton v-for="i in 4" :key="i" shape="rect" class="h-24 rounded-card" />
      </div>
      <Skeleton shape="rect" class="h-64 rounded-card" />
    </template>
    <section
      v-else-if="data.aps.length === 0"
      class="rounded-card border border-border bg-surface-1 px-6 py-8 text-center"
      data-testid="wifi-empty"
    >
      <h2 class="text-16 font-semibold text-text">{{ $t('netWifi.empty.title') }}</h2>
      <p class="mt-1 text-14 text-text-muted">{{ $t('netWifi.empty.body') }}</p>
      <RouterLink
        :to="{ name: 'network-add' }"
        class="mt-4 inline-flex h-10 items-center rounded-lg bg-primary px-4 text-14 font-semibold text-on-primary hover:bg-primary-hover max-md:h-11"
        >{{ $t('net.addDevices') }}</RouterLink
      >
    </section>
    <template v-else>
      <div class="grid grid-cols-4 gap-3 max-lg:grid-cols-2" data-testid="wifi-tiles">
        <component
          :is="t.to ? 'RouterLink' : 'div'"
          v-for="t in tiles"
          :key="t.key"
          :to="t.to"
          class="flex min-w-0 flex-col gap-1 rounded-card border border-border bg-surface-1 px-4 py-3"
          :class="t.to ? 'hover:bg-surface-2' : ''"
          :data-testid="`wifi-tile-${t.key}`"
        >
          <span class="font-mono text-11 tracking-[0.1em] text-text-muted uppercase">{{
            $t(`netWifi.tile.${t.key}`)
          }}</span>
          <span
            class="truncate font-mono text-24 font-semibold tabular max-md:text-20"
            :class="t.tone"
            >{{ t.value }}</span
          >
          <span class="text-12 text-text-subtle">{{
            $t(`netWifi.tile.${t.sub.k}`, { n: t.sub.n, ...t.sub.v }, t.sub.n)
          }}</span>
        </component>
      </div>

      <AttentionList
        v-if="data.attention.length"
        :items="data.attention"
        :title="$t('netWifi.attention')"
      />

      <section
        class="overflow-hidden rounded-card border border-border bg-surface-1"
        aria-labelledby="wifi-aps-h"
      >
        <div
          class="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3"
        >
          <h2 id="wifi-aps-h" class="text-14 font-semibold text-text">
            {{ $t('netWifi.aps.title') }}
          </h2>
          <span v-if="data.controllers.length" class="text-12 text-text-subtle">{{
            $t(
              'netWifi.aps.from',
              { names: data.controllers.map((c) => c.name).join(', ') },
              data.controllers.length,
            )
          }}</span>
        </div>
        <ApsTable :aps="data.aps" />
      </section>

      <section
        v-if="data.mesh.length"
        class="rounded-card border border-border bg-surface-1"
        aria-labelledby="wifi-mesh-h"
        data-testid="wifi-mesh"
      >
        <h2
          id="wifi-mesh-h"
          class="border-b border-border px-4 py-3 text-14 font-semibold text-text"
        >
          {{ $t('netWifi.mesh.title') }}
        </h2>
        <ul class="flex flex-col">
          <li
            v-for="m in data.mesh"
            :key="`${m.fromId}-${m.toId}`"
            class="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border px-4 py-2.5 text-13 first:border-t-0"
          >
            <RouterLink
              :to="{ name: 'network-device', params: { id: m.fromId } }"
              class="inline-flex items-center font-mono text-text hover:underline max-md:min-h-11"
              >{{ m.from }}</RouterLink
            >
            <span class="text-text-subtle" aria-hidden="true">⇢</span>
            <span class="sr-only">{{ $t('netWifi.mesh.to') }}</span>
            <RouterLink
              :to="{ name: 'network-device', params: { id: m.toId } }"
              class="inline-flex items-center font-mono text-text hover:underline max-md:min-h-11"
              >{{ m.to }}</RouterLink
            >
            <span v-if="m.signalDbm != null" class="font-mono text-12 text-text-muted"
              >· {{ $t('netWifi.dbm', { n: dbmText(m.signalDbm) }) }}</span
            >
            <span v-if="m.rate" class="font-mono text-12 text-text-muted">· {{ m.rate }}</span>
          </li>
        </ul>
      </section>

      <TrafficChart :traffic="data.traffic" />

      <ClientsTable :clients="data.clients" :weak-dbm="data.weakDbm" />
    </template>
  </div>
</template>
