<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import type { ServerList } from '@watchlog/api-types';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api/client';
import TonePill from '@/components/kube/TonePill.vue';
import SourceChip from '@/components/servers/SourceChip.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import SearchField from '@/components/ui/SearchField.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import { useLoader } from '@/composables/useLoader';
import { usePolling } from '@/composables/usePolling';
import { formatCores } from '@/lib/resources';
import { portsText, workloadLink, type Source } from '@/lib/servers';
import { formatBytes } from '@/lib/units';
import { useFleetStore } from '@/stores/fleet';

// A Server fleet's workloads (ADR-207): every service, process group and container on its
// servers, problems first; ?source= filters (the 0.8 Containers page is ?source=container).
const REFRESH_MS = 30_000;
const route = useRoute();
const router = useRouter();
const fleetStore = useFleetStore();
const page = useLoader(async () => {
  const f = fleetStore.fleet ?? (await fleetStore.load());
  if (!f) return undefined;
  return api<ServerList>(`/clusters/${f.id}/servers?workloads=1`);
});
const FILTERS = ['all', 'service', 'process', 'container'] as const;
const source = computed<'all' | Source>(() => {
  const s = route.query.source;
  return s === 'service' || s === 'process' || s === 'container' ? s : 'all';
});
const setSource = (s: (typeof FILTERS)[number]) =>
  void router.replace({ query: { ...route.query, source: s === 'all' ? undefined : s } });
const q = ref(typeof route.query.q === 'string' ? route.query.q : '');
const rows = computed(() => {
  const term = q.value.trim().toLowerCase();
  return (page.data.value?.workloads ?? []).filter(
    (w) =>
      !w.system &&
      (source.value === 'all' || w.source === source.value) &&
      (!term || w.name.toLowerCase().includes(term) || w.server.toLowerCase().includes(term)),
  );
});

