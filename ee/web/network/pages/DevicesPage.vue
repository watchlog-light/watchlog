<!-- SPDX-License-Identifier: LicenseRef-WatchLog-Enterprise -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ComboBox from '@/components/ui/ComboBox.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { networkApi, type Device } from '../api';
import DevicesTable from '../components/DevicesTable.vue';
import NetworkTabs from '../components/NetworkTabs.vue';

// Every device (ADR-233), filtered by kind, status and the place that polls it; the filters
// live in the address, so a filtered list can be shared.
const route = useRoute();
const router = useRouter();
const devices = ref<Device[] | null>(null);
const failed = ref(false);
async function load() {
  try {
    devices.value = (await networkApi.devices()).devices;
    failed.value = false;
  } catch {
    failed.value = true;
  }
}
onMounted(load);

const q = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : '');
const set = (k: string, v: string) =>
  void router.replace({ query: { ...route.query, [k]: v || undefined } });
const statusOf = (d: Device) =>
  d.status === 'ok'
    ? d.openAlerts
      ? 'warning'
      : 'ok'
    : d.status === 'pending'
      ? 'pending'
      : 'down';
const pollerOf = (d: Device) => `${d.poller.clusterId}/${d.poller.host}`;
const kinds = computed(() => [...new Set((devices.value ?? []).map((d) => d.kind))].sort());
const pollers = computed(() => {
  const m = new Map<string, string>();
  for (const d of devices.value ?? [])
    m.set(pollerOf(d), d.poller.host ? `${d.poller.name} › ${d.poller.host}` : d.poller.name);
  return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
});
const shown = computed(() =>
  (devices.value ?? []).filter(
    (d) =>
      (!q('kind') || d.kind === q('kind')) &&
      (!q('status') || statusOf(d) === q('status')) &&
      (!q('poller') || pollerOf(d) === q('poller')) &&
      (!q('q') || `${d.name} ${d.address} ${d.model}`.toLowerCase().includes(q('q').toLowerCase())),
  ),
);
/** The "All …" choice of a filter (an empty value reads as no choice at all). */
const ALL = '__all__';
const pick = (key: string, v: string | string[] | null) =>
  set(key, typeof v === 'string' && v !== ALL ? v : '');
</script>

<template>
  <div class="flex flex-col gap-4 p-6 max-md:p-4" data-testid="network-devices">
    <NetworkTabs :devices="devices?.length ?? null" />
    <div class="flex flex-wrap items-center gap-2" data-testid="network-device-filters">
      <input
        :value="q('q')"
        type="search"
        :placeholder="$t('net.devices.search')"
        :aria-label="$t('net.devices.search')"
        class="h-9 w-64 rounded-lg border border-border bg-surface-1 px-3 text-13 text-text max-md:h-11 max-md:w-full"
        @input="set('q', ($event.target as HTMLInputElement).value)"
      />
      <ComboBox
        class="w-44 max-md:w-full"
        variant="toolbar"
        :model-value="q('kind') || ALL"
        :options="[
          { value: ALL, label: $t('net.devices.allKinds') },
          ...kinds.map((k) => ({ value: k, label: $t(`net.kind.${k}`) })),
        ]"
        :label="$t('net.devices.kind')"
        testid="filter-kind"
        @update:model-value="(v) => pick('kind', v)"
      />
      <ComboBox
        class="w-44 max-md:w-full"
        variant="toolbar"
        :model-value="q('status') || ALL"
        :options="[
          { value: ALL, label: $t('net.devices.allStatuses') },
          ...['ok', 'warning', 'down', 'pending'].map((s) => ({
            value: s,
            label: $t(`net.devices.statusFilter.${s}`),
          })),
        ]"
        :label="$t('net.devices.status')"
        testid="filter-status"
        @update:model-value="(v) => pick('status', v)"
      />
      <ComboBox
        class="w-52 max-md:w-full"
        variant="toolbar"
        :model-value="q('poller') || ALL"
        :options="[
          { value: ALL, label: $t('net.devices.allPollers') },
          ...pollers.map(([k, label]) => ({ value: k, label })),
        ]"
        :label="$t('net.devices.poller')"
        testid="filter-poller"
        @update:model-value="(v) => pick('poller', v)"
      />
    </div>
    <ErrorState v-if="failed && !devices" :message="$t('net.loadError')" @retry="load" />
    <SkeletonTable v-else-if="!devices" :label="$t('common.loading')" />
    <section v-else class="overflow-hidden rounded-card border border-border bg-surface-1">
      <DevicesTable :devices="shown" />
    </section>
  </div>
</template>
