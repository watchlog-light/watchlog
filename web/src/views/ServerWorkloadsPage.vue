<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
import { Boxes } from '@lucide/vue';
import type { ServerList } from '@watchlog/api-types';
import { storeToRefs } from 'pinia';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api/client';
import ServerWorkloadList from '@/components/servers/ServerWorkloadList.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorState from '@/components/ui/ErrorState.vue';
import LoadingIndicator from '@/components/ui/LoadingIndicator.vue';
import SearchField from '@/components/ui/SearchField.vue';
import SkeletonTable from '@/components/ui/SkeletonTable.vue';
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue';
import { useLoader } from '@/composables/useLoader';
import { usePolling } from '@/composables/usePolling';
import { buildTree, type Source } from '@/lib/server-workloads';
import { RANGE_SECONDS } from '@/lib/time';
import { useFleetStore } from '@/stores/fleet';
import { useUiStore } from '@/stores/ui';

// A Server fleet's Workloads (ADR-207, at the Kubernetes page's level, ADR-124): by server,
// services with their process groups, pm2's apps under pm2, containers under their Compose
// project. Chips by source and Failing, a name filter, and "Hide system" on by default (the
// OS's own and WatchLog's own, with how many it hid). The URL keeps every filter.
const REFRESH_MS = 30_000;
const route = useRoute();
const router = useRouter();
const fleetStore = useFleetStore();
const { timeRange } = storeToRefs(useUiStore());
const range = computed(() => Math.max(300, RANGE_SECONDS[timeRange.value]));
const page = useLoader(async () => {
  const f = fleetStore.fleet ?? (await fleetStore.load());
  if (!f) return undefined;
  return api<ServerList>(`/clusters/${f.id}/servers?workloads=1&range=${range.value}`);
});
watch(range, () => void page.load());

const SOURCES: Source[] = ['service', 'process', 'container'];
const source = computed<Source | 'all'>(() => {
  const s = route.query.source;
  return s === 'service' || s === 'process' || s === 'container' ? s : 'all';
});
const failing = computed(() => route.query.failing === '1');
const showSystem = computed(() => route.query.system === 'show');
const setQuery = (q: Record<string, string | undefined>) =>
  void router.replace({ query: { ...route.query, ...q } });
const toggleSource = (s: Source) => setQuery({ source: source.value === s ? undefined : s });
const q = ref(typeof route.query.q === 'string' ? route.query.q : '');
watch(q, (v) => setQuery({ q: v || undefined }));

const tree = computed(() =>
  buildTree(page.data.value?.workloads ?? [], {
    showSystem: showSystem.value,
    source: source.value,
    failing: failing.value,
    term: q.value,
  }),
);
const terms = computed(() => (q.value.trim() ? [q.value.trim()] : []));

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
    <div class="flex flex-wrap items-center gap-3">
      <SearchField
        v-model="q"
        class="min-w-48"
        :label="$t('servers.fleetWorkloads.search')"
        :placeholder="$t('servers.fleetWorkloads.search')"
        @clear="q = ''"
      />
      <LoadingIndicator :active="page.refreshing.value" />
      <span class="flex-1" />
      <span
        v-if="!showSystem && tree.hiddenSystem"
        class="text-12 text-text-subtle"
        data-testid="hidden-system"
        >{{
          $t('servers.fleetWorkloads.hiddenSystem', { n: tree.hiddenSystem }, tree.hiddenSystem)
        }}</span
      >
      <ToggleSwitch
        :model-value="!showSystem"
        data-testid="hide-system"
        @update:model-value="(v: boolean) => setQuery({ system: v ? undefined : 'show' })"
        >{{ $t('servers.fleetWorkloads.hideSystem') }}</ToggleSwitch
      >
    </div>
    <div class="flex flex-wrap items-center gap-2" data-testid="chips">
      <button
        v-for="s in SOURCES"
        :key="s"
        type="button"
        class="chip"
        :class="{ on: source === s }"
        :aria-pressed="source === s"
        :data-testid="`chip-${s}`"
        @click="toggleSource(s)"
      >
        {{ $t(`servers.fleetWorkloads.chips.${s}`) }}
        <span class="n">{{ tree.counts[s] }}</span>
      </button>
      <button
        type="button"
        class="chip"
        :class="{ on: failing, crit: tree.counts.failing > 0 }"
        :aria-pressed="failing"
        data-testid="chip-failing"
        @click="setQuery({ failing: failing ? undefined : '1' })"
      >
        {{ $t('servers.fleetWorkloads.chips.failing') }}
        <span class="n">{{ tree.counts.failing }}</span>
      </button>
      <RouterLink
        :to="{ name: 'containers' }"
        class="ml-auto text-12 text-text-muted hover:text-text hover:underline max-lg:min-h-11"
        >{{ $t('servers.fleetWorkloads.containersPage') }}</RouterLink
      >
    </div>
    <SkeletonTable v-if="page.skeleton.value" :label="$t('common.loading')" />
    <EmptyState
      v-else-if="page.loaded.value && !tree.servers.length"
      :icon="Boxes"
      :title="
        q || failing || source !== 'all'
          ? $t('servers.fleetWorkloads.noMatch')
          : $t('servers.fleetWorkloads.emptyTitle')
      "
      :description="
        q || failing || source !== 'all'
          ? $t('servers.fleetWorkloads.noMatchHint')
          : $t('servers.fleetWorkloads.empty')
      "
      data-testid="workloads-empty"
    />
    <ServerWorkloadList v-else-if="tree.servers.length" :servers="tree.servers" :terms="terms" />
  </div>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: 12px;
}
.chip:hover {
  color: var(--text);
}
.chip.on {
  border-color: color-mix(in srgb, var(--primary) 50%, transparent);
  background: var(--primary-soft);
  color: var(--text);
}
.chip .n {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
  color: var(--text-subtle);
}
.chip.crit .n {
  color: var(--critical);
}
@media (max-width: 1023px) {
  .chip {
    min-height: 44px;
  }
}
</style>