const poll = usePolling(() => page.load(), REFRESH_MS);
onMounted(() => {
  void page.load();
  poll.start();
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <ErrorState
      v-if="page.error.value"
      :inline="page.loaded.value"
      :message="$t('servers.errors.load')"
      :retrying="page.loading.value"
      @retry="page.load"
    />
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="flex items-center gap-2 text-13 text-text-muted">
        {{ $t('servers.fleetWorkloads.intro') }}
        <LoadingIndicator :active="page.refreshing.value" />
      </p>
      <RouterLink
        :to="{ name: 'containers' }"
        class="text-13 text-text-muted hover:text-text hover:underline"
      >
        {{ $t('servers.fleetWorkloads.containersPage') }}
      </RouterLink>
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <div class="min-w-[220px] flex-1">
        <SearchField
          v-model="q"
          :label="$t('servers.fleetWorkloads.search')"
          :placeholder="$t('servers.fleetWorkloads.search')"
          @clear="q = ''"
        />
      </div>
      <div class="flex flex-wrap gap-1" role="group">
        <button
          v-for="f in FILTERS"
          :key="f"
          type="button"
          class="rounded-control px-2.5 py-1 text-12 max-lg:min-h-11"
          :class="source === f ? 'bg-surface-3 text-text' : 'text-text-muted hover:text-text'"
          :aria-pressed="source === f"
          @click="setSource(f)"
        >
          {{ $t(`servers.filter.${f}`) }}
        </button>
      </div>
    </div>
    <SkeletonTable v-if="page.skeleton.value" :label="$t('common.loading')" />
    <div
      v-else
      class="overflow-x-auto rounded-card border border-border bg-surface-1 max-lg:hidden"
    >
      <table class="w-full min-w-[760px] text-left text-13" data-testid="fleet-workloads">
        <thead class="text-11 tracking-[0.08em] text-text-muted uppercase">
          <tr>
            <th class="px-4 py-2.5 font-normal">{{ $t('servers.columns.workload') }}</th>
            <th class="px-4 py-2.5 font-normal">{{ $t('servers.columns.onServer') }}</th>
            <th class="px-4 py-2.5 font-normal">{{ $t('servers.columns.kind') }}</th>
            <th class="px-4 py-2.5 font-normal">{{ $t('servers.columns.state') }}</th>
            <th class="px-4 py-2.5 text-right font-normal">{{ $t('servers.columns.cpu') }}</th>
            <th class="px-4 py-2.5 text-right font-normal">{{ $t('servers.columns.memory') }}</th>
            <th class="px-4 py-2.5 font-normal">{{ $t('servers.columns.listens') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="w in rows"
            :key="`${w.server}/${w.id}`"
            class="border-t border-border"
            data-testid="fleet-workload-row"
          >
            <td class="px-4 py-2.5">
              <RouterLink
                :to="workloadLink(w.server, w)"
                class="font-mono text-text hover:underline"
                >{{ w.name }}</RouterLink
              >
              <span v-if="w.unit" class="ml-1.5 font-mono text-12 text-text-subtle">{{
                w.unit
              }}</span>
            </td>
            <td class="px-4 py-2.5">
              <RouterLink
                :to="{ name: 'server', params: { server: w.server } }"
                class="text-text-muted hover:text-text hover:underline"
                >{{ w.server }}</RouterLink
              >
            </td>
            <td class="px-4 py-2.5">
              <SourceChip :source="w.source" :label="$t(`servers.source.${w.source}`)" />
            </td>
            <td class="px-4 py-2.5">
              <TonePill
                v-if="w.problem"
                :tone="w.problem.severity"
                :label="$t(`servers.problem.${w.problem.kind}`)"
              />
              <span v-else class="text-text-muted">{{
                w.source === 'process'
                  ? $t('servers.instances', { n: w.instances ?? 0 }, w.instances ?? 0)
                  : w.state
              }}</span>
            </td>
            <td class="px-4 py-2.5 text-right font-mono text-12 tabular">
              {{ w.cpuCores == null ? '–' : formatCores(w.cpuCores) }}
            </td>
            <td class="px-4 py-2.5 text-right font-mono text-12 tabular">
              {{ w.memoryBytes == null ? '–' : formatBytes(w.memoryBytes) }}
            </td>
            <td class="px-4 py-2.5 font-mono text-12 text-text-muted">{{ portsText(w.ports) }}</td>
          </tr>
          <tr v-if="rows.length === 0 && page.loaded.value">
            <td colspan="7" class="px-4 py-4 text-13 text-text-muted">
              {{ $t('servers.noWorkloads') }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <ul
      v-if="!page.skeleton.value"
      class="divide-y divide-border rounded-card border border-border bg-surface-1 lg:hidden"
      data-testid="fleet-workload-cards"
    >
      <li v-for="w in rows" :key="`${w.server}/${w.id}`" class="flex flex-col gap-1.5 px-4 py-3">
        <div class="flex items-center justify-between gap-2">
          <RouterLink
            :to="workloadLink(w.server, w)"
            class="min-h-11 content-center truncate font-mono text-13 text-text hover:underline"
            >{{ w.name }}</RouterLink
          >
          <SourceChip :source="w.source" :label="$t(`servers.source.${w.source}`)" />
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-text-muted">
          <span>{{ w.server }}</span>
          <TonePill
            v-if="w.problem"
            :tone="w.problem.severity"
            :label="$t(`servers.problem.${w.problem.kind}`)"
          />
          <span class="font-mono tabular">{{
            w.cpuCores == null ? '–' : formatCores(w.cpuCores)
          }}</span>
          <span class="font-mono tabular">{{
            w.memoryBytes == null ? '–' : formatBytes(w.memoryBytes)
          }}</span>
        </div>
      </li>
      <li v-if="rows.length === 0 && page.loaded.value" class="px-4 py-4 text-13 text-text-muted">
        {{ $t('servers.noWorkloads') }}
      </li>
    </ul>
  </div>
</template>
